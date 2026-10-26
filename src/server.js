const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { one, all, run, tx } = require('./db');
const { SPORTS, defaultScoring, scoreLine } = require('./sports');
const F = require('./fantasy');

const app = express();
app.use(express.json({ limit: '1mb' }));

const CLUB_CODE = process.env.CLUB_CODE || '';
const httpError = F.httpError;

// ---------- Auth helpers ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, userId);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 60}${secure}`);
}

app.use((req, res, next) => {
  const token = readCookie(req, 'sid');
  req.user = token
    ? one(
        `SELECT u.id, u.username, u.display_name, u.is_admin FROM sessions s
           JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
        token
      )
    : null;
  next();
});

const needUser = (req, res, next) => (req.user ? next() : next(httpError(401, 'Please log in.')));
const needAdmin = (req, res, next) =>
  req.user?.is_admin ? next() : next(httpError(403, 'Only a commissioner (admin) can do that.'));

const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (err) {
    next(err);
  }
};

function requireSport(sport) {
  if (!SPORTS[sport]) throw httpError(404, 'Unknown sport.');
  return sport;
}

function isCommish(user, league) {
  return !!user && (user.is_admin || league.created_by === user.id);
}

function cleanText(v, max = 80) {
  return String(v ?? '').trim().slice(0, max);
}

// ---------- Meta & auth ----------

app.get('/api/meta', (req, res) => {
  res.json({
    sports: Object.values(SPORTS),
    needsClubCode: !!CLUB_CODE,
    firstUser: one('SELECT COUNT(*) AS c FROM users').c === 0,
  });
});

app.get('/api/me', (req, res) => res.json({ user: req.user }));

app.post('/api/auth/register', wrap((req, res) => {
  const username = cleanText(req.body.username, 32).toLowerCase();
  const display = cleanText(req.body.display_name, 60) || username;
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw httpError(400, 'Usernames are 3 to 32 letters, numbers, dots, dashes or underscores.');
  if (password.length < 6) throw httpError(400, 'Passwords need at least 6 characters.');
  if (CLUB_CODE && req.body.club_code !== CLUB_CODE) throw httpError(403, 'That club code is not right. Ask a commissioner for it.');
  if (one('SELECT 1 FROM users WHERE username = ?', username)) throw httpError(409, 'That username is taken.');
  const first = one('SELECT COUNT(*) AS c FROM users').c === 0;
  const { lastInsertRowid } = run(
    'INSERT INTO users (username, display_name, pass_hash, is_admin) VALUES (?, ?, ?, ?)',
    username, display, hashPassword(password), first ? 1 : 0
  );
  startSession(res, lastInsertRowid);
  return { ok: true, admin: first };
}));

app.post('/api/auth/login', wrap((req, res) => {
  const user = one('SELECT * FROM users WHERE username = ?', cleanText(req.body.username, 32).toLowerCase());
  if (!user || !checkPassword(String(req.body.password || ''), user.pass_hash)) {
    throw httpError(401, 'Wrong username or password.');
  }
  startSession(res, user.id);
  return { ok: true };
}));

app.post('/api/auth/logout', wrap((req, res) => {
  const token = readCookie(req, 'sid');
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  return { ok: true };
}));

app.put('/api/me', needUser, wrap((req) => {
  if (req.body.display_name !== undefined) {
    const name = cleanText(req.body.display_name, 60);
    if (!name) throw httpError(400, 'Display name cannot be empty.');
    run('UPDATE users SET display_name = ? WHERE id = ?', name, req.user.id);
  }
  if (req.body.new_password) {
    const user = one('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!checkPassword(String(req.body.current_password || ''), user.pass_hash)) throw httpError(400, 'Your current password is not right.');
    if (String(req.body.new_password).length < 6) throw httpError(400, 'Passwords need at least 6 characters.');
    run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(String(req.body.new_password)), req.user.id);
  }
  return { ok: true };
}));

// ---------- Users (admin) ----------

app.get('/api/users', needAdmin, wrap(() =>
  all('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY display_name')
));

app.put('/api/users/:id', needAdmin, wrap((req) => {
  const id = Number(req.params.id);
  if (req.body.is_admin !== undefined) {
    if (id === req.user.id && !req.body.is_admin) throw httpError(400, 'You cannot remove your own admin access.');
    run('UPDATE users SET is_admin = ? WHERE id = ?', req.body.is_admin ? 1 : 0, id);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6) throw httpError(400, 'Passwords need at least 6 characters.');
    run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(String(req.body.password)), id);
    run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  return { ok: true };
}));

// ---------- Home ----------

app.get('/api/home', needUser, wrap((req) => {
  const myTeams = all(
    `SELECT lt.id AS team_id, lt.name AS team_name, l.id AS league_id, l.name AS league_name, l.sport, l.status
       FROM league_teams lt JOIN leagues l ON l.id = lt.league_id WHERE lt.user_id = ? ORDER BY l.id DESC`,
    req.user.id
  ).map((t) => {
    const league = F.getLeague(t.league_id);
    const row = F.standings(league).find((s) => s.id === t.team_id);
    return { ...t, rank: row?.rank, points: row?.points, teams: F.leagueTeams(league.id).length };
  });
  const gameSql = `SELECT g.*, h.name AS home_name, a.name AS away_name FROM games g
      LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams a ON a.id = g.away_team_id`;
  return {
    myTeams,
    upcoming: all(`${gameSql} WHERE g.status != 'final' ORDER BY g.starts_at LIMIT 8`),
    recent: all(`${gameSql} WHERE g.status = 'final' ORDER BY g.starts_at DESC LIMIT 8`),
    leagues: all('SELECT id, sport, name, season, status FROM leagues ORDER BY id DESC'),
  };
}));

// ---------- Sports, teams, athletes ----------

app.get('/api/sports/:sport', needUser, wrap((req) => {
  const sport = requireSport(req.params.sport);
  const teams = all('SELECT * FROM im_teams WHERE sport = ? ORDER BY is_club DESC, name', sport);
  const games = all(
    `SELECT g.*, h.name AS home_name, a.name AS away_name FROM games g
       LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams a ON a.id = g.away_team_id
      WHERE g.sport = ? ORDER BY g.week, g.starts_at`,
    sport
  );
  // Win/loss records from final games.
  const records = Object.fromEntries(teams.map((t) => [t.id, { w: 0, l: 0, t: 0, pf: 0, pa: 0 }]));
  for (const g of games) {
    if (g.status !== 'final' || g.home_score == null || g.away_score == null) continue;
    const h = records[g.home_team_id], a = records[g.away_team_id];
    if (h) { h.pf += g.home_score; h.pa += g.away_score; }
    if (a) { a.pf += g.away_score; a.pa += g.home_score; }
    if (g.home_score === g.away_score) { if (h) h.t++; if (a) a.t++; }
    else if (g.home_score > g.away_score) { if (h) h.w++; if (a) a.l++; }
    else { if (h) h.l++; if (a) a.w++; }
  }
  return {
    sport: SPORTS[sport],
    teams: teams.map((t) => ({ ...t, record: records[t.id] })),
    games,
    athletes: F.athletesWithPoints(sport),
    leagues: all('SELECT id, name, season, status FROM leagues WHERE sport = ? ORDER BY id DESC', sport),
  };
}));

app.get('/api/athletes/:id', needUser, wrap((req) => {
  const a = one(
    `SELECT a.*, t.name AS team_name FROM athletes a LEFT JOIN im_teams t ON t.id = a.im_team_id WHERE a.id = ?`,
    req.params.id
  );
  if (!a) throw httpError(404, 'Player not found.');
  const scoring = defaultScoring(a.sport);
  const log = all(
    `SELECT g.id AS game_id, g.week, g.starts_at, g.status, gs.stats, h.name AS home_name, aw.name AS away_name,
            g.home_score, g.away_score
       FROM game_stats gs JOIN games g ON g.id = gs.game_id
       LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams aw ON aw.id = g.away_team_id
      WHERE gs.athlete_id = ? ORDER BY g.starts_at`,
    a.id
  ).map((r) => {
    const stats = JSON.parse(r.stats);
    return { ...r, stats, points: scoreLine(stats, scoring) };
  });
  const owners = all(
    `SELECT l.id AS league_id, l.name AS league_name, lt.name AS team_name FROM roster r
       JOIN leagues l ON l.id = r.league_id JOIN league_teams lt ON lt.id = r.league_team_id
      WHERE r.athlete_id = ? AND r.dropped_at IS NULL`,
    a.id
  );
  return { athlete: a, sport: SPORTS[a.sport], log, owners };
}));

app.post('/api/teams', needAdmin, wrap((req) => {
  const sport = requireSport(req.body.sport);
  const name = cleanText(req.body.name);
  if (!name) throw httpError(400, 'Team name is required.');
  if (one('SELECT 1 FROM im_teams WHERE sport = ? AND name = ?', sport, name)) throw httpError(409, 'That team already exists in this sport.');
  const r = run('INSERT INTO im_teams (sport, name, is_club) VALUES (?, ?, ?)', sport, name, req.body.is_club ? 1 : 0);
  return { id: Number(r.lastInsertRowid) };
}));

app.put('/api/teams/:id', needAdmin, wrap((req) => {
  const name = cleanText(req.body.name);
  if (!name) throw httpError(400, 'Team name is required.');
  run('UPDATE im_teams SET name = ?, is_club = ? WHERE id = ?', name, req.body.is_club ? 1 : 0, req.params.id);
  return { ok: true };
}));

app.delete('/api/teams/:id', needAdmin, wrap((req) => {
  run('DELETE FROM im_teams WHERE id = ?', req.params.id);
  return { ok: true };
}));

function teamIdFor(sport, teamName) {
  const name = cleanText(teamName);
  if (!name) return null;
  const found = one('SELECT id FROM im_teams WHERE sport = ? AND name = ? COLLATE NOCASE', sport, name);
  if (found) return found.id;
  return Number(run('INSERT INTO im_teams (sport, name) VALUES (?, ?)', sport, name).lastInsertRowid);
}

app.post('/api/athletes', needAdmin, wrap((req) => {
  const sport = requireSport(req.body.sport);
  const name = cleanText(req.body.name);
  if (!name) throw httpError(400, 'Player name is required.');
  const teamId = req.body.im_team_id ? Number(req.body.im_team_id) : teamIdFor(sport, req.body.team_name);
  const r = run(
    'INSERT INTO athletes (sport, name, position, im_team_id) VALUES (?, ?, ?, ?)',
    sport, name, cleanText(req.body.position, 10) || null, teamId
  );
  return { id: Number(r.lastInsertRowid) };
}));

// Paste a list: one player per line as "Name, Position, Team". Position and team are optional.
app.post('/api/athletes/bulk', needAdmin, wrap((req) => {
  const sport = requireSport(req.body.sport);
  const lines = String(req.body.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let added = 0;
  tx(() => {
    for (const line of lines) {
      const [name, position, team] = line.split(/\t|,/).map((s) => s.trim());
      if (!name) continue;
      run(
        'INSERT INTO athletes (sport, name, position, im_team_id) VALUES (?, ?, ?, ?)',
        sport, cleanText(name), cleanText(position, 10) || null, teamIdFor(sport, team)
      );
      added++;
    }
  });
  return { added };
}));

app.put('/api/athletes/:id', needAdmin, wrap((req) => {
  const a = one('SELECT * FROM athletes WHERE id = ?', req.params.id);
  if (!a) throw httpError(404, 'Player not found.');
  run(
    'UPDATE athletes SET name = ?, position = ?, im_team_id = ?, active = ? WHERE id = ?',
    cleanText(req.body.name ?? a.name) || a.name,
    req.body.position !== undefined ? cleanText(req.body.position, 10) || null : a.position,
    req.body.im_team_id !== undefined ? (req.body.im_team_id ? Number(req.body.im_team_id) : null) : a.im_team_id,
    req.body.active !== undefined ? (req.body.active ? 1 : 0) : a.active,
    a.id
  );
  return { ok: true };
}));

app.delete('/api/athletes/:id', needAdmin, wrap((req) => {
  // Players who were drafted keep their history; they are just hidden from the pool.
  const used = one('SELECT 1 FROM roster WHERE athlete_id = ?', req.params.id) ||
    one('SELECT 1 FROM game_stats WHERE athlete_id = ?', req.params.id);
  if (used) run('UPDATE athletes SET active = 0 WHERE id = ?', req.params.id);
  else run('DELETE FROM athletes WHERE id = ?', req.params.id);
  return { ok: true, archived: !!used };
}));

// ---------- Games ----------

function gameFields(body, sport) {
  const score = (v) => (v === '' || v == null ? null : Math.max(0, Math.round(Number(v)) || 0));
  const status = ['scheduled', 'live', 'final'].includes(body.status) ? body.status : 'scheduled';
  return {
    week: Math.max(1, Math.round(Number(body.week)) || 1),
    starts_at: body.starts_at ? new Date(body.starts_at).toISOString() : null,
    location: cleanText(body.location) || null,
    home_team_id: body.home_team_id ? Number(body.home_team_id) : null,
    away_team_id: body.away_team_id ? Number(body.away_team_id) : null,
    home_score: score(body.home_score),
    away_score: score(body.away_score),
    status,
    notes: cleanText(body.notes, 500) || null,
    sport,
  };
}

app.post('/api/games', needAdmin, wrap((req) => {
  const sport = requireSport(req.body.sport);
  const g = gameFields(req.body, sport);
  if (!g.home_team_id || !g.away_team_id) throw httpError(400, 'Pick both teams.');
  if (g.home_team_id === g.away_team_id) throw httpError(400, 'A team cannot play itself.');
  const r = run(
    `INSERT INTO games (sport, week, starts_at, location, home_team_id, away_team_id, home_score, away_score, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sport, g.week, g.starts_at, g.location, g.home_team_id, g.away_team_id, g.home_score, g.away_score, g.status, g.notes
  );
  return { id: Number(r.lastInsertRowid) };
}));

