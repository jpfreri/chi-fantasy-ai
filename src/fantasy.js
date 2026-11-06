const { one, all, run, tx } = require('./db');
const { scoreLine, defaultScoring } = require('./sports');

const EPOCH = '1970-01-01T00:00:00.000Z';

// The fantasy multiplier for a stat line: the multiplier of the team the player played for in that
// game. That is their own team if it is in the game, otherwise the club side of the game.
function lineMultiplier(r) {
  if (r.im_team_id === r.home_team_id && r.home_mult != null) return r.home_mult;
  if (r.im_team_id === r.away_team_id && r.away_mult != null) return r.away_mult;
  if (r.home_club) return r.home_mult;
  if (r.away_club) return r.away_mult;
  return 1;
}

const STAT_LINE_SQL = `
  SELECT gs.game_id, gs.athlete_id, gs.stats, g.starts_at, g.week, g.status, g.home_team_id, g.away_team_id,
         a.im_team_id, h.multiplier AS home_mult, h.is_club AS home_club, aw.multiplier AS away_mult, aw.is_club AS away_club
    FROM game_stats gs JOIN games g ON g.id = gs.game_id JOIN athletes a ON a.id = gs.athlete_id
    LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams aw ON aw.id = g.away_team_id`;

function toLine(r) {
  return { ...r, stats: JSON.parse(r.stats), mult: lineMultiplier(r) };
}

// Fantasy points for a stat line, after the team multiplier.
function linePoints(line, scoring) {
  return Math.round(scoreLine(line.stats, scoring) * line.mult * 100) / 100;
}

// Every stat line from games that are live or final in a sport.
function sportStatLines(sport) {
  return all(`${STAT_LINE_SQL} WHERE g.sport = ? AND g.status IN ('live', 'final')`, sport).map(toLine);
}

function statLinesFor(where, ...params) {
  return all(`${STAT_LINE_SQL} WHERE ${where}`, ...params).map(toLine);
}

// Season fantasy points per athlete id under a scoring config.
function athleteTotals(sport, scoring = defaultScoring(sport)) {
  const totals = {};
  for (const line of sportStatLines(sport)) {
    const t = (totals[line.athlete_id] ||= { points: 0, games: 0 });
    t.points += linePoints(line, scoring);
    t.games += 1;
  }
  for (const t of Object.values(totals)) t.points = Math.round(t.points * 100) / 100;
  return totals;
}

function athletesWithPoints(sport, scoring) {
  const totals = athleteTotals(sport, scoring);
  return all(
    `SELECT a.id, a.name, a.position, a.active, a.im_team_id, t.name AS team_name, t.is_club
       FROM athletes a LEFT JOIN im_teams t ON t.id = a.im_team_id
      WHERE a.sport = ? ORDER BY a.name`,
    sport
  ).map((a) => ({ ...a, points: totals[a.id]?.points || 0, games: totals[a.id]?.games || 0 }));
}

function getLeague(id) {
  const league = one('SELECT * FROM leagues WHERE id = ?', id);
  if (league) league.scoring = JSON.parse(league.scoring);
  return league;
}

function leagueTeams(leagueId) {
  return all(
    `SELECT lt.id, lt.league_id, lt.user_id, lt.name, lt.draft_slot, u.display_name AS owner_name, u.username
       FROM league_teams lt JOIN users u ON u.id = lt.user_id
      WHERE lt.league_id = ? ORDER BY COALESCE(lt.draft_slot, 999), lt.id`,
    leagueId
  );
}

// ---------- Rounds ----------

const TZ = 'America/Chicago';
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const CLUB_GAMES_SQL = `
  SELECT g.id, g.week, g.starts_at, g.status, g.home_team_id, g.away_team_id, h.name AS home_name, aw.name AS away_name,
         h.is_club AS home_club, aw.is_club AS away_club
    FROM games g LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams aw ON aw.id = g.away_team_id
   WHERE g.sport = ?`;

const roundState = (games) => {
  const final = games.filter((g) => g.status === 'final').length;
  const started = games.filter((g) => g.status !== 'scheduled').length;
  return final === games.length ? 'final' : started ? 'live' : 'upcoming';
};

// Fantasy rounds for a league. With round_by 'game', every day Chi plays is a round (all the Chi games
// that day count, so players on Chi A, B and C all score). With 'week', round N is intramural week N.
// Returns byGame (game id -> round) and list (round -> state, game count, first game and the Chi games).
function rounds(league) {
  const games = all(`${CLUB_GAMES_SQL} ORDER BY g.starts_at, g.id`, league.sport);
  const groups = new Map();
  for (const g of games) {
    const club = g.home_club || g.away_club;
    if (league.round_by === 'week') {
      if (!groups.has(g.week)) groups.set(g.week, []);
      groups.get(g.week).push(g);
    } else if (club && g.starts_at) {
      const k = dayKey(g.starts_at);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(g);
    }
  }
  const keys = league.round_by === 'week' ? [...groups.keys()].sort((a, b) => a - b) : [...groups.keys()];
  const byGame = {};
  const list = {};
  keys.forEach((k, i) => {
    const n = league.round_by === 'week' ? k : i + 1;
    const gs = groups.get(k);
    for (const g of gs) byGame[g.id] = n;
    list[n] = {
      games: gs.length, state: roundState(gs), first_game: gs.find((g) => g.starts_at)?.starts_at || null,
      final: gs.filter((g) => g.status === 'final').length,
      chi_games: gs.filter((g) => g.home_club || g.away_club).map((g) => ({
        id: g.id, status: g.status, home_team_id: g.home_team_id, away_team_id: g.away_team_id,
        label: `${g.away_name || 'TBD'} @ ${g.home_name || 'TBD'}`,
      })),
    };
  });
  return { byGame, list, count: league.round_by === 'week' ? Math.max(0, ...keys) : keys.length };
}

