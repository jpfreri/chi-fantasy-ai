// Trades and waivers, modeled on ESPN leagues.
//
// Trades: a team offers players for players. The other team accepts or rejects. An accepted trade
// waits out the league's review period (trade_review_hours), when the commissioner can veto or
// approve it early, then goes through. No trades are offered or accepted after the trade deadline.
//
// Waivers: a dropped player sits on waivers for waiver_hours. Teams put in claims instead of adding
// him. When his waiver period ends, the claim from the team with the best waiver priority wins.
// Priority is reverse standings (worst team first), or reverse draft order before any round is final.
const { one, all, run } = require('./db');
const F = require('./fantasy');

const TZ = 'America/Chicago';
const today = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: TZ });
const hoursLater = (iso, h) => new Date(new Date(iso).getTime() + h * 3600000).toISOString();

// ---------- Waivers ----------

function pastDeadline(league, now = new Date()) {
  return !!league.trade_deadline && today(now) > league.trade_deadline;
}

// Players on waivers right now: athlete id -> the time their waiver period ends.
function onWaivers(leagueId) {
  return Object.fromEntries(
    all('SELECT athlete_id, clears_at FROM waivers WHERE league_id = ? AND processed = 0', leagueId)
      .map((w) => [w.athlete_id, w.clears_at])
  );
}

function putOnWaivers(league, athleteId, at = new Date().toISOString()) {
  const hours = Number(league.waiver_hours) || 0;
  run('UPDATE waivers SET processed = 1 WHERE league_id = ? AND athlete_id = ? AND processed = 0', league.id, athleteId);
  if (hours <= 0) return null;
  const clears = hoursLater(at, hours);
  run('INSERT INTO waivers (league_id, athlete_id, dropped_at, clears_at) VALUES (?, ?, ?, ?)', league.id, athleteId, at, clears);
  return clears;
}

// Team ids, first priority first.
function waiverOrder(league, teams = F.leagueView(league).teams) {
  const anyPlayed = teams.some((t) => t.w + t.l + t.t > 0);
  const sorted = anyPlayed
    ? [...teams].sort((a, b) => b.rank - a.rank)
    : [...teams].sort((a, b) => (b.draft_slot ?? 0) - (a.draft_slot ?? 0));
  return sorted.map((t) => t.id);
}

const activeRoster = (teamId) => all('SELECT * FROM roster WHERE league_team_id = ? AND dropped_at IS NULL', teamId);
const nameOf = (athleteId) => one('SELECT name FROM athletes WHERE id = ?', athleteId)?.name || 'a player';
const teamName = (teamId) => one('SELECT name FROM league_teams WHERE id = ?', teamId)?.name || 'A team';

// Puts in (or updates) a claim. One claim per team per player.
function claim(league, team, athleteId, dropId) {
  const clears = onWaivers(league.id)[athleteId];
  if (!clears) throw F.httpError(400, `${nameOf(athleteId)} is not on waivers.`);
  if (dropId && !activeRoster(team.id).some((r) => r.athlete_id === dropId)) throw F.httpError(400, 'That player is not on your roster.');
  if (!dropId && activeRoster(team.id).length >= league.roster_size) throw F.httpError(400, 'Your roster is full. Pick a player to drop if the claim wins.');
  const now = new Date().toISOString();
  const had = one(`SELECT id FROM waiver_claims WHERE league_team_id = ? AND athlete_id = ? AND status = 'pending'`, team.id, athleteId);
  if (had) run('UPDATE waiver_claims SET drop_id = ?, created_at = ? WHERE id = ?', dropId || null, now, had.id);
  else run('INSERT INTO waiver_claims (league_id, league_team_id, athlete_id, drop_id, created_at) VALUES (?, ?, ?, ?, ?)', league.id, team.id, athleteId, dropId || null, now);
  return clears;
}