app.get('/api/games/:id', needUser, wrap((req) => {
  const game = one(
    `SELECT g.*, h.name AS home_name, a.name AS away_name FROM games g
       LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams a ON a.id = g.away_team_id
      WHERE g.id = ?`,
    req.params.id
  );
  if (!game) throw httpError(404, 'Game not found.');
  const scoring = defaultScoring(game.sport);
  const statRows = Object.fromEntries(
    all('SELECT athlete_id, stats FROM game_stats WHERE game_id = ?', game.id).map((r) => [r.athlete_id, JSON.parse(r.stats)])
  );
  // Box score: everyone on either roster, plus anyone else with a stat line in this game.
  const players = all(
    `SELECT a.id, a.name, a.position, a.im_team_id FROM athletes a
      WHERE a.sport = ? AND (a.im_team_id IN (?, ?) OR a.id IN (SELECT athlete_id FROM game_stats WHERE game_id = ?))
      ORDER BY a.name`,
    game.sport, game.home_team_id, game.away_team_id, game.id
  ).map((p) => ({ ...p, stats: statRows[p.id] || null, points: statRows[p.id] ? scoreLine(statRows[p.id], scoring) : null }));
  const teams = all('SELECT * FROM im_teams WHERE sport = ? ORDER BY name', game.sport);
  return { game, sport: SPORTS[game.sport], players, teams };
}));