function playoffRounds(playoffTeams) {
  return playoffTeams >= 4 ? 2 : playoffTeams >= 2 ? 1 : 0;
}

// The regular season fills every round that the playoffs don't need.
function defaultRegularWeeks(sport, roundBy = 'game', playoffTeams = 4) {
  const n = rounds({ sport, round_by: roundBy }).count;
  return n ? Math.max(1, n - playoffRounds(playoffTeams)) : 5;
}

// ---------- Lineups ----------

function starterLimit(league) {
  return league.starters || Math.max(1, league.roster_size - 1);
}

// Lineup history for a league: roster id -> moves, oldest first.
function lineupHistory(leagueId) {
  const out = {};
  for (const m of all(
    `SELECT m.roster_id, m.starter, m.at FROM lineup_moves m JOIN roster r ON r.id = m.roster_id
      WHERE r.league_id = ? ORDER BY m.at, m.id`,
    leagueId
  )) (out[m.roster_id] ||= []).push(m);
  return out;
}

// Whether a roster stint was in the starting lineup at time `at` (no time = now). A stint with no
// lineup moves yet (rosters from before lineups existed) counts as starting.
function starterAt(history, rosterId, at = new Date().toISOString()) {
  let starter = true;
  for (const m of history[rosterId] || []) {
    if (m.at > at) break;
    starter = !!m.starter;
  }
  return starter;
}

function setSlot(rosterId, starter, at = new Date().toISOString()) {
  run('INSERT INTO lineup_moves (roster_id, starter, at) VALUES (?, ?, ?)', rosterId, starter ? 1 : 0, at);
}

function currentStarters(league, teamId, history = lineupHistory(league.id)) {
  return all('SELECT id FROM roster WHERE league_team_id = ? AND dropped_at IS NULL', teamId)
    .filter((r) => starterAt(history, r.id)).length;
}

// Puts a player on a fantasy team. Like ESPN, he goes into an open starting spot if there is one,
// otherwise to the bench.
function addToRoster(league, teamId, athleteId, at, how) {
  const open = currentStarters(league, teamId) < starterLimit(league);
  const id = Number(run(
    'INSERT INTO roster (league_id, league_team_id, athlete_id, acquired_at, how) VALUES (?, ?, ?, ?, ?)',
    league.id, teamId, athleteId, at, how
  ).lastInsertRowid);
  setSlot(id, open, at);
  return id;
}

// Teams carried over from before lineups (or after a lower lineup size) can have too many starters.
// Bench the extras with the fewest season points, from now on.
function fixLineups(league) {
  if (!['active', 'complete'].includes(league.status)) return;
  const limit = starterLimit(league);
  const history = lineupHistory(league.id);
  const totals = athleteTotals(league.sport, league.scoring);
  for (const t of all('SELECT id FROM league_teams WHERE league_id = ?', league.id)) {
    const starters = all('SELECT id, athlete_id FROM roster WHERE league_team_id = ? AND dropped_at IS NULL', t.id)
      .filter((r) => starterAt(history, r.id))
      .sort((a, b) => (totals[b.athlete_id]?.points || 0) - (totals[a.athlete_id]?.points || 0));
    for (const r of starters.slice(limit)) setSlot(r.id, false);
  }
}

const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

// ESPN-style lock: once a player's Chi game that night has started, he can't be moved until the next day.
function lockedTeams(sport, now = new Date()) {
  const today = dayOf(now.toISOString());
  const locked = new Set();
  for (const g of all(
    `SELECT home_team_id, away_team_id, starts_at, status FROM games
      WHERE sport = ? AND (status = 'live' OR (starts_at <= ? AND status != 'final') OR (status = 'final' AND starts_at <= ?))`,
    sport, now.toISOString(), now.toISOString()
  )) {
    if (g.status === 'live' || dayOf(g.starts_at) === today) {
      if (g.home_team_id) locked.add(g.home_team_id);
      if (g.away_team_id) locked.add(g.away_team_id);
    }
  }
  return locked;
}