// Settles every player whose waiver period is over. Call inside a transaction.
function processWaivers(league, now = new Date()) {
  const due = all(
    'SELECT * FROM waivers WHERE league_id = ? AND processed = 0 AND clears_at <= ? ORDER BY clears_at, id',
    league.id, now.toISOString()
  );
  if (!due.length) return;
  const order = waiverOrder(league);
  const priority = (teamId) => { const i = order.indexOf(teamId); return i < 0 ? order.length : i; };
  for (const w of due) {
    run('UPDATE waivers SET processed = 1 WHERE id = ?', w.id);
    const claims = all(`SELECT * FROM waiver_claims WHERE league_id = ? AND athlete_id = ? AND status = 'pending'`, league.id, w.athlete_id)
      .sort((a, b) => priority(a.league_team_id) - priority(b.league_team_id) || a.id - b.id);
    const at = w.clears_at;
    let winner = null;
    for (const c of claims) {
      const fail = (reason) => run(`UPDATE waiver_claims SET status = 'lost', reason = ?, decided_at = ? WHERE id = ?`, reason, at, c.id);
      if (winner) { fail(`${teamName(winner.league_team_id)} had a better waiver priority.`); continue; }
      if (one('SELECT 1 FROM roster WHERE league_id = ? AND athlete_id = ? AND dropped_at IS NULL', league.id, w.athlete_id)) { fail('He is already on a team.'); continue; }
      const roster = activeRoster(c.league_team_id);
      const drop = c.drop_id ? roster.find((r) => r.athlete_id === c.drop_id) : null;
      if (c.drop_id && !drop) { fail(`${nameOf(c.drop_id)} is no longer on your roster.`); continue; }
      if (roster.length - (drop ? 1 : 0) >= league.roster_size) { fail('Your roster was full.'); continue; }
      if (drop) {
        run('UPDATE roster SET dropped_at = ? WHERE id = ?', at, drop.id);
        putOnWaivers(league, drop.athlete_id, at);
      }
      F.addToRoster(league, c.league_team_id, w.athlete_id, at, 'waivers');
      run(`UPDATE waiver_claims SET status = 'won', decided_at = ? WHERE id = ?`, at, c.id);
      F.log(league.id, `${teamName(c.league_team_id)} claimed ${nameOf(w.athlete_id)} off waivers${drop ? ` and dropped ${nameOf(drop.athlete_id)}` : ''}`, 'move');
      winner = c;
    }
  }
}

// ---------- Trades ----------

function tradeItems(tradeId) {
  return all('SELECT * FROM trade_items WHERE trade_id = ?', tradeId);
}

function propose(league, from, toTeamId, giveIds, getIds, note) {
  if (league.status !== 'active') throw F.httpError(400, 'Trades open after the draft.');
  if (pastDeadline(league)) throw F.httpError(400, 'The trade deadline has passed.');
  const to = one('SELECT * FROM league_teams WHERE id = ? AND league_id = ?', Number(toTeamId), league.id);
  if (!to || to.id === from.id) throw F.httpError(400, 'Pick another team to trade with.');
  const give = [...new Set((giveIds || []).map(Number))];
  const get = [...new Set((getIds || []).map(Number))];
  if (!give.length && !get.length) throw F.httpError(400, 'Pick at least one player.');
  const mine = new Set(activeRoster(from.id).map((r) => r.athlete_id));
  const theirs = new Set(activeRoster(to.id).map((r) => r.athlete_id));
  if (give.some((id) => !mine.has(id))) throw F.httpError(400, 'You can only offer players on your roster.');
  if (get.some((id) => !theirs.has(id))) throw F.httpError(400, `You can only ask for players on ${to.name}.`);
  checkSizes(league, from.id, to.id, give.length, get.length);
  const now = new Date().toISOString();
  const id = Number(run(
    'INSERT INTO trades (league_id, proposer_team_id, receiver_team_id, note, created_at) VALUES (?, ?, ?, ?, ?)',
    league.id, from.id, to.id, String(note || '').trim().slice(0, 200) || null, now
  ).lastInsertRowid);
  for (const a of give) run('INSERT INTO trade_items (trade_id, athlete_id, from_team_id) VALUES (?, ?, ?)', id, a, from.id);
  for (const a of get) run('INSERT INTO trade_items (trade_id, athlete_id, from_team_id) VALUES (?, ?, ?)', id, a, to.id);
  return id;
}

// Rosters can't go over the limit. Uneven trades need the team taking more players to have room.
function checkSizes(league, aId, bId, aGives, bGives) {
  for (const [teamId, out, inn] of [[aId, aGives, bGives], [bId, bGives, aGives]]) {
    const size = activeRoster(teamId).length - out + inn;
    if (size > league.roster_size) {
      throw F.httpError(400, `${teamName(teamId)} would have ${size} players, over the ${league.roster_size}-player limit. Even out the trade or drop someone first.`);
    }
  }
}