app.put('/api/games/:id', needAdmin, wrap((req) => {
  const existing = one('SELECT * FROM games WHERE id = ?', req.params.id);
  if (!existing) throw httpError(404, 'Game not found.');
  const g = gameFields({ ...existing, ...req.body }, existing.sport);
  run(
    `UPDATE games SET week = ?, starts_at = ?, location = ?, home_team_id = ?, away_team_id = ?, home_score = ?,
            away_score = ?, status = ?, notes = ? WHERE id = ?`,
    g.week, g.starts_at, g.location, g.home_team_id, g.away_team_id, g.home_score, g.away_score, g.status, g.notes, existing.id
  );
  return { ok: true };
}));

app.delete('/api/games/:id', needAdmin, wrap((req) => {
  run('DELETE FROM games WHERE id = ?', req.params.id);
  return { ok: true };
}));

// Save the whole box score at once. Rows with no numbers are removed.
app.put('/api/games/:id/stats', needAdmin, wrap((req) => {
  const game = one('SELECT * FROM games WHERE id = ?', req.params.id);
  if (!game) throw httpError(404, 'Game not found.');
  const keys = SPORTS[game.sport].stats.map(([k]) => k);
  tx(() => {
    for (const row of req.body.rows || []) {
      const stats = {};
      for (const k of keys) {
        const v = Number(row.stats?.[k]);
        if (Number.isFinite(v) && v !== 0) stats[k] = v;
      }
      if (Object.keys(stats).length === 0) {
        run('DELETE FROM game_stats WHERE game_id = ? AND athlete_id = ?', game.id, row.athlete_id);
      } else {
        run(
          `INSERT INTO game_stats (game_id, athlete_id, stats) VALUES (?, ?, ?)
           ON CONFLICT (game_id, athlete_id) DO UPDATE SET stats = excluded.stats`,
          game.id, row.athlete_id, JSON.stringify(stats)
        );
      }
    }
  });
  return { ok: true };
}));

