const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { one, all, run, tx } = require('./db');
const { SPORTS, defaultScoring } = require('./sports');
const F = require('./fantasy');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const CLUB_CODE = process.env.CLUB_CODE || '';
// Google sign-in turns on when both of these are set. See README "Google sign-in".
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
// Google accounts with these emails are made admins every time they sign in.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const httpError = F.httpError;

// ---------- Auth helpers ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Accounts made through Google have no password until they set one.
const NO_PASSWORD = '!';

function checkPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
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
        `SELECT u.id, u.username, u.display_name, u.is_admin, u.email,
                u.pass_hash != '${NO_PASSWORD}' AS has_password FROM sessions s
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
    google: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
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

// ---------- Google sign-in (OAuth 2.0 authorization code flow) ----------

function publicUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function authFail(res, message) {
  res.redirect(`/?auth_error=${encodeURIComponent(message)}#/login`);
}

// Pick a free username from the email, like "jp.freri" or "jp.freri2".
function usernameFrom(email) {
  const base = (email.split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '') || 'member').slice(0, 28).padEnd(3, '0');
  let name = base;
  for (let n = 2; one('SELECT 1 FROM users WHERE username = ?', name); n++) name = `${base}${n}`;
  return name;
}

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return authFail(res, 'Google sign-in is not set up on this server.');
  const state = crypto.randomBytes(24).toString('hex');
  const codeOk = !CLUB_CODE || req.query.club_code === CLUB_CODE ? 1 : 0;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `g_state=${state}.${codeOk}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${secure}`);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${publicUrl(req)}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    const [state, codeOk] = (readCookie(req, 'g_state') || '').split('.');
    res.setHeader('Set-Cookie', 'g_state=; HttpOnly; Path=/auth; Max-Age=0');
    if (req.query.error) return authFail(res, 'Google sign-in was cancelled.');
    if (!state || req.query.state !== state || !req.query.code) return authFail(res, 'That sign-in link expired. Try again.');

    // The ID token comes straight from Google's token endpoint over HTTPS, so its claims can be read without
    // checking the signature (OpenID Connect Core 3.1.3.7). The audience, issuer and expiry are still checked.
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${publicUrl(req)}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokens.id_token) return authFail(res, 'Google did not accept the sign-in. Try again.');
    const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1] || '', 'base64url').toString() || '{}');
    const issuerOk = ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || process.env.GOOGLE_TOKEN_URL;
    if (claims.aud !== GOOGLE_CLIENT_ID || !issuerOk || !(claims.exp * 1000 > Date.now()) || !claims.sub) {
      return authFail(res, 'Google sign-in could not be verified.');
    }
    if (!claims.email || claims.email_verified === false || claims.email_verified === 'false') {
      return authFail(res, 'Your Google account needs a verified email.');
    }
    const email = String(claims.email).toLowerCase();
    const makeAdmin = ADMIN_EMAILS.includes(email);

    // Signed in already: link Google to this account. Otherwise find the linked account, or make a new one.
    let user = req.user ? one('SELECT * FROM users WHERE id = ?', req.user.id) : one('SELECT * FROM users WHERE google_sub = ?', claims.sub);
    if (req.user) {
      const other = one('SELECT id FROM users WHERE google_sub = ? AND id != ?', claims.sub, req.user.id);
      if (other) return authFail(res, 'That Google account is already linked to another member.');
    }
    if (!user) {
      if (!makeAdmin && CLUB_CODE && codeOk !== '1') return authFail(res, 'New members need the club code. Enter it on the sign-up page, then use Google.');
      const first = one('SELECT COUNT(*) AS c FROM users').c === 0;
      const { lastInsertRowid } = run(
        'INSERT INTO users (username, display_name, pass_hash, is_admin) VALUES (?, ?, ?, ?)',
        usernameFrom(email), cleanText(claims.name, 60) || email.split('@')[0], NO_PASSWORD, first ? 1 : 0
      );
      user = one('SELECT * FROM users WHERE id = ?', lastInsertRowid);
    }
    if (user.bot) return authFail(res, 'That account cannot sign in.');
    run('UPDATE users SET google_sub = ?, email = ?, is_admin = MAX(is_admin, ?) WHERE id = ?', claims.sub, email, makeAdmin ? 1 : 0, user.id);
    if (!req.user) startSession(res, user.id);
    else res.removeHeader('Set-Cookie');
    res.redirect(req.user ? '/#/account' : '/#/');
  } catch (err) {
    next(err);
  }
});

