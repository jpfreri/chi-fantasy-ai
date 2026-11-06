const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chi-fantasy-'));
process.env.DB_FILE = path.join(dir, 'test.db');
const app = require('../src/server');
const { run } = require('../src/db');

let server, base;
before(() => new Promise((ok) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; ok(); }); }));
// Windows keeps the open SQLite file locked, so leaving the temp folder behind there is fine.
after(() => { server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json();
    return { status: res.status, data };
  };
}

const admin = client();
const bob = client();
const cal = client();
const ids = {};

test('first account becomes admin, later ones do not', async () => {
  const a = await admin('POST', '/api/auth/register', { username: 'commish', display_name: 'Commish', password: 'secret1' });
  assert.equal(a.data.admin, true);
  const b = await bob('POST', '/api/auth/register', { username: 'bob', display_name: 'Bob', password: 'secret1' });
  assert.equal(b.data.admin, false);
  await cal('POST', '/api/auth/register', { username: 'cal', display_name: 'Cal', password: 'secret1' });
  const denied = await bob('POST', '/api/teams', { sport: 'basketball', name: 'Nope' });
  assert.equal(denied.status, 403);
});

test('admin sets up teams, players and a game', async () => {
  const t1 = await admin('POST', '/api/teams', { sport: 'basketball', name: 'ΧΛΦ A', is_club: true });
  const t2 = await admin('POST', '/api/teams', { sport: 'basketball', name: 'Rivals' });
  ids.t1 = t1.data.id; ids.t2 = t2.data.id;
  const bulk = await admin('POST', '/api/athletes/bulk', {
    sport: 'basketball',
    text: 'Ann, PG, ΧΛΦ A\nBen, C, ΧΛΦ A\nCat, SF, Rivals\nDan, PF, Rivals\nEve, SG, New Team',
  });
  assert.equal(bulk.data.added, 5);
  const sport = await admin('GET', '/api/sports/basketball');
  assert.equal(sport.data.teams.length, 3, 'unknown team names are created');
  ids.ath = Object.fromEntries(sport.data.athletes.map((a) => [a.name, a.id]));
});

test('snake draft runs in order and enforces turns', async () => {
  const l = await admin('POST', '/api/leagues', { sport: 'basketball', name: 'Test League', roster_size: 2, starters: 2, pick_seconds: 0 });
  ids.league = l.data.id;
  await bob('POST', `/api/leagues/${ids.league}/join`, { name: 'Bobcats' });
  await cal('POST', `/api/leagues/${ids.league}/join`, { name: 'Cals' });
  const lg = await admin('GET', `/api/leagues/${ids.league}`);
  const [bobTeam, calTeam] = lg.data.standings.sort((a, b) => a.draft_slot - b.draft_slot);
  assert.equal(bobTeam.name, 'Bobcats');
  ids.bobTeam = bobTeam.id; ids.calTeam = calTeam.id;

  const start = await admin('POST', `/api/leagues/${ids.league}/draft/start`);
  assert.equal(start.status, 200);

  const wrongTurn = await cal('POST', `/api/leagues/${ids.league}/draft/pick`, { athlete_id: ids.ath.Ann });
  assert.equal(wrongTurn.status, 403);

  // Round 1: Bob then Cal. Round 2 snakes: Cal then Bob.
  assert.equal((await bob('POST', `/api/leagues/${ids.league}/draft/pick`, { athlete_id: ids.ath.Ann })).status, 200);
  const dup = await cal('POST', `/api/leagues/${ids.league}/draft/pick`, { athlete_id: ids.ath.Ann });
  assert.equal(dup.status, 409);
  assert.equal((await cal('POST', `/api/leagues/${ids.league}/draft/pick`, { athlete_id: ids.ath.Ben })).status, 200);
  assert.equal((await cal('POST', `/api/leagues/${ids.league}/draft/pick`, { athlete_id: ids.ath.Cat })).status, 200);
  assert.equal((await bob('POST', `/api/leagues/${ids.league}/draft/pick`, { athlete_id: ids.ath.Dan })).status, 200);

  const after = await bob('GET', `/api/leagues/${ids.league}`);
  assert.equal(after.data.league.status, 'active');
  assert.deepEqual(after.data.myTeam.players.map((p) => p.name).sort(), ['Ann', 'Dan']);
  assert.deepEqual(after.data.freeAgents.map((a) => a.name), ['Eve']);
});

