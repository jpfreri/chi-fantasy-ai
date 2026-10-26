// Fills a fresh database with made-up demo data so you can click around.
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

function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];

const users = [
  ['commish', 'Commissioner', 1],
  ['jake', 'Jake Miller', 0],
  ['sam', 'Sam Ortiz', 0],
  ['luke', 'Luke Chen', 0],
  ['eli', 'Eli Brooks', 0],
  ['noah', 'Noah Patel', 0],
].map(([u, d, a]) => ({ id: Number(run('INSERT INTO users (username, display_name, pass_hash, is_admin) VALUES (?, ?, ?, ?)', u, d, hash('password'), a).lastInsertRowid), name: d }));

const first = ['Caleb', 'Josh', 'Ethan', 'Ben', 'Micah', 'Tyler', 'Drew', 'Isaac', 'Zach', 'Cole', 'Nate', 'Gabe', 'Levi', 'Jonah', 'Aaron', 'Seth', 'Wes', 'Grant', 'Reid', 'Owen', 'Silas', 'Jude', 'Carter', 'Mason'];
const last = ['Reed', 'Hayes', 'Cruz', 'Bennett', 'Foster', 'Lane', 'Price', 'Ward', 'Hughes', 'Dean', 'Parks', 'Shaw', 'Grant', 'Cole', 'Fisher', 'Webb', 'Stone', 'Burke', 'Nash', 'Pierce'];
const used = new Set();
function personName() {
  for (;;) {
    const n = `${pick(first)} ${pick(last)}`;
    if (!used.has(n)) { used.add(n); return n; }
  }
}

const opponents = ['Sigma Phi Gamma', 'Delta Gamma Rho', 'Kappa Sigma Kappa', 'Lambda Lambda Chi'];
const perTeam = { softball: 9, flag_football: 7, volleyball: 6, basketball: 6, soccer: 8 };
const venues = { softball: 'Intramural Fields', flag_football: 'Intramural Fields', volleyball: 'RAC Court 2', basketball: 'RAC Court 1', soccer: 'Intramural Fields' };

// A believable stat line for each sport.
function statLine(sport, position) {
  const r = (max) => rand(max + 1);
  switch (sport) {
    case 'softball': {
      const ab = 3 + r(1);
      const hits = r(ab);
      const hr = Math.random() < 0.15 ? 1 : 0;
      const triple = Math.random() < 0.08 ? 1 : 0;
      const double = r(Math.max(0, hits - hr - triple) > 0 ? 1 : 0);
      return { ab, single: Math.max(0, hits - hr - triple - double), double, triple, hr, r: r(2) + hr, rbi: r(2) + hr, bb: r(1), k: Math.random() < 0.15 ? 1 : 0, e: Math.random() < 0.1 ? 1 : 0 };
    }
    case 'flag_football':
      if (position === 'QB') return { pass_td: r(3), pass_yds: 80 + r(150), int_thrown: r(1), rush_yds: r(25), xp: r(1) };
      if (['WR', 'RB', 'C'].includes(position)) return { rec: r(6), rec_yds: r(80), rec_td: r(1), rush_yds: position === 'RB' ? r(40) : 0, xp: r(1), flag_pull: r(2) };
      return { flag_pull: 1 + r(5), sack: r(1), def_int: Math.random() < 0.25 ? 1 : 0, def_td: Math.random() < 0.05 ? 1 : 0 };
    case 'volleyball':
      if (position === 'S') return { assists: 12 + r(15), aces: r(2), digs: r(5), serve_err: r(2), kills: r(2) };
      if (position === 'L' || position === 'DS') return { digs: 6 + r(10), aces: r(2), serve_err: r(1), assists: r(3) };
      return { kills: 3 + r(9), blocks: r(3), aces: r(2), digs: r(4), attack_err: r(3), serve_err: r(2) };
    case 'basketball': {
      const threes = r(position.includes('G') ? 4 : 1);
      return { pts: threes * 3 + r(14), threes, reb: r(position === 'C' || position === 'PF' ? 10 : 5), ast: r(position === 'PG' ? 8 : 3), stl: r(2), blk: r(position === 'C' ? 3 : 1), tov: r(3) };
    }
    case 'soccer':
      if (position === 'GK') return { saves: 2 + r(6), clean_sheet: Math.random() < 0.3 ? 1 : 0 };
      return { goals: Math.random() < (position === 'FWD' ? 0.45 : 0.15) ? 1 + (Math.random() < 0.2 ? 1 : 0) : 0, assists: Math.random() < 0.25 ? 1 : 0, shots_on: r(3), yellow: Math.random() < 0.08 ? 1 : 0 };
  }
  return {};
}

function teamScore(sport, lines) {
  switch (sport) {
    case 'softball': return lines.reduce((t, l) => t + (l.r || 0), 0);
    case 'flag_football': return lines.reduce((t, l) => t + 6 * ((l.pass_td || 0) + (l.def_td || 0)) + (l.xp || 0), 0);
    case 'volleyball': return 2 + rand(1);
    case 'basketball': return lines.reduce((t, l) => t + (l.pts || 0), 0);
    case 'soccer': return lines.reduce((t, l) => t + (l.goals || 0), 0);
  }
  return 0;
}