// The next Chi game for each intramural team in a sport (that hasn't finished).
function nextGames(sport) {
  const out = {};
  for (const g of all(
    `SELECT g.id, g.starts_at, g.status, g.home_team_id, g.away_team_id, h.name AS home_name, aw.name AS away_name
       FROM games g LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams aw ON aw.id = g.away_team_id
      WHERE g.sport = ? AND g.status != 'final' AND g.starts_at IS NOT NULL ORDER BY g.starts_at`,
    sport
  )) {
    for (const [mine, opp] of [[g.home_team_id, g.away_name], [g.away_team_id, g.home_name]]) {
      if (mine && !out[mine]) out[mine] = { game_id: g.id, starts_at: g.starts_at, status: g.status, opponent: opp || 'TBD' };
    }
  }
  return out;
}

// Standings: each team's points from its starters, counting only games that started while the
// player was rostered and in the starting lineup. Bench points are tracked but don't count.
function standings(league, R = rounds(league)) {
  const lines = sportStatLines(league.sport);
  const byAthlete = {};
  for (const l of lines) (byAthlete[l.athlete_id] ||= []).push(l);

  const teams = leagueTeams(league.id).map((t) => ({ ...t, points: 0, weeks: {}, players: [], byWeek: {}, adds: 0, drops: 0 }));
  const history = lineupHistory(league.id);
  const locked = lockedTeams(league.sport);
  const upcoming = nextGames(league.sport);
  const teamById = Object.fromEntries(teams.map((t) => [t.id, t]));
  const entries = all(
    `SELECT r.*, a.name, a.position, a.im_team_id, it.name AS team_name
       FROM roster r JOIN athletes a ON a.id = r.athlete_id
       LEFT JOIN im_teams it ON it.id = a.im_team_id
      WHERE r.league_id = ? ORDER BY r.id`,
    league.id
  );

  for (const e of entries) {
    const team = teamById[e.league_team_id];
    if (!team) continue;
    if (e.how === 'free agent' || e.how === 'commissioner') team.adds++;
    if (e.dropped_at && e.dropped_at !== e.acquired_at) team.drops++;
    let pts = 0;
    let teamPts = 0;
    for (const l of byAthlete[e.athlete_id] || []) {
      const counts = l.starts_at
        ? l.starts_at >= e.acquired_at && (!e.dropped_at || l.starts_at < e.dropped_at)
        : !e.dropped_at;
      if (!counts) continue;
      const p = linePoints(l, league.scoring);
      const starter = starterAt(history, e.id, l.starts_at || undefined);
      pts += p;
      if (starter) teamPts += p;
      const round = R.byGame[l.game_id];
      if (round == null) continue;
      if (starter) team.weeks[round] = (team.weeks[round] || 0) + p;
      const wk = (team.byWeek[round] ||= {});
      const c = (wk[`${e.athlete_id}:${starter ? 's' : 'b'}`] ||= {
        athlete_id: e.athlete_id, name: e.name, position: e.position, points: 0, dropped: !!e.dropped_at, bench: !starter,
      });
      c.points = Math.round((c.points + p) * 100) / 100;
    }
    pts = Math.round(pts * 100) / 100;
    team.points += teamPts;
    if (!e.dropped_at) {
      const next = upcoming[e.im_team_id] || null;
      team.players.push({
        athlete_id: e.athlete_id, roster_id: e.id, name: e.name, position: e.position, im_team_id: e.im_team_id,
        team_name: e.team_name, how: e.how, points: pts, starter: starterAt(history, e.id),
        locked: locked.has(e.im_team_id), next_game: next,
      });
    }
  }
  for (const t of teams) {
    t.points = Math.round(t.points * 100) / 100;
    t.players.sort((a, b) => b.starter - a.starter || b.points - a.points);
    for (const w of Object.keys(t.weeks)) t.weeks[w] = Math.round(t.weeks[w] * 100) / 100;
  }
  teams.sort((a, b) => b.points - a.points);
  teams.forEach((t, i) => (t.rank = i + 1));
  return teams;
}

// ---------- Head-to-head ----------

// Circle-method round robin. With an odd number of teams, one team has a bye each week.
function roundRobin(teamIds, weeks) {
  const ids = [...teamIds];
  if (ids.length % 2) ids.push(null);
  const n = ids.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i], b = ids[n - 1 - i];
      if (a && b) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    ids.splice(1, 0, ids.pop());
  }
  return Array.from({ length: weeks }, (_, w) => rounds[w % rounds.length] || []);
}

function generateSchedule(league) {
  run('DELETE FROM matchups WHERE league_id = ?', league.id);
  const teams = draftOrder(league.id).map((t) => t.id);
  roundRobin(teams, league.regular_weeks).forEach((pairs, i) => {
    for (const [h, a] of pairs) {
      run('INSERT INTO matchups (league_id, week, home_team_id, away_team_id) VALUES (?, ?, ?, ?)', league.id, i + 1, h, a);
    }
  });
}

function playoffSize(league, teamCount) {
  if (league.playoff_teams >= 4 && teamCount >= 4) return 4;
  if (league.playoff_teams >= 2 && teamCount >= 2) return 2;
  return 0;
}