test('scoring follows league rules and only counts games while rostered', async () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  const g = await admin('POST', '/api/games', { sport: 'basketball', home_team_id: ids.t1, away_team_id: ids.t2, starts_at: past, status: 'final', home_score: 40, away_score: 35 });
  await admin('PUT', `/api/games/${g.data.id}/stats`, { rows: [
    { athlete_id: ids.ath.Ann, stats: { pts: 10, ast: 2 } },  // 10 + 3 = 13
    { athlete_id: ids.ath.Dan, stats: { pts: 4, tov: 2 } },   // 4 - 2 = 2
    { athlete_id: ids.ath.Eve, stats: { pts: 20 } },          // free agent: counts for nobody
  ] });
  let lg = await bob('GET', `/api/leagues/${ids.league}`);
  assert.equal(lg.data.myTeam.points, 15);

  // Bob swaps Dan for Eve after the game. Eve's old points must not count, and Dan's stay with Bob.
  const tx = await bob('POST', `/api/leagues/${ids.league}/transactions`, { add_id: ids.ath.Eve, drop_id: ids.ath.Dan });
  assert.equal(tx.status, 200);
  lg = await bob('GET', `/api/leagues/${ids.league}`);
  assert.equal(lg.data.myTeam.points, 15);
  assert.deepEqual(lg.data.myTeam.players.map((p) => p.name).sort(), ['Ann', 'Eve']);

  // The commissioner doubles points per point scored; everything recalculates.
  const scoring = { ...lg.data.league.scoring, pts: 2 };
  await admin('PUT', `/api/leagues/${ids.league}`, { scoring });
  lg = await bob('GET', `/api/leagues/${ids.league}`);
  assert.equal(lg.data.myTeam.points, 29); // Ann 23 + Dan 6
});

test('head-to-head records, playoff seeding and a champion', async () => {
  await admin('PUT', `/api/leagues/${ids.league}`, { regular_weeks: 1, playoff_teams: 2 });
  let lg = await bob('GET', `/api/leagues/${ids.league}`);
  assert.equal(lg.data.matchups.length, 1, 'two teams play once in a 1-week season');
  const me = lg.data.standings.find((t) => t.name === 'Bobcats');
  assert.deepEqual([me.w, me.l, me.pf], [1, 0, 29]);
  assert.equal(lg.data.standings[0].name, 'Bobcats');
  const final = lg.data.playoffs.rounds[0].games[0];
  assert.equal(lg.data.playoffs.seeded, true);
  assert.equal(final.week, 2);
  assert.equal(final.state, 'upcoming');
  assert.equal(lg.data.champion, null);

  // Week 2 is the championship. Cal's player scores, Bob's do not.
  const g = await admin('POST', '/api/games', { sport: 'basketball', week: 2, home_team_id: ids.t1, away_team_id: ids.t2, starts_at: new Date().toISOString(), status: 'final', home_score: 1, away_score: 2 });
  await admin('PUT', `/api/games/${g.data.id}/stats`, { rows: [{ athlete_id: ids.ath.Cat, stats: { pts: 10 } }] });
  lg = await bob('GET', `/api/leagues/${ids.league}`);
  assert.equal(lg.data.champion.name, 'Cals');
});