// ---------- Leagues ----------

app.post('/api/leagues', needAdmin, wrap((req) => {
  const sport = requireSport(req.body.sport);
  const name = cleanText(req.body.name) || `${SPORTS[sport].name} League`;
  const r = run(
    'INSERT INTO leagues (sport, name, season, roster_size, pick_seconds, scoring, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sport, name, cleanText(req.body.season, 30) || null,
    Math.min(20, Math.max(1, Number(req.body.roster_size) || SPORTS[sport].rosterSize)),
    Math.max(0, Number(req.body.pick_seconds ?? 90) || 0),
    JSON.stringify(defaultScoring(sport)), req.user.id
  );
  return { id: Number(r.lastInsertRowid) };
}));

function loadLeague(req) {
  const league = F.getLeague(req.params.id);
  if (!league) throw httpError(404, 'League not found.');
  return league;
}

app.get('/api/leagues/:id', needUser, wrap((req) => {
  F.processExpiredPicks(Number(req.params.id));
  const league = loadLeague(req);
  const table = F.standings(league);
  const mine = table.find((t) => t.user_id === req.user.id) || null;
  return {
    league,
    sport: SPORTS[league.sport],
    standings: table,
    myTeam: mine,
    isCommish: isCommish(req.user, league),
    freeAgents: league.status === 'active' ? F.availableAthletes(league).sort((a, b) => b.points - a.points) : [],
    activity: all('SELECT * FROM activity WHERE league_id = ? ORDER BY id DESC LIMIT 30', league.id),
    weeks: [...new Set(all('SELECT DISTINCT week FROM games WHERE sport = ? ORDER BY week', league.sport).map((r) => r.week))],
  };
}));

