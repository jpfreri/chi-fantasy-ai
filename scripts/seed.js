// Fills a fresh database with demo data built from the club's real roster, stat sheets and schedules:
// scripts/demo-data.json (2026-27 directory names, team letters and season stat totals) and
// scripts/schedules-2026-27.json (the softball, flag football and volleyball schedules).
// Names on the stat sheets that are not in the directory are graduates and are left out.
// The sheets only have season totals, so each player's totals are split across the games at random.
// The totals add up exactly; the game-by-game split is made up. Only the "Softball 26" and
// "Football 26" sheets are used: volleyball, basketball and soccer have not been played yet.
// Usage: npm run seed   (wipes the database first)
//
// Demo mode (npm run demo, or this script with --demo) builds data/demo.db instead and never touches
// data/fantasy.db. Every league is drafted and playing: volleyball uses the mock stat sheet in
// scripts/demo/mock-volleyball.csv, and basketball and soccer get made-up game nights and box scores.
// Dates are set relative to today, so the demo always has finished rounds and one coming up.
const fs = require('fs');
const path = require('path');

const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = process.env.DB_FILE || path.join(dataDir, DEMO ? 'demo.db' : 'fantasy.db');
if (DEMO && !process.env.DB_FILE) process.env.DB_FILE = dbFile;
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });

const crypto = require('crypto');
const { run, one, all, tx } = require('../src/db');
const { SPORTS, defaultScoring } = require('../src/sports');
const F = require('../src/fantasy');
const DATA = require('./demo-data.json');

function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

// Seeded random numbers so every seed run gives the same demo.
let state = 20262027;
const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
const rand = (n) => Math.floor(random() * n);

const DAY = 86400000;
const now = Date.now();

// Logins for trying the app. Everyone's password is "password".
const users = [
  ['admin', 'Admin', 1],
  ['jp', 'JP Freri', 0],
  ['quinten', 'Quinten Talamantes', 0],
  ['brody', 'Brody White', 0],
  ['steven', 'Steven Holland', 0],
].map(([u, d, a]) => ({ id: Number(run('INSERT INTO users (username, display_name, pass_hash, is_admin) VALUES (?, ?, ?, ?)', u, d, hash('password'), a).lastInsertRowid), name: d }));

// Split a season total into `games` whole-number pieces (yards and other counts alike).
function split(total, games) {
  const parts = Array(games).fill(0);
  for (let i = 0; i < total; i++) parts[rand(games)]++;
  return parts;
}

// Chi's teams in each sport: [fantasy multiplier, counts for intramural points].
// Members who are not on a listed roster go on the sport's last team (the one that does not count).
// Tier multipliers from the club (2026-11-06): A players x1.25, B x1.0, C x0.75. B2 is a B team.
const CLUB = {
  softball: { teams: { A: [1.25, true], B: [1, false] }, rest: 'B' },
  flag_football: { teams: { A: [1.25, true], B: [1, true], B2: [1, false] }, rest: 'B2' },
  // Volleyball rosters are from the club (2026-11-06): A and B as listed, everyone else on C.
  volleyball: { teams: { A: [1.25, true], B: [1, true], C: [0.75, false] }, rest: 'C' },
  // Basketball and soccer have not started: their rosters are left for an admin to fill in.
  basketball: { teams: { A: [1.25, true], B: [1, true], C: [0.75, true] }, rest: null },
  soccer: { teams: { A: [1.25, true] }, rest: null },
};