test('each Chi game night is a round, and every matchup gets a win prediction', async () => {
  // Games yesterday and today are already in; add one tomorrow. Two games the same night are one round.
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  await admin('POST', '/api/games', { sport: 'basketball', home_team_id: ids.t1, away_team_id: ids.t2, starts_at: tomorrow });
  await admin('POST', '/api/games', { sport: 'basketball', home_team_id: ids.t2, away_team_id: ids.t1, starts_at: tomorrow });
  await admin('PUT', `/api/leagues/${ids.league}`, { playoff_teams: 0, round_by: 'week' });
  await admin('PUT', `/api/leagues/${ids.league}`, { round_by: 'game' });
  const lg = await bob('GET', `/api/leagues/${ids.league}`);
  assert.equal(lg.data.roundBy, 'game');
  assert.equal(lg.data.league.regular_weeks, 3, 'switching to game nights fills the season: 3 nights');
  assert.equal(lg.data.weekStates[3].games, 2);
  const [r1, r2, r3] = [1, 2, 3].map((w) => lg.data.matchups.find((m) => m.week === w));
  assert.equal(r1.prediction.basis, 'none', 'nothing was known before the first night');
  assert.equal(typeof r2.prediction.correct, 'boolean', 'finished rounds say if the pick was right');
  assert.equal(r3.state, 'upcoming');
  assert.ok(r3.prediction.home_win > 0 && r3.prediction.home_win < 1);
  assert.ok(r3.prediction.home_proj > 0 || r3.prediction.away_proj > 0);
  // The side projected to score more is the favorite.
  const p = r3.prediction;
  assert.equal(p.pick, p.home_proj > p.away_proj ? r3.home_team_id : r3.away_team_id);
  assert.equal(lg.data.aiRecord.total, 1);
});

test('round robin gives every team one game a week and covers every pairing', () => {
  const { roundRobin } = require('../src/fantasy');
  const weeks = roundRobin([1, 2, 3, 4, 5], 5);
  const seen = new Set();
  for (const pairs of weeks) {
    const teams = pairs.flat();
    assert.equal(new Set(teams).size, teams.length, 'nobody plays twice in a week');
    assert.equal(pairs.length, 2, 'one bye with 5 teams');
    for (const [a, b] of pairs) seen.add([a, b].sort().join('-'));
  }
  assert.equal(seen.size, 10);
});

test('lower Chi teams are worth less: the team multiplier scales fantasy points', async () => {
  // Ann (on ΧΛΦ A) scored 10 pts and 2 ast in week 1: 2x10 + 3 = 23 under this league's scoring.
  await admin('PUT', `/api/teams/${ids.t1}`, { multiplier: 0.5 });
  const lg = await bob('GET', `/api/leagues/${ids.league}`);
  const ann = lg.data.myTeam.players.find((p) => p.name === 'Ann');
  assert.equal(ann.points, 11.5);
  await admin('PUT', `/api/teams/${ids.t1}`, { multiplier: 1 });
});

test('secret bots: the win bot drafts the best, the lose bot the worst, and only admins can tell', async () => {
  const l = await admin('POST', '/api/leagues', { sport: 'basketball', name: 'Bot League', roster_size: 1, pick_seconds: 0 });
  await bob('POST', `/api/leagues/${l.data.id}/join`, {});
  assert.equal((await bob('POST', `/api/leagues/${l.data.id}/bots`, { kind: 'win' })).status, 403);
  await admin('POST', `/api/leagues/${l.data.id}/bots`, { kind: 'win', name: 'Winners' });
  await admin('POST', `/api/leagues/${l.data.id}/bots`, { kind: 'lose', name: 'Losers' });
  await admin('POST', `/api/leagues/${l.data.id}/order`, { team_ids: (await admin('GET', `/api/leagues/${l.data.id}`)).data.standings.map((t) => t.id).sort((a, b) => b - a) });
  await admin('POST', `/api/leagues/${l.data.id}/draft/start`);
  // Both bots pick at once; then it is Bob's turn.
  let d = await bob('GET', `/api/leagues/${l.data.id}/draft`);
  assert.equal(d.data.picks.length, 2);
  const pool = (await admin('GET', '/api/sports/basketball')).data.athletes.filter((a) => a.active);
  const best = Math.max(...pool.map((a) => a.points)), worst = Math.min(...pool.map((a) => a.points));
  const byTeam = (name) => d.data.picks.find((p) => p.league_team_id === d.data.order.find((t) => t.name === name).id);
  const pts = (pick) => pool.find((a) => a.id === pick.athlete_id).points;
  assert.equal(pts(byTeam('Losers')), worst);
  assert.equal(pts(byTeam('Winners')), best);
  assert.ok(d.data.order.every((t) => !('bot' in t)), 'members cannot see bots');
  const seen = await admin('GET', `/api/leagues/${l.data.id}/draft`);
  assert.deepEqual(seen.data.order.map((t) => t.bot).filter(Boolean).sort(), ['lose', 'win']);
  const users = (await admin('GET', '/api/users')).data;
  assert.equal(users.filter((u) => u.bot).length, 2);
});

