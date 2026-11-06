// Fills a fresh database with demo data built from the club's real roster, stat sheets and schedules:
// scripts/demo-data.json (2026-27 directory names, team letters and season stat totals) and
// scripts/schedules-2026-27.json (the softball, flag football and volleyball schedules).
// Names on the stat sheets that are not in the directory are graduates and are left out.
// The sheets only have season totals, so each player's totals are split across the games at random.
// The totals add up exactly; the game-by-game split is made up. Only the "Softball 26" and
// "Football 26" sheets are used: volleyball, basketball and soccer have not been played yet.
// Usage: npm run seed   (wipes the database first)
const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = process.env.DB_FILE || path.join(dataDir, 'fantasy.db');
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });

const crypto = require('crypto');
const { run, one } = require('../src/db');
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
const CLUB = {
  softball: { teams: { A: [1, true], B: [0.75, false] }, rest: 'B' },
  flag_football: { teams: { A: [1, true], B: [0.75, true], B2: [0.5, false] }, rest: 'B2' },
  // Volleyball, basketball and soccer have not started: their rosters are left for an admin to fill in.
  volleyball: { teams: { A: [1, true], B: [0.75, true], C: [0.5, false] }, rest: null },
  basketball: { teams: { A: [1, true], B: [0.75, true], C: [0.5, true] }, rest: null },
  soccer: { teams: { A: [1, true] }, rest: null },
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
  for (const name of DATA.members) {
    const letter = DATA.teams[sport]?.[name] || club.rest;
    teamOf[name] = letter;
    athleteId[name] = Number(run('INSERT INTO athletes (sport, name, position, im_team_id) VALUES (?, ?, ?, ?)',
      sport, name, DATA.positions[sport]?.[name] || null, letter ? teamId(`Chi ${letter}`) : null).lastInsertRowid);
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
const leagues = {
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
    sport, `ΧΛΦ ${s.name}`, cfg.season, s.rosterSize, cfg.state === 'drafting' ? 600 : 90,
    JSON.stringify(defaultScoring(sport)), users[0].id, F.defaultRegularWeeks(sport, 'game', cfg.playoffs), cfg.playoffs
  ).lastInsertRowid);
  // Quinten's fantasy teams were removed at his request; his login stays.
  const managers = users.filter((u) => u.name !== 'Quinten Talamantes');
  const members = cfg.state === 'setup' ? managers.slice(0, 3) : managers;
  members.forEach((u, i) => {
    const name = teamNames[(i + leagueId) % teamNames.length];
    run('INSERT INTO league_teams (league_id, user_id, name, draft_slot) VALUES (?, ?, ?, ?)', leagueId, u.id, name, i + 1);
    F.log(leagueId, `${u.name} joined as ${name}`);
  });
  // Two secret bots per league: one always trying to win, one always trying to lose.
  for (const [kind, owner, team] of [['win', 'Big Mike', 'The Machine'], ['lose', 'Old Man Jenkins', 'Tank Commanders']]) {
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
    const pool = F.availableAthletes(league).sort((a, b) => b.points - a.points);
    F.makePick(league, pool[rand(Math.min(4, pool.length))].id);
  }
  if (cfg.state === 'complete') run(`UPDATE leagues SET status = 'complete' WHERE id = ?`, leagueId);
}

const counts = one('SELECT (SELECT COUNT(*) FROM athletes) AS a, (SELECT COUNT(*) FROM games) AS g, (SELECT COUNT(*) FROM game_stats) AS s');
console.log(`Seeded ${DATA.members.length} members in 5 sports (${counts.a} player entries), ${counts.g} games, ${counts.s} stat lines.`);
console.log('Log in as "admin" (admin) or jp / quinten / brody / steven. Every password is "password".');