app.put('/api/me', needUser, wrap((req) => {
  if (req.body.display_name !== undefined) {
    const name = cleanText(req.body.display_name, 60);
    if (!name) throw httpError(400, 'Display name cannot be empty.');
    run('UPDATE users SET display_name = ? WHERE id = ?', name, req.user.id);
  }
  if (req.body.new_password) {
    const user = one('SELECT * FROM users WHERE id = ?', req.user.id);
    if (user.pass_hash !== NO_PASSWORD && !checkPassword(String(req.body.current_password || ''), user.pass_hash)) throw httpError(400, 'Your current password is not right.');
    if (String(req.body.new_password).length < 6) throw httpError(400, 'Passwords need at least 6 characters.');
    run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(String(req.body.new_password)), req.user.id);
  }
  return { ok: true };
}));

// ---------- Users (admin) ----------

app.get('/api/users', needAdmin, wrap(() =>
  all('SELECT id, username, display_name, is_admin, bot, created_at FROM users ORDER BY bot IS NOT NULL, display_name')
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
    const view = F.leagueView(league);
    const row = view.teams.find((s) => s.id === t.team_id);
    const games = [...view.matchups, ...(view.playoffs?.rounds.flatMap((r) => r.games) || [])];
    const m = games.find((g) => g.week === view.currentWeek && (g.home_team_id === t.team_id || g.away_team_id === t.team_id));
    const opp = m && view.teams.find((x) => x.id === (m.home_team_id === t.team_id ? m.away_team_id : m.home_team_id));
    return {
      ...t, rank: row?.rank, points: row?.points, w: row?.w, l: row?.l, ties: row?.t, teams: view.teams.length,
      week: view.currentWeek, champion: league.status === 'complete' ? view.champion : null,
      matchup: m ? {
        label: m.label || null, state: m.state, opponent: opp?.name || 'TBD',
        mine: m.home_team_id === t.team_id ? m.home_points : m.away_points,
        theirs: m.home_team_id === t.team_id ? m.away_points : m.home_points,
        win_chance: m.prediction ? (m.home_team_id === t.team_id ? m.prediction.home_win : 1 - m.prediction.home_win) : null,
      } : null,
      round_by: league.round_by,
    };
  });
  const clubGame = '(h.is_club = 1 OR a.is_club = 1)';
  const gameSql = `SELECT g.*, h.name AS home_name, a.name AS away_name FROM games g
      LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams a ON a.id = g.away_team_id`;
  return {
    myTeams,
    upcoming: all(`${gameSql} WHERE g.status != 'final' AND ${clubGame} ORDER BY g.starts_at LIMIT 8`),
    recent: all(`${gameSql} WHERE g.status = 'final' AND ${clubGame} ORDER BY g.starts_at DESC LIMIT 8`),
    leagues: all('SELECT id, sport, name, season, status FROM leagues ORDER BY id DESC'),
  };
}));

// ---------- Sports, teams, athletes ----------