test('the server auto-picks when the clock runs out', async () => {
  const l = await admin('POST', '/api/leagues', { sport: 'basketball', name: 'Clock League', roster_size: 1, pick_seconds: 30 });
  await bob('POST', `/api/leagues/${l.data.id}/join`, {});
  await cal('POST', `/api/leagues/${l.data.id}/join`, {});
  await admin('POST', `/api/leagues/${l.data.id}/draft/start`);
  // Pretend the clock started two minutes ago.
  run('UPDATE leagues SET clock_started_at = ? WHERE id = ?', Date.now() - 120000, l.data.id);
  const d = await bob('GET', `/api/leagues/${l.data.id}/draft`);
  assert.equal(d.data.picks.length, 2);
  assert.ok(d.data.picks.every((p) => p.auto === 1));
  assert.equal(d.data.league.status, 'active');
});

test('Google sign-in creates or links an account and makes ADMIN_EMAILS admins', async () => {
  const http = require('http');
  const id = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  let next = {};
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ok = new URLSearchParams(body).get('code') === 'good';
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { id_token: id(next) } : { error: 'invalid_grant' }));
    });
  });
  await new Promise((ok) => fake.listen(0, ok));
  // The server reads these env vars at load, so start a second copy of the app with Google turned on.
  for (const k of Object.keys(require.cache)) if (/[\\/]src[\\/]server/.test(k)) delete require.cache[k];
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', ADMIN_EMAILS: 'Boss@Example.com',
    GOOGLE_TOKEN_URL: `http://localhost:${fake.address().port}/token` });
  const gapp = require('../src/server');
  const gs = await new Promise((ok) => { const s = gapp.listen(0, () => ok(s)); });
  const gbase = `http://localhost:${gs.address().port}`;
  try {
    const meta = await (await fetch(gbase + '/api/meta')).json();
    assert.equal(meta.google, true);
    async function signIn(claims, code = 'good', cookie = '') {
      const start = await fetch(gbase + '/auth/google', { redirect: 'manual', headers: { cookie } });
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const g = start.headers.get('set-cookie').split(';')[0];
      next = { iss: 'https://accounts.google.com', aud: 'cid', exp: Date.now() / 1000 + 60, email_verified: true, ...claims };
      const cb = await fetch(`${gbase}/auth/google/callback?state=${state}&code=${code}`, { redirect: 'manual', headers: { cookie: [g, cookie].filter(Boolean).join('; ') } });
      const sid = (cb.headers.get('set-cookie') || '').match(/sid=[0-9a-f]+/)?.[0];
      const me = sid ? (await (await fetch(gbase + '/api/me', { headers: { cookie: sid } })).json()).user : null;
      return { location: cb.headers.get('location'), sid, me };
    }
    const boss = await signIn({ sub: 'g-boss', email: 'boss@example.com', name: 'The Boss' });
    assert.equal(boss.me.display_name, 'The Boss');
    assert.equal(boss.me.is_admin, 1, 'ADMIN_EMAILS match ignores case');
    assert.equal(boss.me.has_password, 0);
    const again = await signIn({ sub: 'g-boss', email: 'boss@example.com', name: 'The Boss' });
    assert.equal(again.me.id, boss.me.id, 'same Google id signs into the same account');
    const fan = await signIn({ sub: 'g-fan', email: 'fan@example.com', name: 'Fan' });
    assert.equal(fan.me.is_admin, 0);
    const bad = await signIn({ sub: 'g-x', email: 'x@example.com', aud: 'someone-else' });
    assert.match(bad.location, /auth_error=/);
    const denied = await signIn({ sub: 'g-x', email: 'x@example.com' }, 'bad');
    assert.match(denied.location, /auth_error=/);
    // A member who is logged in links Google to their existing account.
    const login = await fetch(gbase + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'secret1' }) });
    const bobSid = login.headers.get('set-cookie').split(';')[0];
    const link = await signIn({ sub: 'g-bob', email: 'bob@example.com' }, 'good', bobSid);
    assert.equal(link.location, '/#/account');
    const bobMe = (await (await fetch(gbase + '/api/me', { headers: { cookie: bobSid } })).json()).user;
    assert.equal(bobMe.email, 'bob@example.com');
    assert.equal((await signIn({ sub: 'g-bob', email: 'bob@example.com' })).me.username, 'bob');
  } finally {
    gs.close(); fake.close();
  }
});