function describe(trade) {
  const items = tradeItems(trade.id);
  const list = (teamId) => items.filter((i) => i.from_team_id === teamId).map((i) => nameOf(i.athlete_id)).join(', ') || 'nothing';
  return `${teamName(trade.proposer_team_id)} sent ${list(trade.proposer_team_id)} to ${teamName(trade.receiver_team_id)} for ${list(trade.receiver_team_id)}`;
}

function accept(league, trade, now = new Date()) {
  if (trade.status !== 'pending') throw F.httpError(400, 'This offer is no longer open.');
  if (pastDeadline(league, now)) throw F.httpError(400, 'The trade deadline has passed.');
  validate(league, trade);
  const at = now.toISOString();
  const hours = Number(league.trade_review_hours) || 0;
  if (hours <= 0) return execute(league, trade, at);
  run(`UPDATE trades SET status = 'review', accepted_at = ?, process_at = ? WHERE id = ?`, at, hoursLater(at, hours), trade.id);
  F.log(league.id, `Trade accepted, pending league review: ${describe(trade)}`, 'trade');
  return 'review';
}

// Every player must still be on the team trading him, and rosters must fit.
function validate(league, trade) {
  const items = tradeItems(trade.id);
  for (const i of items) {
    if (!one('SELECT 1 FROM roster WHERE league_team_id = ? AND athlete_id = ? AND dropped_at IS NULL', i.from_team_id, i.athlete_id)) {
      throw F.httpError(409, `${nameOf(i.athlete_id)} is no longer on ${teamName(i.from_team_id)}.`);
    }
  }
  const a = trade.proposer_team_id, b = trade.receiver_team_id;
  checkSizes(league, a, b, items.filter((i) => i.from_team_id === a).length, items.filter((i) => i.from_team_id === b).length);
}

function execute(league, trade, at) {
  const items = tradeItems(trade.id);
  for (const i of items) {
    run('UPDATE roster SET dropped_at = ? WHERE league_team_id = ? AND athlete_id = ? AND dropped_at IS NULL', at, i.from_team_id, i.athlete_id);
  }
  for (const i of items) {
    const to = i.from_team_id === trade.proposer_team_id ? trade.receiver_team_id : trade.proposer_team_id;
    F.addToRoster(league, to, i.athlete_id, at, 'trade');
  }
  run(`UPDATE trades SET status = 'done', decided_at = ? WHERE id = ?`, at, trade.id);
  F.log(league.id, `Trade: ${describe(trade)}`, 'trade');
  // Other open offers with these players can't happen any more.
  const moved = items.map((i) => i.athlete_id);
  const others = all(
    `SELECT DISTINCT t.* FROM trades t JOIN trade_items ti ON ti.trade_id = t.id
      WHERE t.league_id = ? AND t.status IN ('pending', 'review') AND t.id != ? AND ti.athlete_id IN (${moved.map(() => '?').join(',')})`,
    league.id, trade.id, ...moved
  );
  for (const o of others) run(`UPDATE trades SET status = 'failed', reason = ?, decided_at = ? WHERE id = ?`, 'A player in it was traded.', at, o.id);
  return 'done';
}

function close(trade, status, reason = null, at = new Date().toISOString()) {
  run('UPDATE trades SET status = ?, reason = ?, decided_at = ? WHERE id = ?', status, reason, at, trade.id);
}

// Runs on every league load: expire offers past the deadline, push through trades whose review is over,
// let bots answer offers, and settle waivers. Call inside a transaction.
function processTrades(league, now = new Date()) {
  const at = now.toISOString();
  if (pastDeadline(league, now)) {
    for (const t of all(`SELECT * FROM trades WHERE league_id = ? AND status = 'pending'`, league.id)) close(t, 'failed', 'The trade deadline passed.', at);
  }
  for (const t of all(`SELECT * FROM trades WHERE league_id = ? AND status = 'review' AND process_at <= ? ORDER BY process_at`, league.id, at)) {
    try { validate(league, t); execute(league, t, t.process_at); }
    catch (err) { close(t, 'failed', err.message, at); F.log(league.id, `A trade between ${teamName(t.proposer_team_id)} and ${teamName(t.receiver_team_id)} fell through: ${err.message}`, 'trade'); }
  }
  botAnswers(league, now);
}