// Standings, the weekly schedule with scores, the playoff bracket and the champion, in one place.
function leagueView(league) {
  const R0 = rounds(league);
  const teams = standings(league, R0);
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  const weeks = R0.list;
  const live = ['active', 'complete'].includes(league.status);
  if (live && !one('SELECT 1 FROM matchups WHERE league_id = ?', league.id)) generateSchedule(league);

  const score = (teamId, week) => Math.round((byId[teamId]?.weeks[week] || 0) * 100) / 100;
  const stateOf = (week) => weeks[week]?.state || 'upcoming';
  const game = (week, home, away, extra = {}) => {
    const g = {
      week, state: stateOf(week), home_team_id: home?.id ?? null, away_team_id: away?.id ?? null,
      home_points: home ? score(home.id, week) : null, away_points: away ? score(away.id, week) : null, ...extra,
    };
    if (g.state === 'final' && home && away) {
      g.winner = g.home_points > g.away_points ? home.id : g.away_points > g.home_points ? away.id : extra.tiebreak ?? null;
    }
    return g;
  };

  for (const t of teams) Object.assign(t, { w: 0, l: 0, t: 0, pf: 0, pa: 0 });
  const matchups = live
    ? all('SELECT * FROM matchups WHERE league_id = ? ORDER BY week, id', league.id).map((m) =>
        game(m.week, byId[m.home_team_id], byId[m.away_team_id], { id: m.id, kind: 'regular' }))
    : [];
  for (const m of matchups) {
    if (m.state !== 'final') continue;
    const h = byId[m.home_team_id], a = byId[m.away_team_id];
    if (!h || !a) continue;
    h.pf += m.home_points; h.pa += m.away_points; a.pf += m.away_points; a.pa += m.home_points;
    if (m.home_points === m.away_points) { h.t++; a.t++; }
    else if (m.home_points > m.away_points) { h.w++; a.l++; }
    else { a.w++; h.l++; }
  }
  const finals = matchups.filter((m) => m.state === 'final' && byId[m.home_team_id] && byId[m.away_team_id]);
  rankTeams(teams, finals);
  teams.forEach((t) => {
    t.pf = Math.round(t.pf * 100) / 100;
    t.pa = Math.round(t.pa * 100) / 100;
  });

  const R = league.regular_weeks;
  const regularDone = live && Array.from({ length: R }, (_, i) => stateOf(i + 1)).every((s) => s === 'final');
  const size = playoffSize(league, teams.length);
  let playoffs = null;
  let champion = null;
  if (size) {
    const seeds = regularDone ? teams.slice(0, size) : [];
    const seedOf = (t) => (t ? seeds.indexOf(t) + 1 : null);
    // Ties in the playoffs go to the higher seed.
    const pgame = (week, hi, lo, label) => ({ ...game(week, hi, lo, { tiebreak: hi?.id, kind: 'playoff', label }), home_seed: seedOf(hi), away_seed: seedOf(lo) });
    const winnerOf = (g) => (g.winner ? byId[g.winner] : null);
    const rounds = [];
    if (size === 4) {
      const semis = [pgame(R + 1, seeds[0], seeds[3], 'Semifinal'), pgame(R + 1, seeds[1], seeds[2], 'Semifinal')];
      const [w1, w2] = semis.map(winnerOf);
      // The better seed is listed first in the final.
      const [hi, lo] = w1 && w2 ? [w1, w2].sort((a, b) => seedOf(a) - seedOf(b)) : [w1, w2];
      rounds.push({ name: 'Semifinals', week: R + 1, games: semis });
      rounds.push({ name: 'Championship', week: R + 2, games: [pgame(R + 2, hi, lo, 'Championship')] });
    } else {
      rounds.push({ name: 'Championship', week: R + 1, games: [pgame(R + 1, seeds[0], seeds[1], 'Championship')] });
    }
    const final = rounds[rounds.length - 1].games[0];
    champion = winnerOf(final);
    playoffs = { size, rounds, seeded: regularDone };
  } else if (regularDone) {
    champion = teams[0] || null;
  }

  const lastWeek = R + (size === 4 ? 2 : size === 2 ? 1 : 0);
  let currentWeek = lastWeek;
  for (let w = 1; w <= lastWeek; w++) {
    if (stateOf(w) !== 'final') { currentWeek = w; break; }
  }

  const allGames = [...matchups, ...(playoffs?.rounds.flatMap((r) => r.games) || [])];
  const played = allGames.filter((m) => m.state === 'final' && byId[m.home_team_id] && byId[m.away_team_id]);
  streaks(teams, played);
  if (size) teams.forEach((t, i) => (t.seed = i < size ? i + 1 : null));
  const power = powerRankings(teams, played);
  const records = leagueRecords(teams, played);
  predict(league, teams, allGames, R0);
  const judged = allGames.filter((g) => g.prediction?.correct !== undefined);
  const aiRecord = { right: judged.filter((g) => g.prediction.correct).length, total: judged.length };

  return {
    teams, matchups, playoffs, regularDone, lastWeek, currentWeek, roundBy: league.round_by, aiRecord, power, records,
    starters: starterLimit(league),
    champion: champion ? { id: champion.id, name: champion.name, owner_name: champion.owner_name, points: champion.points } : null,
    weeks: Object.fromEntries(Array.from({ length: lastWeek }, (_, i) => [i + 1, weeks[i + 1] || { state: 'upcoming', games: 0 }])),
  };
}