app.put('/api/leagues/:id', needUser, wrap((req) => {
  const league = loadLeague(req);
  if (!isCommish(req.user, league)) throw httpError(403, 'Only the commissioner can change league settings.');
  const name = cleanText(req.body.name ?? league.name) || league.name;
  const season = req.body.season !== undefined ? cleanText(req.body.season, 30) || null : league.season;
  let roster = league.roster_size;
  if (req.body.roster_size !== undefined) {
    if (league.status !== 'setup') throw httpError(400, 'Roster size is locked once the draft starts.');
    roster = Math.min(20, Math.max(1, Number(req.body.roster_size) || roster));
  }
  const pick = req.body.pick_seconds !== undefined ? Math.max(0, Number(req.body.pick_seconds) || 0) : league.pick_seconds;
  let scoring = league.scoring;
  if (req.body.scoring) {
    scoring = {};
    for (const [k] of SPORTS[league.sport].stats) scoring[k] = Number(req.body.scoring[k]) || 0;
  }
  let status = league.status;
  if (req.body.status === 'complete' && league.status === 'active') status = 'complete';
  if (req.body.status === 'active' && league.status === 'complete') status = 'active';
  run(
    'UPDATE leagues SET name = ?, season = ?, roster_size = ?, pick_seconds = ?, scoring = ?, status = ? WHERE id = ?',
    name, season, roster, pick, JSON.stringify(scoring), status, league.id
  );
  return { ok: true };
}));

app.delete('/api/leagues/:id', needAdmin, wrap((req) => {
  run('DELETE FROM leagues WHERE id = ?', req.params.id);
  return { ok: true };
}));

app.post('/api/leagues/:id/join', needUser, wrap((req) => {
  const league = loadLeague(req);
  if (league.status !== 'setup') throw httpError(400, 'This league has already drafted.');
  if (one('SELECT 1 FROM league_teams WHERE league_id = ? AND user_id = ?', league.id, req.user.id)) {
    throw httpError(409, 'You already have a team in this league.');
  }
  const name = cleanText(req.body.name, 40) || `${req.user.display_name}'s team`;
  const slot = one('SELECT COALESCE(MAX(draft_slot), 0) + 1 AS s FROM league_teams WHERE league_id = ?', league.id).s;
  run('INSERT INTO league_teams (league_id, user_id, name, draft_slot) VALUES (?, ?, ?, ?)', league.id, req.user.id, name, slot);
  F.log(league.id, `${req.user.display_name} joined as ${name}`);
  return { ok: true };
}));