// "MA 1vs.4" -> "Men's A semifinal (1 vs 4)", and so on.
function playoffLabel(raw) {
  const div = { MA: "Men's A", MB: "Men's B", MC: "Men's C", W: "Women's", WA: "Women's A", WB: "Women's B", WC: "Women's C" };
  let m = raw.match(/^(\w+) (\d)\s*vs\.?\s*(\d)$/) || raw.match(/^(\d) vs\. (\d) (\w+)$/);
  if (m) {
    const [d, a, b] = /^\d/.test(m[1]) ? [m[3], m[1], m[2]] : [m[1], m[2], m[3]];
    return `${div[d] || d} semifinal (${a} vs ${b})`;
  }
  m = raw.match(/^(\w+) (3rd|Champ|Championship)$/);
  if (m) return `${div[m[1]] || m[1]} ${m[2] === '3rd' ? '3rd place game' : 'championship'}`;
  return raw.replace(/^Women's 3rd$/, "Women's 3rd place game").replace(/^Men's 3rd$/, "Men's 3rd place game");
}

const SCHEDULES = require('./schedules-2026-27.json').games;

// ---------- Demo seasons ----------

const DAY_MS = 86400000;
// A Central-time date string plus "H:MM PM" -> ISO time. Central is UTC-6 in winter, -5 in summer.
function central(dateStr, hhmm) {
  const guess = new Date(`${dateStr}T${hhmm}:00-06:00`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' })
    .formatToParts(guess).find((p) => p.type === 'timeZoneName').value; // "GMT-6"
  const h = Number(off.replace('GMT', '')) || -6;
  return new Date(`${dateStr}T${hhmm}:00${h < 0 ? '-' : '+'}${String(Math.abs(h)).padStart(2, '0')}:00`).toISOString();
}
const dayStr = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const OPPONENTS = ['Kappa', 'Delta', 'Alpha', 'Gamma', 'Lambda', 'Theta', 'Fresh M'];
const TIMES = { A: '21:15', B: '20:30', C: '22:00' };

// The mock volleyball sheet: one row per player per game, with teams A, B and C.
function readMockVolleyball() {
  const lines = fs.readFileSync(path.join(__dirname, 'demo', 'mock-volleyball.csv'), 'utf8').trim().split(/\r?\n/);
  const head = lines.shift().split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
}
const MOCK_VB = DEMO ? readMockVolleyball() : [];
const VB_COLS = {
  serves_made: 'Serves Made', serve_err: 'Serves Missed', aces: 'Aces', bad_rec: 'Bad Serve Rec', good_rec: 'Good Serve Rec',
  attack_err: 'Attack Errors', attacks: 'Attacks', kills: 'Kills', assists: 'Assists', blocks: 'Blocks', digs: 'Digs', dig_err: 'Dig Errors',
};
// Nobody has played yet in the demo's volleyball league, so its draft goes by the mock sheet's season
// (points x tier), like a preseason ranking.
const MOCK_RANK = {};
for (const r of MOCK_VB) {
  if (r.Played !== 'Y') continue;
  const pts = Object.entries(VB_COLS).reduce((t, [k, col]) => t + (Number(r[col]) || 0) * defaultScoring('volleyball')[k], 0);
  MOCK_RANK[r['Full Name']] = (MOCK_RANK[r['Full Name']] || 0) + pts * ({ A: 1.25, B: 1, C: 0.75 }[r.Team] || 1);
}

// Who plays for which Chi team in the demo. Volleyball uses the real rosters; basketball and soccer
// are dealt out at random (the real rosters aren't in yet).
const DEMO_TEAMS = { volleyball: {}, basketball: {}, soccer: {} };
if (DEMO) {
  const shuffled = [...DATA.members].sort(() => random() - 0.5);
  shuffled.slice(0, 24).forEach((n, i) => { DEMO_TEAMS.basketball[n] = ['A', 'B', 'C'][Math.floor(i / 8)]; });
  [...DATA.members].sort(() => random() - 0.5).slice(0, 12).forEach((n) => { DEMO_TEAMS.soccer[n] = 'A'; });
}

const insertGame = (sport, week, startsAt, location, homeId, awayId, status, hs, as) => Number(run(
  `INSERT INTO games (sport, week, starts_at, location, home_team_id, away_team_id, status, home_score, away_score)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, sport, week, startsAt, location, homeId, awayId, status, hs, as).lastInsertRowid);
const insertLine = (gameId, athleteId, stats) => {
  const clean = Object.fromEntries(Object.entries(stats).filter(([, v]) => v));
  if (Object.keys(clean).length) run('INSERT INTO game_stats (game_id, athlete_id, stats) VALUES (?, ?, ?)', gameId, athleteId, JSON.stringify(clean));
};

// Made-up box score lines, shaped by position.
function basketballLine(pos) {
  const big = pos === 'C' || pos === 'PF';
  const threes = big ? rand(2) : rand(4);
  return { pts: threes * 3 + rand(big ? 12 : 10) + 2, threes, reb: rand(big ? 10 : 5) + 1, ast: rand(big ? 3 : 7),
    stl: rand(3), blk: rand(big ? 3 : 1), tov: rand(4) };
}
function soccerLine(pos, cleanSheet) {
  if (pos === 'GK') return { saves: rand(7) + 1, clean_sheet: cleanSheet ? 1 : 0, yellow: rand(10) === 0 ? 1 : 0 };
  const fwd = pos === 'FWD', mid = pos === 'MID';
  return { goals: random() < (fwd ? 0.45 : mid ? 0.2 : 0.05) ? 1 + rand(2) : 0, assists: random() < (mid ? 0.35 : 0.15) ? 1 : 0,
    shots_on: rand(fwd ? 5 : mid ? 3 : 1), clean_sheet: pos === 'DEF' && cleanSheet ? 1 : 0, yellow: rand(8) === 0 ? 1 : 0 };
}

const DEMO_SEASON = {
  // The mock sheet's game nights on their own dates, with nothing played yet: points only show up once
  // the admin enters a game's score and stats (or uploads that night from scripts/demo/game-nights).
  volleyball({ sport, teamId }) {
    const games = new Set();
    for (const r of MOCK_VB) {
      const key = `${r['Game #']}|${r.Team}`;
      if (games.has(key)) continue;
      games.add(key);
      const [mm, dd, yy] = r.Date.split('/');
      insertGame(sport, Number(r['Game #']), central(`${yy}-${mm}-${dd}`, TIMES[r.Team]), r.Team === 'C' ? 'Rec' : 'Nest',
        teamId(`Chi ${r.Team}`), teamId(r.Opponent), 'scheduled', null, null);
    }
  },
  basketball: (ctx) => madeUpSeason(ctx, ['A', 'B', 'C'], basketballLine, (mine) => [mine + rand(10) + 4, 30 + rand(30)]),
  soccer: (ctx) => madeUpSeason(ctx, ['A'], null, null),
};

// Six game nights: five already played (about every four days) and one two days from now.
function madeUpSeason({ sport, teamId, athleteId, teamOf }, letters, lineFor, scoreFor) {
  const offsets = [-19, -15, -11, -7, -3, 2];
  const pos = (name) => DATA.positions[sport]?.[name] || SPORTS[sport].positions[rand(SPORTS[sport].positions.length)];
  offsets.forEach((off, i) => {
    const day = dayStr(now + off * DAY_MS);
    for (const L of letters) {
      const opp = `${OPPONENTS[(i + letters.indexOf(L)) % OPPONENTS.length]} ${L}`;
      const starts = central(day, TIMES[L]);
      const final = new Date(starts).getTime() < now;
      const players = Object.keys(teamOf).filter((n) => teamOf[n] === L);
      const gid = insertGame(sport, i + 1, starts, sport === 'soccer' ? 'East Field' : 'Gym', teamId(`Chi ${L}`), teamId(opp), final ? 'final' : 'scheduled', null, null);
      if (!final) continue;
      let ours = 0;
      let theirs = sport === 'soccer' ? rand(3) : 0;
      for (const n of players) {
        if (random() < 0.12) continue; // missed the game
        const line = sport === 'soccer' ? soccerLine(n === players[0] ? 'GK' : pos(n) === 'GK' ? 'DEF' : pos(n), theirs === 0) : lineFor(pos(n));
        ours += line.pts || line.goals || 0;
        insertLine(gid, athleteId[n], line);
      }
      const [hs, as] = sport === 'soccer' ? [ours, theirs] : scoreFor(ours);
      run('UPDATE games SET home_score = ?, away_score = ? WHERE id = ?', hs, as, gid);
    }
  });
}

for (const [sport, club] of Object.entries(CLUB)) {
  const teamIds = {};
  const teamId = (name) => {
    if (!teamIds[name]) {
      const letter = name.match(/^Chi (\w+)$/)?.[1];
      const [mult, points] = club.teams[letter] || [1, true];
      teamIds[name] = Number(run('INSERT INTO im_teams (sport, name, is_club, for_points, multiplier) VALUES (?, ?, ?, ?, ?)',
        sport, name, letter ? 1 : 0, points ? 1 : 0, letter ? mult : 1).lastInsertRowid);
    }
    return teamIds[name];
  };
  for (const letter of Object.keys(club.teams)) teamId(`Chi ${letter}`);

  // Every member is in every sport's player pool.
  const athleteId = {};
  const teamOf = {};
  const demoTeams = DEMO ? DEMO_TEAMS[sport] : null;
  for (const name of DATA.members) {
    const letter = demoTeams?.[name] || DATA.teams[sport]?.[name] || club.rest;
    teamOf[name] = letter;
    athleteId[name] = Number(run('INSERT INTO athletes (sport, name, position, im_team_id) VALUES (?, ?, ?, ?)',
      sport, name, DATA.positions[sport]?.[name] || null, letter ? teamId(`Chi ${letter}`) : null).lastInsertRowid);
  }

  // Demo: volleyball, basketball and soccer get their own made-up season instead.
  if (DEMO && DEMO_SEASON[sport]) {
    DEMO_SEASON[sport]({ sport, teamId, athleteId, teamOf });
    continue;
  }

  // Games: the real 26-27 schedule where there is one (none yet for basketball and soccer).
  const games = SCHEDULES[sport] || [];
  const clubGames = {};
  for (const g of games) {
    const status = new Date(g.starts_at) < new Date(now) ? 'final' : 'scheduled';
    const id = Number(run(
      `INSERT INTO games (sport, week, starts_at, location, home_team_id, away_team_id, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sport, g.week, new Date(g.starts_at).toISOString(), g.location,
      g.home ? teamId(g.home) : null, g.away ? teamId(g.away) : null, status,
      g.label ? playoffLabel(g.label) : g.note || null
    ).lastInsertRowid);
    for (const side of [g.home, g.away]) {
      const letter = side?.match(/^Chi (\w+)$/)?.[1];
      if (letter && status === 'final') (clubGames[letter] ||= []).push(id);
    }
  }

  // The sheets only have season totals. Spread each player's totals over his team's games so far
  // (or fewer, when the sheet says how many he played).
  for (const [name, stats] of Object.entries(DATA.totals[sport] || {})) {
    const ids = clubGames[teamOf[name]] || [];
    if (!ids.length || !Object.keys(stats).length) continue;
    const gp = Math.max(1, Math.min(ids.length, DATA[`${sport}_gp`]?.[name] || ids.length));
    const lines = Array.from({ length: gp }, () => ({}));
    for (const [k, v] of Object.entries(stats)) split(v, gp).forEach((n, i) => { if (n) lines[i][k] = n; });
    lines.forEach((line, i) => {
      if (Object.keys(line).length) run('INSERT INTO game_stats (game_id, athlete_id, stats) VALUES (?, ?, ?)', ids[i], athleteId[name], JSON.stringify(line));
    });
  }
}

// One fantasy league per sport, in different states so every screen has something on it.
// Each Chi game night is a fantasy round. Softball had 4 game nights and flag football 5.
const leagues = DEMO ? {
  softball: { state: 'complete', playoffs: 2, season: '2026-27' },
  flag_football: { state: 'complete', playoffs: 2, season: '2026-27' },
  volleyball: { state: 'active', playoffs: 2, season: '2026-27' },
  basketball: { state: 'active', playoffs: 2, season: '2026-27' },
  soccer: { state: 'active', playoffs: 2, season: '2026-27' },
} : {
  softball: { state: 'complete', playoffs: 2, season: '2026-27' },
  flag_football: { state: 'active', playoffs: 2, season: '2026-27' },
  volleyball: { state: 'setup', playoffs: 2, season: '2026-27' },
  basketball: { state: 'setup', playoffs: 4, season: '2026-27' },
  soccer: { state: 'setup', playoffs: 4, season: '2026-27' },
};
const teamNames = ['Scotsmen Supreme', 'Holy Rollers', 'Bench Warmers', 'Pick Six Prophets', 'Fast Break Fellowship'];
for (const [sport, cfg] of Object.entries(leagues)) {
  const s = SPORTS[sport];
  const leagueId = Number(run(
    `INSERT INTO leagues (sport, name, season, roster_size, pick_seconds, scoring, created_by, regular_weeks, playoff_teams)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sport, `ΧΛΦ ${s.name}`, cfg.season, DEMO ? 6 : s.rosterSize, cfg.state === 'drafting' ? 600 : 90,
    JSON.stringify(defaultScoring(sport)), users[0].id, F.defaultRegularWeeks(sport, 'game', cfg.playoffs), cfg.playoffs
  ).lastInsertRowid);
  // Quinten's fantasy teams were removed at his request; his login stays.
  const managers = users.filter((u) => u.name !== 'Quinten Talamantes');
  // Demo leagues have 4 teams of 6. Volleyball is all people (its trade and waiver examples need four
  // managers); the others are two people plus the two bots.
  const bots = !DEMO || sport !== 'volleyball';
  const members = cfg.state === 'setup' ? managers.slice(0, 3) : DEMO && bots ? managers.slice(0, 2) : managers;
  members.forEach((u, i) => {
    const name = teamNames[(i + leagueId) % teamNames.length];
    run('INSERT INTO league_teams (league_id, user_id, name, draft_slot) VALUES (?, ?, ?, ?)', leagueId, u.id, name, i + 1);
    F.log(leagueId, `${u.name} joined as ${name}`);
  });
  // Two secret bots per league: one always trying to win, one always trying to lose.
  for (const [kind, owner, team] of bots ? [['win', 'Big Mike', 'The Machine'], ['lose', 'Old Man Jenkins', 'Tank Commanders']] : []) {
    const uid = Number(run('INSERT INTO users (username, display_name, pass_hash, bot) VALUES (?, ?, ?, ?)',
      `bot-${kind}-${leagueId}`, owner, hash(crypto.randomBytes(24).toString('hex')), kind).lastInsertRowid);
    run('INSERT INTO league_teams (league_id, user_id, name, draft_slot) VALUES (?, ?, ?, ?)', leagueId, uid, team, members.length + (kind === 'win' ? 1 : 2));
    F.log(leagueId, `${owner} joined as ${team}`);
  }
  if (cfg.state === 'setup') continue;
  run(`UPDATE leagues SET status = 'drafting', clock_started_at = ? WHERE id = ?`, Date.now(), leagueId);
  F.log(leagueId, 'The draft has started!');
  const picksToMake = cfg.state === 'drafting' ? 6 : Infinity;
  for (let i = 0; i < 500; i++) {
    F.runBots(leagueId);
    const league = F.getLeague(leagueId);
    if (league.status !== 'drafting' || F.draftState(league).picksMade >= picksToMake) break;
    const rank = (a) => (DEMO && sport === 'volleyball' ? MOCK_RANK[a.name] || 0 : a.points);
    const pool = F.availableAthletes(league).sort((a, b) => rank(b) - rank(a));
    F.makePick(league, pool[rand(Math.min(4, pool.length))].id);
  }
  if (cfg.state === 'complete') run(`UPDATE leagues SET status = 'complete' WHERE id = ?`, leagueId);
}

// Demo: a little trade and waiver action in the volleyball league, so those screens have something on them.
if (DEMO) {
  const T = require('../src/trades');
  const league = one(`SELECT id FROM leagues WHERE sport = 'volleyball'`);
  const L = F.getLeague(league.id);
  const teamOfUser = (u) => one('SELECT lt.* FROM league_teams lt JOIN users us ON us.id = lt.user_id WHERE lt.league_id = ? AND us.username = ?', L.id, u);
  const best = (team, n) => all(`SELECT athlete_id FROM roster WHERE league_team_id = ? AND dropped_at IS NULL ORDER BY id`, team.id).slice(0, n).map((r) => r.athlete_id);
  const last = (team) => all(`SELECT athlete_id FROM roster WHERE league_team_id = ? AND dropped_at IS NULL ORDER BY id DESC`, team.id)[0].athlete_id;
  const [jp, brody, steven, adminTeam] = ['jp', 'brody', 'steven', 'admin'].map(teamOfUser);
  tx(() => {
    // A finished trade between Brody and the admin.
    const done = T.propose(L, brody, adminTeam.id, [last(brody)], [last(adminTeam)], 'Need a setter, you need a hitter.');
    T.execute(L, one('SELECT * FROM trades WHERE id = ?', done), new Date(now - 2 * DAY_MS).toISOString());
    // An open offer to JP, waiting for an answer.
    T.propose(L, steven, jp.id, [best(steven, 2)[1]], [last(jp)], 'Fair swap? He has been hot lately.');
    // JP dropped a player this morning; Brody put in a claim.
    const dropped = last(jp);
    run('UPDATE roster SET dropped_at = ? WHERE league_team_id = ? AND athlete_id = ? AND dropped_at IS NULL', new Date(now - 3 * 3600000).toISOString(), jp.id, dropped);
    T.putOnWaivers(L, dropped, new Date(now - 3 * 3600000).toISOString());
    F.log(L.id, `${jp.name} dropped ${one('SELECT name FROM athletes WHERE id = ?', dropped).name}`, 'move');
    T.claim(L, brody, dropped, last(brody));
  });
}

const counts = one('SELECT (SELECT COUNT(*) FROM athletes) AS a, (SELECT COUNT(*) FROM games) AS g, (SELECT COUNT(*) FROM game_stats) AS s');
console.log(`Seeded ${DATA.members.length} members in 5 sports (${counts.a} player entries), ${counts.g} games, ${counts.s} stat lines.`);
console.log('Log in as "admin" (admin) or jp / quinten / brody / steven. Every password is "password".');