// ---------- ESPN-style standings, power rankings and records ----------

const winPct = (t) => (t.w + t.l + t.t ? (t.w + t.t / 2) / (t.w + t.l + t.t) : 0);

// ESPN's order: win percentage, then head-to-head record among the tied teams, then points for,
// then points against (more is better: you were unlucky).
function rankTeams(teams, finals) {
  const h2h = (group) => {
    const ids = new Set(group.map((t) => t.id));
    const rec = Object.fromEntries(group.map((t) => [t.id, { w: 0, l: 0, t: 0 }]));
    for (const m of finals) {
      if (!ids.has(m.home_team_id) || !ids.has(m.away_team_id)) continue;
      const [h, a] = [rec[m.home_team_id], rec[m.away_team_id]];
      if (m.home_points === m.away_points) { h.t++; a.t++; }
      else if (m.home_points > m.away_points) { h.w++; a.l++; }
      else { a.w++; h.l++; }
    }
    return (t) => winPct(rec[t.id]);
  };
  teams.sort((a, b) => winPct(b) - winPct(a));
  const out = [];
  for (let i = 0; i < teams.length;) {
    let j = i;
    while (j < teams.length && winPct(teams[j]) === winPct(teams[i])) j++;
    const group = teams.slice(i, j);
    const hp = h2h(group);
    group.sort((a, b) => hp(b) - hp(a) || b.pf - a.pf || b.pa - a.pa || b.points - a.points);
    out.push(...group);
    i = j;
  }
  teams.splice(0, teams.length, ...out);
  teams.forEach((t, i) => (t.rank = i + 1));
}

// Current streak per team, like ESPN's W3 / L1, from finished games in order.
function streaks(teams, played) {
  for (const t of teams) {
    let type = null, len = 0;
    for (const m of [...played].sort((a, b) => a.week - b.week)) {
      if (m.home_team_id !== t.id && m.away_team_id !== t.id) continue;
      // The game's winner, so a playoff tie that went to the higher seed counts as a win and a loss.
      const r = m.winner ? (m.winner === t.id ? 'W' : 'L') : 'T';
      if (r === type) len++;
      else { type = r; len = 1; }
    }
    t.streak = type ? `${type}${len}` : null;
  }
}

// ESPN's power rankings: 80% two-step dominance (wins, plus the wins of the teams you beat),
// 15% average score and 5% average margin of victory.
function powerRankings(teams, played) {
  if (!played.length) return [];
  const idx = Object.fromEntries(teams.map((t, i) => [t.id, i]));
  const n = teams.length;
  const W = Array.from({ length: n }, () => Array(n).fill(0));
  const scores = teams.map(() => []);
  const movs = teams.map(() => []);
  for (const m of played) {
    const h = idx[m.home_team_id], a = idx[m.away_team_id];
    scores[h].push(m.home_points); scores[a].push(m.away_points);
    movs[h].push(m.home_points - m.away_points); movs[a].push(m.away_points - m.home_points);
    if (m.home_points > m.away_points) W[h][a]++;
    else if (m.away_points > m.home_points) W[a][h]++;
  }
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const out = teams.map((t, i) => {
    let dom = 0;
    for (let j = 0; j < n; j++) {
      dom += W[i][j];
      for (let k = 0; k < n; k++) dom += W[i][k] * W[k][j];
    }
    const s = avg(scores[i]), mov = avg(movs[i]);
    return { team_id: t.id, name: t.name, owner_name: t.owner_name, dominance: dom, avg_score: Math.round(s * 10) / 10,
      avg_margin: Math.round(mov * 10) / 10, power: Math.round((dom * 0.8 + s * 0.15 + mov * 0.05) * 100) / 100 };
  });
  out.sort((a, b) => b.power - a.power);
  out.forEach((p, i) => (p.rank = i + 1));
  return out;
}

// Season highs and lows, like ESPN's top scorer, least scorer, most points against and best/worst round.
function leagueRecords(teams, played) {
  if (!played.length) return null;
  const pick = (key, dir) => [...teams].sort((a, b) => dir * (a[key] - b[key]))[0];
  const nights = played.flatMap((m) => [
    { team_id: m.home_team_id, week: m.week, points: m.home_points },
    { team_id: m.away_team_id, week: m.week, points: m.away_points },
  ]);
  const name = (id) => teams.find((t) => t.id === id)?.name;
  const best = [...nights].sort((a, b) => b.points - a.points)[0];
  const worst = [...nights].sort((a, b) => a.points - b.points)[0];
  const t = (x, key) => ({ team_id: x.id, name: x.name, value: x[key] });
  return {
    top_scorer: t(pick('pf', -1), 'pf'), least_scorer: t(pick('pf', 1), 'pf'), most_against: t(pick('pa', -1), 'pa'),
    best_round: { ...best, name: name(best.team_id) }, worst_round: { ...worst, name: name(worst.team_id) },
  };
}