test('lineups: only starters score, a full lineup needs a swap, and players lock at game time', async () => {
  const team = await admin('POST', '/api/teams', { sport: 'basketball', name: 'Night Owls' });
  await admin('POST', '/api/athletes/bulk', { sport: 'basketball', text: 'Finn, PG, Night Owls\nGus, C, Night Owls' });
  const ath = Object.fromEntries((await admin('GET', '/api/sports/basketball')).data.athletes.map((a) => [a.name, a.id]));
  const l = await admin('POST', '/api/leagues', { sport: 'basketball', name: 'Lineup League', roster_size: 2, starters: 1, pick_seconds: 0 });
  const id = l.data.id;
  await bob('POST', `/api/leagues/${id}/join`, { name: 'Bobcats' });
  await cal('POST', `/api/leagues/${id}/join`, { name: 'Cals' });
  await admin('POST', `/api/leagues/${id}/draft/start`);
  for (const [who, name] of [[bob, 'Finn'], [cal, 'Ann'], [cal, 'Ben'], [bob, 'Gus']]) {
    assert.equal((await who('POST', `/api/leagues/${id}/draft/pick`, { athlete_id: ath[name] })).status, 200);
  }
  let lg = await bob('GET', `/api/leagues/${id}`);
  const slot = (d, name) => d.myTeam.players.find((p) => p.name === name).starter;
  assert.equal(lg.data.starters, 1);
  assert.equal(slot(lg.data, 'Finn'), true, 'first pick fills the open starting spot');
  assert.equal(slot(lg.data, 'Gus'), false, 'the rest go to the bench');

  // Two nights ago Finn started and Gus sat. Gus's 10 points don't count for Bob.
  const past = new Date(Date.now() - 2 * 86400000).toISOString();
  const g = await admin('POST', '/api/games', { sport: 'basketball', home_team_id: team.data.id, away_team_id: ids.t2, starts_at: past, status: 'final' });
  await admin('PUT', `/api/games/${g.data.id}/stats`, { rows: [{ athlete_id: ath.Finn, stats: { pts: 4 } }, { athlete_id: ath.Gus, stats: { pts: 10 } }] });
  lg = await bob('GET', `/api/leagues/${id}`);
  assert.equal(lg.data.myTeam.points, 4);
  assert.equal(lg.data.myTeam.players.find((p) => p.name === 'Gus').points, 10, 'bench points still show on the player');

  const full = await bob('POST', `/api/leagues/${id}/lineup`, { athlete_id: ath.Gus, starter: true });
  assert.equal(full.status, 400, 'a full lineup needs a starter to swap out');
  assert.equal((await bob('POST', `/api/leagues/${id}/lineup`, { athlete_id: ath.Gus, starter: true, swap_id: ath.Finn })).status, 200);
  lg = await bob('GET', `/api/leagues/${id}`);
  assert.equal(slot(lg.data, 'Gus'), true);
  assert.equal(slot(lg.data, 'Finn'), false);
  assert.equal(lg.data.myTeam.points, 4, 'a lineup change never rewrites past nights');

  // Ann's team played today, so she's locked until tomorrow.
  const locked = await cal('POST', `/api/leagues/${id}/lineup`, { athlete_id: ath.Ann, starter: false });
  assert.equal(locked.status, 400);
  assert.match(locked.data.error, /locked/);

  // ESPN extras come back with the league.
  assert.ok(lg.data.power.length === 2 && lg.data.power[0].rank === 1);
  assert.ok(lg.data.standings.every((t) => 'streak' in t && 'adds' in t));
  const fa = lg.data.freeAgents[0];
  assert.ok('proj_avg' in fa && 'avg' in fa);
});