const now = Date.now();
const DAY = 86400000;

for (const sport of Object.keys(SPORTS)) {
  const s = SPORTS[sport];
  const teams = [];
  for (const [name, club] of [['ΧΛΦ A', 1], ['ΧΛΦ B', 1], ...opponents.slice(0, 2).map((o) => [o, 0])]) {
    teams.push({ id: Number(run('INSERT INTO im_teams (sport, name, is_club) VALUES (?, ?, ?)', sport, name, club).lastInsertRowid), name });
  }
  const athletes = [];
  for (const t of teams) {
    for (let i = 0; i < perTeam[sport]; i++) {
      const position = s.positions[i % s.positions.length];
      athletes.push({ id: Number(run('INSERT INTO athletes (sport, name, position, im_team_id) VALUES (?, ?, ?, ?)', sport, personName(), position, t.id).lastInsertRowid), team: t.id, position });
    }
  }

  // Round robin, played twice: 6 weeks. Weeks 1-4 are final, week 5 is half played, week 6 is upcoming.
  const pairings = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  for (let w = 0; w < 6; w++) {
    pairings[w % 3].forEach(([a, b], gi) => {
      const start = new Date(now + (w - 4) * 7 * DAY);
      start.setHours(19 + gi, 0, 0, 0);
      const status = w < 4 || (w === 4 && gi === 0) ? 'final' : w === 4 ? 'live' : 'scheduled';
      const gameId = Number(run(
        'INSERT INTO games (sport, week, starts_at, location, home_team_id, away_team_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        sport, w + 1, start.toISOString(), venues[sport], teams[a].id, teams[b].id, status
      ).lastInsertRowid);
      if (status === 'scheduled') return;
      const scores = {};
      for (const t of [teams[a], teams[b]]) {
        const lines = athletes.filter((x) => x.team === t.id).map((x) => {
          const line = statLine(sport, x.position);
          // A live game is about half done.
          if (status === 'live') for (const k of Object.keys(line)) line[k] = Math.floor(line[k] / 2);
          for (const k of Object.keys(line)) if (!line[k]) delete line[k];
          run('INSERT INTO game_stats (game_id, athlete_id, stats) VALUES (?, ?, ?)', gameId, x.id, JSON.stringify(line));
          return line;
        });
        scores[t.id] = teamScore(sport, lines);
      }
      if (sport === 'volleyball') scores[teams[b].id] = Math.max(0, scores[teams[a].id] - 1 - rand(2));
      run('UPDATE games SET home_score = ?, away_score = ? WHERE id = ?', scores[teams[a].id], scores[teams[b].id], gameId);
    });
  }
}

// One fantasy league per sport, in different states so every screen has something on it.
const leagueStates = { flag_football: 'active', basketball: 'active', volleyball: 'drafting', softball: 'setup', soccer: 'setup' };
const teamNames = ['Gridiron Gang', 'Holy Rollers', 'Bench Warmers', 'Pick Six Prophets', 'Fast Break Fellowship', 'The Underdogs'];
for (const [sport, target] of Object.entries(leagueStates)) {
  const s = SPORTS[sport];
  const leagueId = Number(run(
    `INSERT INTO leagues (sport, name, season, roster_size, pick_seconds, scoring, created_by, regular_weeks, playoff_teams)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sport, `ΧΛΦ ${s.name}`, 'Fall 2026', s.rosterSize, target === 'drafting' ? 600 : 90, JSON.stringify(defaultScoring(sport)), users[0].id,
    // Basketball is already in the playoffs; flag football is mid regular season.
    sport === 'basketball' ? 4 : 6, 4
  ).lastInsertRowid);
  const members = target === 'setup' ? users.slice(0, 3) : users.slice(0, 5);
  members.forEach((u, i) => {
    run('INSERT INTO league_teams (league_id, user_id, name, draft_slot) VALUES (?, ?, ?, ?)', leagueId, u.id, teamNames[(i + leagueId) % teamNames.length], i + 1);
    F.log(leagueId, `${u.name} joined as ${teamNames[(i + leagueId) % teamNames.length]}`);
  });
  if (target === 'setup') continue;
  run(`UPDATE leagues SET status = 'drafting', clock_started_at = ? WHERE id = ?`, Date.now(), leagueId);
  F.log(leagueId, 'The draft has started!');
  const picksToMake = target === 'active' ? members.length * s.rosterSize : 6;
  for (let i = 0; i < picksToMake; i++) {
    const league = F.getLeague(leagueId);
    if (league.status !== 'drafting') break;
    const pool = F.availableAthletes(league).sort((a, b) => b.points - a.points);
    // A little randomness so it does not look like a pure autodraft.
    F.makePick(league, pool[rand(Math.min(4, pool.length))].id);
  }
}

const counts = one('SELECT (SELECT COUNT(*) FROM athletes) AS a, (SELECT COUNT(*) FROM games) AS g, (SELECT COUNT(*) FROM leagues) AS l');
console.log(`Seeded ${users.length} users, ${counts.a} players, ${counts.g} games, ${counts.l} leagues.`);
console.log('Log in as "commish" (admin) or jake / sam / luke / eli / noah. Every password is "password".');