// ---------- Win predictions ----------

// Standard normal CDF (Abramowitz-Stegun 7.1.26).
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152735) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Each player's expected fantasy points per game. Their own average is pulled toward the club average
// for their tier until they have a few games, so one big game (or no games) doesn't swing it too far.
// Returns { perGame, cv }: cv is how much single games vary around the average, from all stat lines.
// Only games that started before `before` count, so a finished round can be judged on what was known then.
function playerProjections(league, before = null) {
  const lines = sportStatLines(league.sport).filter((l) => !before || (l.starts_at && l.starts_at < before));
  const raw = lines.map((l) => scoreLine(l.stats, league.scoring));
  const mean = raw.length ? raw.reduce((a, b) => a + b, 0) / raw.length : 0;
  const sd = raw.length > 1 ? Math.sqrt(raw.reduce((a, b) => a + (b - mean) ** 2, 0) / (raw.length - 1)) : 0;
  const hist = {};
  for (const l of lines) {
    const h = (hist[l.athlete_id] ||= { sum: 0, n: 0 });
    h.sum += linePoints(l, league.scoring);
    h.n += 1;
  }
  // A player who has no line in a finished game their team played (with stats entered) scored 0 in it.
  const played = new Set(lines.map((l) => `${l.game_id}:${l.athlete_id}`));
  const scored = all(
    `SELECT g.id, g.home_team_id, g.away_team_id, g.starts_at FROM games g
      WHERE g.sport = ? AND g.status = 'final' AND EXISTS (SELECT 1 FROM game_stats gs WHERE gs.game_id = g.id)`,
    league.sport
  ).filter((g) => !before || (g.starts_at && g.starts_at < before));
  const PRIOR_GAMES = 2;
  const perGame = {};
  for (const a of all(
    `SELECT a.id, a.im_team_id, COALESCE(t.multiplier, 1) AS mult FROM athletes a LEFT JOIN im_teams t ON t.id = a.im_team_id WHERE a.sport = ?`,
    league.sport
  )) {
    const h = hist[a.id] || { sum: 0, n: 0 };
    for (const g of scored) {
      if ((g.home_team_id === a.im_team_id || g.away_team_id === a.im_team_id) && !played.has(`${g.id}:${a.id}`)) h.n += 1;
    }
    perGame[a.id] = { team: a.im_team_id, est: (h.sum + PRIOR_GAMES * mean * a.mult) / (h.n + PRIOR_GAMES), games: h.n };
  }
  return { perGame, cv: mean ? sd / mean : 0, hasData: raw.length > 0 };
}

// Adds a prediction to every head-to-head game: projected points for both sides and the chance each
// side wins. Upcoming and finished rounds use what was known before the round started, so finished
// rounds show whether the pick was right. A live round counts the points already scored, plus each
// player's expected points for every Chi game their team still has left in it.
function predict(league, teams, games, R) {
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  const history = lineupHistory(league.id);
  const cache = {};
  const projections = (before) => (cache[before] ||= playerProjections(league, before === 'now' ? null : before));
  const side = (team, round, live, P) => {
    const info = R.list[round];
    const left = (info?.chi_games || []).filter((g) => !live || g.status !== 'final');
    let mu = live ? team.weeks[round] || 0 : 0;
    let v = 0;
    const players = [];
    for (const p of team.players) {
      const pr = P.perGame[p.athlete_id];
      if (!pr) continue;
      const n = left.filter((g) => g.home_team_id === pr.team || g.away_team_id === pr.team).length;
      const proj = pr.est * n;
      // Only starters count: the lineup when the round started, or the current one for a live round.
      const starter = starterAt(history, p.roster_id, live ? undefined : info?.first_game || undefined);
      if (starter) {
        mu += proj;
        v += n * (P.cv * pr.est) ** 2;
      }
      players.push({ athlete_id: p.athlete_id, name: p.name, position: p.position, starter, games: n, proj: Math.round(proj * 10) / 10 });
    }
    players.sort((a, b) => b.starter - a.starter || b.proj - a.proj);
    return { mu, v, players };
  };
  for (const g of games) {
    const info = R.list[g.week];
    if (!g.home_team_id || !g.away_team_id || !info) continue;
    const live = g.state === 'live';
    const P = projections(live ? 'now' : info.first_game || 'now');
    if (!P.hasData) {
      g.prediction = { basis: 'none' };
      continue;
    }
    const h = side(byId[g.home_team_id], g.week, live, P);
    const a = side(byId[g.away_team_id], g.week, live, P);
    const spread = Math.sqrt(h.v + a.v);
    let pHome = 0.5;
    if (spread > 0) pHome = normCdf((h.mu - a.mu) / spread);
    else if (h.mu !== a.mu) pHome = h.mu > a.mu ? 1 : 0;
    // Never call a round 100% before it is over.
    pHome = Math.min(0.99, Math.max(0.01, pHome));
    const pred = {
      basis: 'stats', pregame: !live,
      home_proj: Math.round(h.mu * 10) / 10, away_proj: Math.round(a.mu * 10) / 10,
      home_win: Math.round(pHome * 100) / 100,
      home_key: h.players.filter((x) => x.starter && x.proj).slice(0, 3), away_key: a.players.filter((x) => x.starter && x.proj).slice(0, 3),
      home_lineup: h.players, away_lineup: a.players,
    };
    pred.pick = pHome > 0.5 ? g.home_team_id : pHome < 0.5 ? g.away_team_id : null;
    if (g.state === 'final' && g.winner && pred.pick) pred.correct = pred.pick === g.winner;
    g.prediction = pred;
  }
}