app.put('/api/leagues/:id/teams/:teamId', needUser, wrap((req) => {
  const league = loadLeague(req);
  const team = one('SELECT * FROM league_teams WHERE id = ? AND league_id = ?', req.params.teamId, league.id);
  if (!team) throw httpError(404, 'Team not found.');
  if (team.user_id !== req.user.id && !isCommish(req.user, league)) throw httpError(403, 'That is not your team.');
  const name = cleanText(req.body.name, 40);
  if (!name) throw httpError(400, 'Team name cannot be empty.');
  run('UPDATE league_teams SET name = ? WHERE id = ?', name, team.id);
  return { ok: true };
}));

app.delete('/api/leagues/:id/teams/:teamId', needUser, wrap((req) => {
  const league = loadLeague(req);
  const team = one('SELECT * FROM league_teams WHERE id = ? AND league_id = ?', req.params.teamId, league.id);
  if (!team) throw httpError(404, 'Team not found.');
  if (team.user_id !== req.user.id && !isCommish(req.user, league)) throw httpError(403, 'That is not your team.');
  if (league.status !== 'setup') throw httpError(400, 'Teams cannot leave after the draft starts.');
  run('DELETE FROM league_teams WHERE id = ?', team.id);
  F.log(league.id, `${team.name} left the league`);
  return { ok: true };
}));

app.post('/api/leagues/:id/order', needUser, wrap((req) => {
  const league = loadLeague(req);
  if (!isCommish(req.user, league)) throw httpError(403, 'Only the commissioner can set the draft order.');
  if (league.status !== 'setup') throw httpError(400, 'The draft order is locked once the draft starts.');
  let ids = F.draftOrder(league.id).map((t) => t.id);
  if (req.body.randomize) {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
  } else if (Array.isArray(req.body.team_ids)) {
    const given = req.body.team_ids.map(Number);
    if (given.length !== ids.length || !ids.every((id) => given.includes(id))) throw httpError(400, 'The order must list every team once.');
    ids = given;
  }
  tx(() => ids.forEach((id, i) => run('UPDATE league_teams SET draft_slot = ? WHERE id = ?', i + 1, id)));
  return { ok: true };
}));

// ---------- Draft ----------

app.post('/api/leagues/:id/draft/start', needUser, wrap((req) => {
  const league = loadLeague(req);
  if (!isCommish(req.user, league)) throw httpError(403, 'Only the commissioner can start the draft.');
  if (league.status !== 'setup') throw httpError(400, 'The draft already started.');
  const teams = F.draftOrder(league.id).length;
  if (teams < 2) throw httpError(400, 'You need at least 2 teams to draft.');
  const pool = one('SELECT COUNT(*) AS c FROM athletes WHERE sport = ? AND active = 1', league.sport).c;
  if (pool === 0) throw httpError(400, 'Add players to this sport before drafting.');
  run(`UPDATE leagues SET status = 'drafting', clock_started_at = ?, draft_paused = 0 WHERE id = ?`, Date.now(), league.id);
  F.log(league.id, 'The draft has started!');
  return { ok: true };
}));

app.post('/api/leagues/:id/draft/pause', needUser, wrap((req) => {
  F.processExpiredPicks(Number(req.params.id));
  const league = loadLeague(req);
  if (!isCommish(req.user, league)) throw httpError(403, 'Only the commissioner can pause the draft.');
  if (league.status !== 'drafting') throw httpError(400, 'The draft is not running.');
  if (req.body.paused) {
    const remaining = Math.max(0, league.clock_started_at + league.pick_seconds * 1000 - Date.now());
    run('UPDATE leagues SET draft_paused = 1, paused_remaining = ? WHERE id = ?', remaining, league.id);
  } else {
    const remaining = league.paused_remaining ?? league.pick_seconds * 1000;
    const start = Date.now() - (league.pick_seconds * 1000 - remaining);
    run('UPDATE leagues SET draft_paused = 0, paused_remaining = NULL, clock_started_at = ? WHERE id = ?', start, league.id);
  }
  return { ok: true };
}));