test('trades: offer, accept, commissioner review and veto, roster limits, deadline', async () => {
  const team = await admin('POST', '/api/teams', { sport: 'basketball', name: 'Traders' });
  await admin('POST', '/api/athletes/bulk', { sport: 'basketball', text: 'Hal, PG, Traders\nIvy, C, Traders\nJay, SF, Traders\nKim, PF, Traders\nLou, SG, Traders' });
  const ath = Object.fromEntries((await admin('GET', '/api/sports/basketball')).data.athletes.map((a) => [a.name, a.id]));
  const l = await admin('POST', '/api/leagues', { sport: 'basketball', name: 'Trade League', roster_size: 2, starters: 1, pick_seconds: 0 });
  const id = l.data.id;
  await bob('POST', `/api/leagues/${id}/join`, { name: 'Bobcats' });
  await cal('POST', `/api/leagues/${id}/join`, { name: 'Cals' });
  await admin('POST', `/api/leagues/${id}/order`, { team_ids: (await admin('GET', `/api/leagues/${id}`)).data.standings.sort((a, b) => a.user_id - b.user_id).map((t) => t.id) });
  await admin('POST', `/api/leagues/${id}/draft/start`);
  for (const [who, name] of [[bob, 'Hal'], [cal, 'Ivy'], [cal, 'Jay'], [bob, 'Kim']]) {
    assert.equal((await who('POST', `/api/leagues/${id}/draft/pick`, { athlete_id: ath[name] })).status, 200);
  }
  let lg = await bob('GET', `/api/leagues/${id}`);
  const calTeam = lg.data.standings.find((t) => t.name === 'Cals').id;
  const names = (d) => d.myTeam.players.map((p) => p.name).sort().join(',');

  const offer = await bob('POST', `/api/leagues/${id}/trades`, { to_team_id: calTeam, give: [ath.Hal], get: [ath.Ivy] });
  assert.equal(offer.status, 200);
  assert.equal((await bob('POST', `/api/leagues/${id}/trades/${offer.data.id}/accept`)).status, 403, 'you cannot accept your own offer');
  const cl = await cal('GET', `/api/leagues/${id}`);
  assert.equal(cl.data.trades[0].status, 'pending');
  assert.deepEqual(cl.data.trades[0].gives.map((i) => i.name), ['Hal']);
  assert.equal((await cal('POST', `/api/leagues/${id}/trades/${offer.data.id}/accept`)).data.status, 'review', 'accepted trades wait for league review');
  assert.equal((await bob('POST', `/api/leagues/${id}/trades/${offer.data.id}/veto`)).status, 403, 'only the commissioner can veto');
  assert.equal((await admin('POST', `/api/leagues/${id}/trades/${offer.data.id}/veto`)).data.status, 'vetoed');
  assert.equal(names((await bob('GET', `/api/leagues/${id}`)).data), 'Hal,Kim', 'a vetoed trade changes nothing');

  const again = await bob('POST', `/api/leagues/${id}/trades`, { to_team_id: calTeam, give: [ath.Hal], get: [ath.Ivy] });
  await cal('POST', `/api/leagues/${id}/trades/${again.data.id}/accept`);
  assert.equal((await admin('POST', `/api/leagues/${id}/trades/${again.data.id}/approve`)).data.status, 'done');
  lg = await bob('GET', `/api/leagues/${id}`);
  assert.equal(names(lg.data), 'Ivy,Kim');
  assert.equal(names((await cal('GET', `/api/leagues/${id}`)).data), 'Hal,Jay');
  assert.ok(lg.data.activity.some((a) => a.kind === 'trade' && /Trade: Bobcats sent Hal/.test(a.text)));

  // No review period: the trade goes through on accept. Rosters can't go over the limit.
  await admin('PUT', `/api/leagues/${id}`, { trade_review_hours: 0 });
  const uneven = await bob('POST', `/api/leagues/${id}/trades`, { to_team_id: calTeam, give: [], get: [ath.Jay] });
  assert.equal(uneven.status, 400);
  assert.match(uneven.data.error, /over the 2-player limit/);
  const quick = await bob('POST', `/api/leagues/${id}/trades`, { to_team_id: calTeam, give: [ath.Kim], get: [ath.Jay] });
  assert.equal((await cal('POST', `/api/leagues/${id}/trades/${quick.data.id}/accept`)).data.status, 'done');

  const yesterday = new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10);
  await admin('PUT', `/api/leagues/${id}`, { trade_deadline: yesterday });
  const late = await bob('POST', `/api/leagues/${id}/trades`, { to_team_id: calTeam, give: [ath.Jay], get: [ath.Hal] });
  assert.equal(late.status, 400);
  assert.match(late.data.error, /deadline/);
  ids.tradeLeague = id; ids.tradeAth = ath; ids.tradeCal = calTeam;
});