function log(leagueId, text, kind = 'league') {
  run('INSERT INTO activity (league_id, text, kind) VALUES (?, ?, ?)', leagueId, text, kind);
}

// ---------- Draft ----------

function draftOrder(leagueId) {
  return all('SELECT id, league_id, user_id, name, draft_slot FROM league_teams WHERE league_id = ? ORDER BY draft_slot, id', leagueId);
}

// Snake order: round 1 goes 1..n, round 2 goes n..1, and so on.
function slotForPick(pickIndex, n) {
  const round = Math.floor(pickIndex / n) + 1;
  const i = pickIndex % n;
  return { round, slotIndex: round % 2 === 1 ? i : n - 1 - i };
}

function draftState(league) {
  const order = draftOrder(league.id);
  const n = order.length;
  const made = one('SELECT COUNT(*) AS c FROM draft_picks WHERE league_id = ?', league.id).c;
  const total = n * league.roster_size;
  const state = { totalPicks: total, picksMade: made, teams: n, onClock: null, round: null, deadline: null };
  if (league.status !== 'drafting' || made >= total || n === 0) return state;
  const { round, slotIndex } = slotForPick(made, n);
  state.round = round;
  state.onClock = order[slotIndex];
  if (league.pick_seconds > 0) {
    state.deadline = league.draft_paused
      ? null
      : league.clock_started_at + league.pick_seconds * 1000;
    state.remainingMs = league.draft_paused
      ? league.paused_remaining
      : Math.max(0, state.deadline - Date.now());
  }
  return state;
}

function availableAthletes(league) {
  const taken = new Set(
    all(
      `SELECT athlete_id FROM roster WHERE league_id = ? AND dropped_at IS NULL
       UNION SELECT athlete_id FROM draft_picks WHERE league_id = ? AND ? = 'drafting'`,
      league.id, league.id, league.status
    ).map((r) => r.athlete_id)
  );
  return athletesWithPoints(league.sport, league.scoring).filter((a) => a.active && !taken.has(a.id));
}

// Records a pick for whoever is on the clock. `at` is the clock time the next pick starts from.
function makePick(league, athleteId, { auto = false, at = Date.now() } = {}) {
  const state = draftState(league);
  if (!state.onClock) throw httpError(400, 'The draft is not waiting on a pick.');
  const athlete = one('SELECT * FROM athletes WHERE id = ? AND sport = ? AND active = 1', athleteId, league.sport);
  if (!athlete) throw httpError(400, 'That player is not in this sport.');
  if (one('SELECT 1 FROM draft_picks WHERE league_id = ? AND athlete_id = ?', league.id, athleteId)) {
    throw httpError(409, `${athlete.name} has already been drafted.`);
  }
  const pickNo = state.picksMade + 1;
  run(
    'INSERT INTO draft_picks (league_id, pick_no, round, league_team_id, athlete_id, auto) VALUES (?, ?, ?, ?, ?, ?)',
    league.id, pickNo, state.round, state.onClock.id, athleteId, auto ? 1 : 0
  );
  addToRoster(league, state.onClock.id, athleteId, EPOCH, 'draft');
  log(league.id, `Pick ${pickNo}: ${state.onClock.name} took ${athlete.name}${auto ? ' (auto)' : ''}`, 'draft');

  const remainingPool = availableAthletes(league).length;
  if (pickNo >= state.totalPicks || remainingPool === 0) {
    run(`UPDATE leagues SET status = 'active', clock_started_at = NULL WHERE id = ?`, league.id);
    log(league.id, 'The draft is complete. Good luck this season!');
  } else {
    run('UPDATE leagues SET clock_started_at = ? WHERE id = ?', at, league.id);
  }
  return { pickNo, athlete };
}

// Best available by season points so far, with a random tiebreak.
function autoPick(league, at) {
  const pool = availableAthletes(league).sort((a, b) => b.points - a.points || Math.random() - 0.5);
  if (!pool.length) {
    run(`UPDATE leagues SET status = 'active', clock_started_at = NULL WHERE id = ?`, league.id);
    return null;
  }
  return makePick(league, pool[0].id, { auto: true, at });
}

// The server owns the clock: any expired picks are auto-drafted whenever someone looks at the draft.
function processExpiredPicks(leagueId) {
  return tx(() => {
    for (let guard = 0; guard < 500; guard++) {
      const league = getLeague(leagueId);
      if (!league || league.status !== 'drafting' || league.draft_paused || league.pick_seconds <= 0) return;
      const deadline = league.clock_started_at + league.pick_seconds * 1000;
      if (Date.now() < deadline) return;
      if (!autoPick(league, deadline)) return;
    }
  });
}