app.get('/api/leagues/:id/draft', needUser, wrap((req) => {
  F.processExpiredPicks(Number(req.params.id));
  const league = loadLeague(req);
  const order = F.draftOrder(league.id).map((t) => ({
    ...t, owner_name: one('SELECT display_name FROM users WHERE id = ?', t.user_id)?.display_name,
  }));
  const picks = all(
    `SELECT p.*, a.name AS athlete_name, a.position, t.name AS im_team FROM draft_picks p
       JOIN athletes a ON a.id = p.athlete_id LEFT JOIN im_teams t ON t.id = a.im_team_id
      WHERE p.league_id = ? ORDER BY p.pick_no`,
    league.id
  );
  const me = order.find((t) => t.user_id === req.user.id) || null;
  return {
    league: { id: league.id, name: league.name, sport: league.sport, status: league.status, roster_size: league.roster_size,
      pick_seconds: league.pick_seconds, draft_paused: league.draft_paused },
    sport: SPORTS[league.sport],
    order,
    picks,
    state: F.draftState(league),
    available: league.status === 'drafting' ? F.availableAthletes(league).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)) : [],
    myTeamId: me?.id || null,
    isCommish: isCommish(req.user, league),
    serverNow: Date.now(),
  };
}));

app.post('/api/leagues/:id/draft/pick', needUser, wrap((req) => {
  const id = Number(req.params.id);
  F.processExpiredPicks(id);
  return tx(() => {
    const league = F.getLeague(id);
    if (!league) throw httpError(404, 'League not found.');
    if (league.status !== 'drafting') throw httpError(400, 'The draft is not running.');
    if (league.draft_paused) throw httpError(400, 'The draft is paused.');
    const state = F.draftState(league);
    if (!state.onClock) throw httpError(400, 'The draft is not waiting on a pick.');
    if (state.onClock.user_id !== req.user.id && !isCommish(req.user, league)) {
      throw httpError(403, `It is ${state.onClock.name}'s pick, not yours.`);
    }
    return F.makePick(league, Number(req.body.athlete_id));
  });
}));

// ---------- Free agents ----------

app.post('/api/leagues/:id/transactions', needUser, wrap((req) => {
  const league = loadLeague(req);
  if (league.status !== 'active') throw httpError(400, 'Adds and drops open after the draft.');
  const team = one('SELECT * FROM league_teams WHERE league_id = ? AND user_id = ?', league.id, req.user.id);
  if (!team) throw httpError(403, 'You do not have a team in this league.');
  const addId = req.body.add_id ? Number(req.body.add_id) : null;
  const dropId = req.body.drop_id ? Number(req.body.drop_id) : null;
  const now = new Date().toISOString();
  return tx(() => {
    const roster = all('SELECT * FROM roster WHERE league_team_id = ? AND dropped_at IS NULL', team.id);
    let dropped = null, added = null;
    if (dropId) {
      const entry = roster.find((r) => r.athlete_id === dropId);
      if (!entry) throw httpError(400, 'That player is not on your roster.');
      run('UPDATE roster SET dropped_at = ? WHERE id = ?', now, entry.id);
      dropped = one('SELECT name FROM athletes WHERE id = ?', dropId).name;
    }
    if (addId) {
      if (roster.length - (dropId ? 1 : 0) >= league.roster_size) throw httpError(400, 'Your roster is full. Drop someone to add a player.');
      const athlete = one('SELECT * FROM athletes WHERE id = ? AND sport = ? AND active = 1', addId, league.sport);
      if (!athlete) throw httpError(400, 'That player is not available.');
      if (one('SELECT 1 FROM roster WHERE league_id = ? AND athlete_id = ? AND dropped_at IS NULL', league.id, addId)) {
        throw httpError(409, `${athlete.name} is already on a team.`);
      }
      run('INSERT INTO roster (league_id, league_team_id, athlete_id, acquired_at, how) VALUES (?, ?, ?, ?, ?)',
        league.id, team.id, addId, now, 'free agent');
      added = athlete.name;
    }
    if (!added && !dropped) throw httpError(400, 'Pick a player to add or drop.');
    F.log(league.id, `${team.name}${added ? ` added ${added}` : ''}${added && dropped ? ' and' : ''}${dropped ? ` dropped ${dropped}` : ''}`);
    return { ok: true };
  });
}));

// ---------- Static app & errors ----------

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on the server.' });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Chi Lambda Phi Fantasy running on http://localhost:${PORT}`));
}

module.exports = app;