test('waivers: a dropped player needs a claim, and the best waiver priority wins', async () => {
  const id = ids.tradeLeague, ath = ids.tradeAth;
  // Bob has Ivy and Jay; Cal has Hal and Kim.
  assert.equal((await bob('POST', `/api/leagues/${id}/transactions`, { drop_id: ath.Jay })).status, 200);
  let lg = await cal('GET', `/api/leagues/${id}`);
  assert.ok(lg.data.freeAgents.find((a) => a.id === ath.Jay).waiver_until, 'Jay is on waivers');
  assert.ok(lg.data.waivers.players.some((p) => p.athlete_id === ath.Jay));

  const c = await cal('POST', `/api/leagues/${id}/transactions`, { add_id: ath.Jay, drop_id: ath.Kim });
  assert.equal(c.data.claim, true, 'adding a player on waivers puts in a claim');
  assert.equal((await bob('POST', `/api/leagues/${id}/transactions`, { add_id: ath.Jay })).data.claim, true);
  lg = await cal('GET', `/api/leagues/${id}`);
  assert.equal(lg.data.waivers.claims[0].status, 'pending');
  const first = lg.data.waivers.order[0].team_id;

  run('UPDATE waivers SET clears_at = ? WHERE league_id = ?', new Date(Date.now() - 1000).toISOString(), id);
  lg = await cal('GET', `/api/leagues/${id}`);
  const bobLg = await bob('GET', `/api/leagues/${id}`);
  const winnerData = first === ids.tradeCal ? lg.data : bobLg.data;
  const loserData = first === ids.tradeCal ? bobLg.data : lg.data;
  assert.ok(winnerData.myTeam.players.some((p) => p.name === 'Jay'), 'the team with first waiver priority gets him');
  assert.equal(loserData.waivers.claims[0].status, 'lost');
  assert.ok(lg.data.activity.some((a) => /claimed Jay off waivers/.test(a.text)));
  if (first === ids.tradeCal) assert.ok(lg.data.waivers.players.some((p) => p.athlete_id === ath.Kim), 'the player dropped for a claim goes on waivers too');
});

test('the admin sees every league on the home page; players do not', async () => {
  const a = await admin('GET', '/api/home');
  const all = (await admin('GET', '/api/home')).data.leagues.length;
  assert.equal(a.data.allLeagues.length, all);
  const active = a.data.allLeagues.find((l) => l.id === ids.tradeLeague);
  assert.equal(active.status, 'active');
  assert.ok(active.leader && Array.isArray(active.matchups));
  assert.equal((await bob('GET', '/api/home')).data.allLeagues, null);
});