// ---------- Secret bots ----------

const BOT_MOVE_EVERY_MS = 6 * 60 * 60 * 1000;

function botTeams(leagueId) {
  return all(
    `SELECT lt.id, lt.name, lt.bot_checked_at, u.bot FROM league_teams lt JOIN users u ON u.id = lt.user_id
      WHERE lt.league_id = ? AND u.bot IS NOT NULL`,
    leagueId
  );
}

// The winner wants the most points, the loser the fewest. Random tiebreaks so it does not look scripted.
function rankFor(bot, pool) {
  const dir = bot === 'lose' ? 1 : -1;
  return [...pool].sort((a, b) => dir * (a.points - b.points) || Math.random() - 0.5);
}

// Bots draft the moment they are on the clock, and during the season make at most one roster move
// every few hours: the winner swaps its worst player for the best free agent, the loser does the opposite.
function runBots(leagueId) {
  const bots = botTeams(leagueId);
  if (!bots.length) return;
  tx(() => {
    for (let guard = 0; guard < 500; guard++) {
      const league = getLeague(leagueId);
      if (!league || league.status !== 'drafting' || league.draft_paused) break;
      const bot = bots.find((b) => b.id === draftState(league).onClock?.id);
      if (!bot) break;
      const choice = rankFor(bot.bot, availableAthletes(league))[0];
      if (!choice) break;
      makePick(league, choice.id);
    }
    const league = getLeague(leagueId);
    if (league?.status !== 'active') return;
    const now = Date.now();
    for (const bot of bots) {
      if (bot.bot_checked_at && now - bot.bot_checked_at < BOT_MOVE_EVERY_MS) continue;
      run('UPDATE league_teams SET bot_checked_at = ? WHERE id = ?', now, bot.id);
      const totals = athleteTotals(league.sport, league.scoring);
      const roster = all(
        `SELECT r.athlete_id, a.name FROM roster r JOIN athletes a ON a.id = r.athlete_id
          WHERE r.league_team_id = ? AND r.dropped_at IS NULL`,
        bot.id
      ).map((r) => ({ ...r, points: totals[r.athlete_id]?.points || 0 }));
      // Players on waivers need a claim, so bots stick to free agents.
      const waived = require('./trades').onWaivers(league.id);
      const pool = rankFor(bot.bot, availableAthletes(league).filter((a) => !waived[a.id]));
      if (!pool.length) continue;
      const want = pool[0];
      // Keep the player this bot likes least: lowest scorer for the winner, highest for the loser.
      const cut = rankFor(bot.bot, roster).pop();
      const better = bot.bot === 'lose' ? want.points < (cut?.points ?? Infinity) : want.points > (cut?.points ?? -Infinity);
      const at = new Date().toISOString();
      if (roster.length < league.roster_size) {
        addToRoster(league, bot.id, want.id, at, 'free agent');
        log(league.id, `${bot.name} added ${want.name}`, 'move');
      } else if (cut && better) {
        run('UPDATE roster SET dropped_at = ? WHERE league_team_id = ? AND athlete_id = ? AND dropped_at IS NULL', at, bot.id, cut.athlete_id);
        require('./trades').putOnWaivers(league, cut.athlete_id, at);
        addToRoster(league, bot.id, want.id, at, 'free agent');
        log(league.id, `${bot.name} added ${want.name} and dropped ${cut.name}`, 'move');
      }
      botLineup(league, bot);
    }
  });
}

// Bots set their lineup too: the winner starts its best players, the loser its worst.
// Players whose game has already started that night stay where they are.
function botLineup(league, bot) {
  const totals = athleteTotals(league.sport, league.scoring);
  const locked = lockedTeams(league.sport);
  const history = lineupHistory(league.id);
  const roster = all(
    `SELECT r.id, r.athlete_id, a.im_team_id FROM roster r JOIN athletes a ON a.id = r.athlete_id
      WHERE r.league_team_id = ? AND r.dropped_at IS NULL`, bot.id
  ).map((r) => ({ ...r, points: totals[r.athlete_id]?.points || 0, starter: starterAt(history, r.id) }));
  const free = roster.filter((r) => !locked.has(r.im_team_id));
  const slots = starterLimit(league) - roster.filter((r) => r.starter && locked.has(r.im_team_id)).length;
  const want = new Set(rankFor(bot.bot, free).slice(0, Math.max(0, slots)).map((r) => r.id));
  for (const r of free) if (r.starter !== want.has(r.id)) setSlot(r.id, want.has(r.id));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  EPOCH, sportStatLines, starterLimit, lineupHistory, starterAt, setSlot, addToRoster, fixLineups, lockedTeams, nextGames, playerProjections, botLineup, statLinesFor, linePoints, athleteTotals, athletesWithPoints, getLeague, leagueTeams, standings, log,
  draftOrder, draftState, leagueView, runBots, botTeams, generateSchedule, defaultRegularWeeks, rounds, roundRobin, availableAthletes, makePick, processExpiredPicks, httpError,
};
