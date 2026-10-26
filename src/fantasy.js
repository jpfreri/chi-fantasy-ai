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

// Standings: each team's points from its players, counting only games that started while rostered.
function standings(league) {
  const lines = sportStatLines(league.sport);
  const byAthlete = {};
  for (const l of lines) (byAthlete[l.athlete_id] ||= []).push(l);

  const teams = leagueTeams(league.id).map((t) => ({ ...t, points: 0, weeks: {}, players: [], byWeek: {} }));
  const teamById = Object.fromEntries(teams.map((t) => [t.id, t]));
  const entries = all(
    `SELECT r.*, a.name, a.position, it.name AS team_name
       FROM roster r JOIN athletes a ON a.id = r.athlete_id
       LEFT JOIN im_teams it ON it.id = a.im_team_id
      WHERE r.league_id = ? ORDER BY r.id`,
    league.id
  );

  for (const e of entries) {
    const team = teamById[e.league_team_id];
    if (!team) continue;
    let pts = 0;
    for (const l of byAthlete[e.athlete_id] || []) {
      const counts = l.starts_at
        ? l.starts_at >= e.acquired_at && (!e.dropped_at || l.starts_at < e.dropped_at)
        : !e.dropped_at;
      if (!counts) continue;
      const p = linePoints(l, league.scoring);
      pts += p;
      team.weeks[l.week] = (team.weeks[l.week] || 0) + p;
      const wk = (team.byWeek[l.week] ||= {});
      const c = (wk[e.athlete_id] ||= { athlete_id: e.athlete_id, name: e.name, position: e.position, points: 0, dropped: !!e.dropped_at });
      c.points = Math.round((c.points + p) * 100) / 100;
    }
    pts = Math.round(pts * 100) / 100;
    team.points += pts;
    if (!e.dropped_at) {
      team.players.push({
        athlete_id: e.athlete_id, name: e.name, position: e.position,
        team_name: e.team_name, how: e.how, points: pts,
      });
    }
  }
  for (const t of teams) {
    t.points = Math.round(t.points * 100) / 100;
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

// Fantasy week N is intramural week N. A week is final once every game in it is final.
function weekStatus(sport) {
  const out = {};
  for (const r of all(
    `SELECT week, COUNT(*) AS games, SUM(status = 'final') AS final, SUM(status != 'scheduled') AS started,
            MIN(starts_at) AS first_game
       FROM games WHERE sport = ? GROUP BY week`,
    sport
  )) {
    out[r.week] = { ...r, state: r.final === r.games ? 'final' : r.started > 0 ? 'live' : 'upcoming' };
  }
  return out;
}

function defaultRegularWeeks(sport) {
  return one('SELECT MAX(week) AS w FROM games WHERE sport = ?', sport).w || 5;
}

function playoffSize(league, teamCount) {
  if (league.playoff_teams >= 4 && teamCount >= 4) return 4;
  if (league.playoff_teams >= 2 && teamCount >= 2) return 2;
  return 0;
}

// Standings, the weekly schedule with scores, the playoff bracket and the champion, in one place.
function leagueView(league) {
  const teams = standings(league);
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  const weeks = weekStatus(league.sport);
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
  const pct = (t) => (t.w + t.l + t.t ? (t.w + t.t / 2) / (t.w + t.l + t.t) : 0);
  teams.sort((a, b) => pct(b) - pct(a) || b.w - a.w || b.points - a.points);
  teams.forEach((t, i) => {
    t.rank = i + 1;
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

  return {
    teams, matchups, playoffs, regularDone, lastWeek, currentWeek,
    champion: champion ? { id: champion.id, name: champion.name, owner_name: champion.owner_name, points: champion.points } : null,
    weeks: Object.fromEntries(Array.from({ length: lastWeek }, (_, i) => [i + 1, weeks[i + 1] || { state: 'upcoming', games: 0 }])),
  };
}

function log(leagueId, text) {
  run('INSERT INTO activity (league_id, text) VALUES (?, ?)', leagueId, text);
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
  run(
    'INSERT INTO roster (league_id, league_team_id, athlete_id, acquired_at, how) VALUES (?, ?, ?, ?, ?)',
    league.id, state.onClock.id, athleteId, EPOCH, 'draft'
  );
  log(league.id, `Pick ${pickNo}: ${state.onClock.name} took ${athlete.name}${auto ? ' (auto)' : ''}`);

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
      const pool = rankFor(bot.bot, availableAthletes(league));
      if (!pool.length) continue;
      const want = pool[0];
      // Keep the player this bot likes least: lowest scorer for the winner, highest for the loser.
      const cut = rankFor(bot.bot, roster).pop();
      const better = bot.bot === 'lose' ? want.points < (cut?.points ?? Infinity) : want.points > (cut?.points ?? -Infinity);
      const at = new Date().toISOString();
      if (roster.length < league.roster_size) {
        run('INSERT INTO roster (league_id, league_team_id, athlete_id, acquired_at, how) VALUES (?, ?, ?, ?, ?)', league.id, bot.id, want.id, at, 'free agent');
        log(league.id, `${bot.name} added ${want.name}`);
      } else if (cut && better) {
        run('UPDATE roster SET dropped_at = ? WHERE league_team_id = ? AND athlete_id = ? AND dropped_at IS NULL', at, bot.id, cut.athlete_id);
        run('INSERT INTO roster (league_id, league_team_id, athlete_id, acquired_at, how) VALUES (?, ?, ?, ?, ?)', league.id, bot.id, want.id, at, 'free agent');
        log(league.id, `${bot.name} added ${want.name} and dropped ${cut.name}`);
      }
    }
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  EPOCH, sportStatLines, statLinesFor, linePoints, athleteTotals, athletesWithPoints, getLeague, leagueTeams, standings, log,
  draftOrder, draftState, leagueView, runBots, botTeams, generateSchedule, defaultRegularWeeks, roundRobin, availableAthletes, makePick, processExpiredPicks, httpError,
};
