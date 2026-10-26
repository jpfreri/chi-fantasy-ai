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
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

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
  const l = await admin('POST', '/api/leagues', { sport: 'basketball', name: 'Test League', roster_size: 2, pick_seconds: 0 });
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