app.get('/api/sports/:sport', needUser, wrap((req) => {
  const sport = requireSport(req.params.sport);
  const teams = all('SELECT * FROM im_teams WHERE sport = ? ORDER BY is_club DESC, name', sport);
  const games = all(
    `SELECT g.*, h.name AS home_name, a.name AS away_name, (COALESCE(h.is_club, 0) OR COALESCE(a.is_club, 0)) AS club_game,
            (SELECT COUNT(*) FROM game_stats WHERE game_id = g.id) AS stat_lines
       FROM games g LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams a ON a.id = g.away_team_id
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
  );
  const lines = Object.fromEntries(F.statLinesFor('gs.athlete_id = ?', a.id).map((l) => [l.game_id, l]));
  for (const r of log) {
    const line = lines[r.game_id];
    Object.assign(r, { stats: line.stats, mult: line.mult, points: F.linePoints(line, scoring) });
  }
  const owners = all(
    `SELECT l.id AS league_id, l.name AS league_name, lt.name AS team_name FROM roster r
       JOIN leagues l ON l.id = r.league_id JOIN league_teams lt ON lt.id = r.league_team_id
      WHERE r.athlete_id = ? AND r.dropped_at IS NULL`,
    a.id
  );
  // ESPN's player card numbers: season total and average, projected average, and how many fantasy
  // teams roster and start him across this sport's leagues.
  const leagues = all(`SELECT * FROM leagues WHERE sport = ? AND status IN ('active', 'complete')`, a.sport);
  let rostered = 0, started = 0;
  for (const l of leagues) {
    const r = one('SELECT id FROM roster WHERE league_id = ? AND athlete_id = ? AND dropped_at IS NULL', l.id, a.id);
    if (!r) continue;
    rostered++;
    if (F.starterAt(F.lineupHistory(l.id), r.id)) started++;
  }
  const total = Math.round(log.reduce((sum, r) => sum + r.points, 0) * 100) / 100;
  const proj = F.playerProjections({ sport: a.sport, scoring }).perGame[a.id];
  const card = {
    total, games: log.length, avg: log.length ? Math.round((total / log.length) * 10) / 10 : 0,
    proj_avg: Math.round((proj?.est || 0) * 10) / 10,
    pct_rostered: leagues.length ? Math.round((rostered / leagues.length) * 100) : null,
    pct_started: leagues.length ? Math.round((started / leagues.length) * 100) : null,
    next_game: F.nextGames(a.sport)[a.im_team_id] || null,
  };
  return { athlete: a, sport: SPORTS[a.sport], log, owners, card };
}));

app.post('/api/teams', needAdmin, wrap((req) => {
  const sport = requireSport(req.body.sport);
  const name = cleanText(req.body.name);
  if (!name) throw httpError(400, 'Team name is required.');
  if (one('SELECT 1 FROM im_teams WHERE sport = ? AND name = ?', sport, name)) throw httpError(409, 'That team already exists in this sport.');
  const r = run(
    'INSERT INTO im_teams (sport, name, is_club, for_points, multiplier) VALUES (?, ?, ?, ?, ?)',
    sport, name, req.body.is_club ? 1 : 0, req.body.for_points === false ? 0 : 1, multiplier(req.body.multiplier ?? 1)
  );
  return { id: Number(r.lastInsertRowid) };
}));

const multiplier = (v) => Math.min(5, Math.max(0, Number(v) || 0));

app.put('/api/teams/:id', needAdmin, wrap((req) => {
  const t = one('SELECT * FROM im_teams WHERE id = ?', req.params.id);
  if (!t) throw httpError(404, 'Team not found.');
  const name = req.body.name !== undefined ? cleanText(req.body.name) : t.name;
  if (!name) throw httpError(400, 'Team name is required.');
  run(
    'UPDATE im_teams SET name = ?, is_club = ?, for_points = ?, multiplier = ? WHERE id = ?',
    name,
    req.body.is_club !== undefined ? (req.body.is_club ? 1 : 0) : t.is_club,
    req.body.for_points !== undefined ? (req.body.for_points ? 1 : 0) : t.for_points,
    req.body.multiplier !== undefined ? multiplier(req.body.multiplier) : t.multiplier,
    t.id
  );
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
  const lines = Object.fromEntries(F.statLinesFor('gs.game_id = ?', game.id).map((l) => [l.athlete_id, l]));
  // Box score: everyone on either roster, plus anyone else with a stat line in this game.
  const players = all(
    `SELECT a.id, a.name, a.position, a.im_team_id FROM athletes a
      WHERE a.sport = ? AND (a.im_team_id IN (?, ?) OR a.id IN (SELECT athlete_id FROM game_stats WHERE game_id = ?))
      ORDER BY a.name`,
    game.sport, game.home_team_id, game.away_team_id, game.id
  ).map((p) => ({ ...p, stats: lines[p.id]?.stats || null, mult: lines[p.id]?.mult ?? null,
    points: lines[p.id] ? F.linePoints(lines[p.id], scoring) : null }));
  const teams = all('SELECT * FROM im_teams WHERE sport = ? ORDER BY is_club DESC, name', game.sport);
  const side = (id) => teams.find((t) => t.id === id) || null;
  game.home_team = side(game.home_team_id);
  game.away_team = side(game.away_team_id);
  // Admins can add anyone from the sport to the box score (subs, players on other Chi teams).
  const shown = new Set(players.map((p) => p.id));
  const pool = req.user.is_admin
    ? all('SELECT id, name, position, im_team_id FROM athletes WHERE sport = ? AND active = 1 ORDER BY name', game.sport).filter((a) => !shown.has(a.id))
    : [];
  return { game, sport: SPORTS[game.sport], players, teams, pool };
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
  const by = roundBy(req.body.round_by);
  const po = playoffTeams(req.body.playoff_teams ?? 4);
  const r = run(
    `INSERT INTO leagues (sport, name, season, roster_size, pick_seconds, scoring, created_by, regular_weeks, playoff_teams, round_by, starters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sport, name, cleanText(req.body.season, 30) || null,
    Math.min(20, Math.max(1, Number(req.body.roster_size) || SPORTS[sport].rosterSize)),
    Math.max(0, Number(req.body.pick_seconds ?? 90) || 0),
    JSON.stringify(defaultScoring(sport)), req.user.id,
    req.body.regular_weeks ? clampWeeks(req.body.regular_weeks) : F.defaultRegularWeeks(sport, by, po), po, by,
    req.body.starters ? Math.max(1, Math.round(Number(req.body.starters)) || 1) : null
  );
  return { id: Number(r.lastInsertRowid) };
}));

const clampWeeks = (v) => Math.min(30, Math.max(1, Math.round(Number(v)) || 1));
const roundBy = (v) => (v === 'week' ? 'week' : 'game');
const playoffTeams = (v) => ([0, 2, 4].includes(Number(v)) ? Number(v) : 4);

// Lazy server-side work for a league: auto-pick for expired clocks, then let the bots act.
function tick(leagueId) {
  F.processExpiredPicks(leagueId);
  F.runBots(leagueId);
  const league = F.getLeague(leagueId);
  if (league) F.fixLineups(league);
}

// Admins can see which teams are bots; everyone else sees ordinary teams.
function markBots(req, leagueId, teams) {
  if (!req.user?.is_admin) return teams;
  const bots = Object.fromEntries(F.botTeams(leagueId).map((b) => [b.id, b.bot]));
  return teams.map((t) => ({ ...t, bot: bots[t.id] || null }));
}

// Free agents with ESPN's columns: season points, average, projected average and their next game.
function freeAgentList(league) {
  const P = F.playerProjections(league);
  const next = F.nextGames(league.sport);
  return F.availableAthletes(league).map((a) => ({
    ...a,
    avg: a.games ? Math.round((a.points / a.games) * 10) / 10 : 0,
    proj_avg: Math.round((P.perGame[a.id]?.est || 0) * 10) / 10,
    next_game: next[a.im_team_id] || null,
  })).sort((a, b) => b.proj_avg - a.proj_avg || b.points - a.points);
}

function loadLeague(req) {
  const league = F.getLeague(req.params.id);
  if (!league) throw httpError(404, 'League not found.');
  return league;
}

app.get('/api/leagues/:id', needUser, wrap((req) => {
  tick(Number(req.params.id));
  const league = loadLeague(req);
  const view = F.leagueView(league);
  view.teams = markBots(req, league.id, view.teams);
  const mine = view.teams.find((t) => t.user_id === req.user.id) || null;
  return {
    league,
    sport: SPORTS[league.sport],
    standings: view.teams,
    matchups: view.matchups,
    playoffs: view.playoffs,
    champion: view.champion,
    currentWeek: view.currentWeek,
    lastWeek: view.lastWeek,
    weekStates: view.weeks,
    roundBy: view.roundBy,
    aiRecord: view.aiRecord,
    power: view.power,
    records: view.records,
    starters: view.starters,
    myTeam: mine,
    isCommish: isCommish(req.user, league),
    freeAgents: league.status === 'active' ? freeAgentList(league) : [],
    activity: all('SELECT * FROM activity WHERE league_id = ? ORDER BY id DESC LIMIT 30', league.id),
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
  const playoffs = req.body.playoff_teams !== undefined ? playoffTeams(req.body.playoff_teams) : league.playoff_teams;
  const starters = req.body.starters !== undefined && req.body.starters !== ''
    ? Math.min(roster, Math.max(1, Math.round(Number(req.body.starters)) || 1)) : league.starters;
  const by = req.body.round_by !== undefined ? roundBy(req.body.round_by) : league.round_by;
  // Switching between game-night and weekly rounds resets the season length unless a new one is given.
  const asked = req.body.regular_weeks ? clampWeeks(req.body.regular_weeks) : league.regular_weeks;
  const regularWeeks = by !== league.round_by && asked === league.regular_weeks ? F.defaultRegularWeeks(league.sport, by, playoffs) : asked;
  let status = league.status;
  if (req.body.status === 'complete' && league.status === 'active') status = 'complete';
  if (req.body.status === 'active' && league.status === 'complete') status = 'active';
  run(
    `UPDATE leagues SET name = ?, season = ?, roster_size = ?, pick_seconds = ?, scoring = ?, status = ?,
            regular_weeks = ?, playoff_teams = ?, round_by = ?, starters = ? WHERE id = ?`,
    name, season, roster, pick, JSON.stringify(scoring), status, regularWeeks, playoffs, by, starters, league.id
  );
  // A new season length or round type means a new head-to-head schedule.
  if ((regularWeeks !== league.regular_weeks || by !== league.round_by) && ['active', 'complete'].includes(league.status)) {
    F.generateSchedule({ ...league, regular_weeks: regularWeeks });
    const unit = by === 'week' ? 'weeks' : 'rounds (one per Chi game night)';
    F.log(league.id, `The commissioner changed the regular season to ${regularWeeks} ${unit}, so the schedule was redrawn.`);
  }
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
  F.log(league.id, 'The draft has started!', 'draft');
  F.runBots(league.id);
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
  tick(Number(req.params.id));
  const league = loadLeague(req);
  const order = markBots(req, league.id, F.draftOrder(league.id)).map((t) => ({
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
  const result = tx(() => {
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
  F.runBots(id);
  return result;
}));

// ---------- Secret bots & commissioner roster edits ----------

const BOT_OWNERS = ['Big Mike', 'Coach T', 'The Professor', 'Old Man Jenkins', 'Dr. Draft', 'Sully', 'Moose', 'Dutch'];
const BOT_TEAMS = {
  win: ['Dynasty', 'The Machine', 'Undefeated Inc.', 'Final Boss'],
  lose: ['Tank Commanders', 'Participation Trophies', 'Hope for Next Year', 'The Benchwarmers'],
};

app.post('/api/leagues/:id/bots', needAdmin, wrap((req) => {
  const league = loadLeague(req);
  if (league.status !== 'setup') throw httpError(400, 'Bots can only join before the draft.');
  const kind = req.body.kind === 'lose' ? 'lose' : 'win';
  const owner = cleanText(req.body.owner, 60) || BOT_OWNERS[crypto.randomInt(BOT_OWNERS.length)];
  const name = cleanText(req.body.name, 40) || BOT_TEAMS[kind][crypto.randomInt(BOT_TEAMS[kind].length)];
  return tx(() => {
    // A bot is a normal-looking member that nobody can log in as.
    const u = run('INSERT INTO users (username, display_name, pass_hash, bot) VALUES (?, ?, ?, ?)',
      `bot-${crypto.randomBytes(6).toString('hex')}`, owner, hashPassword(crypto.randomBytes(24).toString('hex')), kind);
    const slot = one('SELECT COALESCE(MAX(draft_slot), 0) + 1 AS s FROM league_teams WHERE league_id = ?', league.id).s;
    run('INSERT INTO league_teams (league_id, user_id, name, draft_slot) VALUES (?, ?, ?, ?)', league.id, Number(u.lastInsertRowid), name, slot);
    F.log(league.id, `${owner} joined as ${name}`);
    return { ok: true, name, owner };
  });
}));

// The commissioner can put any player on any team, or take him off, outside the normal add/drop rules.
app.post('/api/leagues/:id/admin/roster', needUser, wrap((req) => {
  const league = loadLeague(req);
  if (!isCommish(req.user, league)) throw httpError(403, 'Only the commissioner can edit rosters.');
  if (!['active', 'complete'].includes(league.status)) throw httpError(400, 'Rosters can be edited after the draft.');
  const team = one('SELECT * FROM league_teams WHERE id = ? AND league_id = ?', req.body.team_id, league.id);
  if (!team) throw httpError(404, 'Team not found.');
  const at = new Date().toISOString();
  return tx(() => {
    if (req.body.drop_id) {
      const r = run('UPDATE roster SET dropped_at = ? WHERE league_team_id = ? AND athlete_id = ? AND dropped_at IS NULL', at, team.id, Number(req.body.drop_id));
      if (!r.changes) throw httpError(400, 'That player is not on this team.');
      F.log(league.id, `The commissioner removed ${one('SELECT name FROM athletes WHERE id = ?', req.body.drop_id).name} from ${team.name}`, 'commish');
    }
    if (req.body.add_id) {
      const a = one('SELECT * FROM athletes WHERE id = ? AND sport = ?', Number(req.body.add_id), league.sport);
      if (!a) throw httpError(400, 'That player is not in this sport.');
      const current = one(
        `SELECT r.id, lt.name FROM roster r JOIN league_teams lt ON lt.id = r.league_team_id
          WHERE r.league_id = ? AND r.athlete_id = ? AND r.dropped_at IS NULL`, league.id, a.id);
      // Backdate when asked, so the player's past games count for his new team (and not his old one).
      const from = req.body.count_past ? F.EPOCH : at;
      if (current) run(`UPDATE roster SET dropped_at = ${req.body.count_past ? 'acquired_at' : '?'} WHERE id = ?`, ...(req.body.count_past ? [] : [at]), current.id);
      F.addToRoster(league, team.id, a.id, from, 'commissioner');
      F.log(league.id, `The commissioner moved ${a.name} to ${team.name}${current ? ` from ${current.name}` : ''}`, 'commish');
    }
    return { ok: true };
  });
}));

// ---------- Lineups ----------

// Move a player between the starting lineup and the bench. Starting someone when every starting
// spot is full needs a starter to swap out (swap_id). Players whose game has started tonight are locked.
app.post('/api/leagues/:id/lineup', needUser, wrap((req) => {
  const league = loadLeague(req);
  if (league.status !== 'active') throw httpError(400, 'Lineups open after the draft.');
  const team = req.body.team_id && isCommish(req.user, league)
    ? one('SELECT * FROM league_teams WHERE id = ? AND league_id = ?', req.body.team_id, league.id)
    : one('SELECT * FROM league_teams WHERE league_id = ? AND user_id = ?', league.id, req.user.id);
  if (!team) throw httpError(403, 'You do not have a team in this league.');
  const history = F.lineupHistory(league.id);
  const locked = F.lockedTeams(league.sport);
  const entry = (athleteId) => {
    const r = one(
      `SELECT r.id, a.name, a.im_team_id FROM roster r JOIN athletes a ON a.id = r.athlete_id
        WHERE r.league_team_id = ? AND r.athlete_id = ? AND r.dropped_at IS NULL`, team.id, Number(athleteId));
    if (!r) throw httpError(400, 'That player is not on this roster.');
    if (locked.has(r.im_team_id)) throw httpError(400, `${r.name}'s game has started tonight, so he's locked until tomorrow.`);
    return { ...r, starter: F.starterAt(history, r.id) };
  };
  const p = entry(req.body.athlete_id);
  const start = !!req.body.starter;
  return tx(() => {
    if (start && !p.starter) {
      const starters = all('SELECT id FROM roster WHERE league_team_id = ? AND dropped_at IS NULL', team.id)
        .filter((r) => F.starterAt(history, r.id)).length;
      if (starters >= F.starterLimit(league)) {
        if (!req.body.swap_id) throw httpError(400, 'Your lineup is full. Pick a starter to bench.');
        const out = entry(req.body.swap_id);
        if (!out.starter) throw httpError(400, `${out.name} is already on the bench.`);
        F.setSlot(out.id, false);
      }
      F.setSlot(p.id, true);
    } else if (!start && p.starter) {
      F.setSlot(p.id, false);
    }
    return { ok: true };
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
      F.addToRoster(league, team.id, addId, now, 'free agent');
      added = athlete.name;
    }
    if (!added && !dropped) throw httpError(400, 'Pick a player to add or drop.');
    F.log(league.id, `${team.name}${added ? ` added ${added}` : ''}${added && dropped ? ' and' : ''}${dropped ? ` dropped ${dropped}` : ''}`, 'move');
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