// Bots answer offers right away: the win bot takes a trade that gets it more season points than it
// gives up; the lose bot takes one that gets it fewer.
function botAnswers(league, now) {
  const bots = Object.fromEntries(F.botTeams(league.id).map((b) => [b.id, b.bot]));
  const offers = all(`SELECT * FROM trades WHERE league_id = ? AND status = 'pending'`, league.id).filter((t) => bots[t.receiver_team_id]);
  if (!offers.length) return;
  const totals = F.athleteTotals(league.sport, league.scoring);
  for (const t of offers) {
    const items = tradeItems(t.id);
    const sum = (team) => items.filter((i) => i.from_team_id === team).reduce((s, i) => s + (totals[i.athlete_id]?.points || 0), 0);
    const gets = sum(t.proposer_team_id), gives = sum(t.receiver_team_id);
    const yes = bots[t.receiver_team_id] === 'lose' ? gets < gives : gets > gives;
    try {
      if (yes) accept(league, t, now);
      else close(t, 'rejected', null, now.toISOString());
    } catch (err) {
      close(t, 'failed', err.message, now.toISOString());
    }
  }
}

// What a viewer can see: their own open offers both ways, every trade under review (the whole league
// can see those, like ESPN), and the last few finished ones. The commissioner sees every open offer.
function tradeList(league, viewerTeamId, commish) {
  const rows = all(
    `SELECT * FROM trades WHERE league_id = ? AND (
       status = 'review' OR (status = 'pending' AND (? OR proposer_team_id = ? OR receiver_team_id = ?))
       OR (status NOT IN ('pending', 'review') AND decided_at IS NOT NULL))
     ORDER BY CASE WHEN status IN ('pending', 'review') THEN 0 ELSE 1 END, COALESCE(decided_at, created_at) DESC LIMIT 40`,
    league.id, commish ? 1 : 0, viewerTeamId ?? -1, viewerTeamId ?? -1
  ).filter((t) => ['pending', 'review'].includes(t.status) || t.status === 'done' || t.status === 'vetoed'
    || t.proposer_team_id === viewerTeamId || t.receiver_team_id === viewerTeamId);
  const totals = F.athleteTotals(league.sport, league.scoring);
  return rows.slice(0, 25).map((t) => {
    const items = tradeItems(t.id).map((i) => ({
      athlete_id: i.athlete_id, from_team_id: i.from_team_id, name: nameOf(i.athlete_id),
      points: Math.round((totals[i.athlete_id]?.points || 0) * 10) / 10,
    }));
    return {
      ...t,
      proposer: teamName(t.proposer_team_id), receiver: teamName(t.receiver_team_id),
      gives: items.filter((i) => i.from_team_id === t.proposer_team_id),
      gets: items.filter((i) => i.from_team_id === t.receiver_team_id),
    };
  });
}

function waiverInfo(league, teams, myTeamId) {
  const order = waiverOrder(league, teams);
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  const players = all(
    `SELECT w.athlete_id, w.clears_at, a.name FROM waivers w JOIN athletes a ON a.id = w.athlete_id
      WHERE w.league_id = ? AND w.processed = 0 ORDER BY w.clears_at`, league.id
  );
  const claims = myTeamId ? all(
    `SELECT c.*, a.name, d.name AS drop_name, w.clears_at FROM waiver_claims c JOIN athletes a ON a.id = c.athlete_id
       LEFT JOIN athletes d ON d.id = c.drop_id
       LEFT JOIN waivers w ON w.league_id = c.league_id AND w.athlete_id = c.athlete_id AND w.processed = 0
      WHERE c.league_team_id = ? ORDER BY c.status = 'pending' DESC, c.id DESC LIMIT 15`, myTeamId
  ) : [];
  return {
    hours: league.waiver_hours,
    order: order.map((id, i) => ({ priority: i + 1, team_id: id, name: byId[id]?.name, owner_name: byId[id]?.owner_name })),
    players,
    claims,
  };
}

module.exports = {
  pastDeadline, onWaivers, putOnWaivers, waiverOrder, claim, processWaivers,
  propose, accept, validate, execute, close, processTrades, tradeList, waiverInfo, tradeItems,
};
