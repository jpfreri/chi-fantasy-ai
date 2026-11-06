// Reads a box score straight from the club's stat sheet, exported as CSV.
//
// The sheet looks like this (volleyball): a section title row per Chi team ("A-Team", "B-Team"),
// a "Player" header row with the stat columns, then one row per player by first name or nickname,
// and a TOTAL row. A section's header row may be blank after "Player"; it then reuses the last
// labeled header. Percentage columns and anything the sport doesn't score are ignored.
// Each section is matched to that Chi team's game on the section's date (or a date picked on upload).
const { all, one } = require('./db');
const { SPORTS } = require('./sports');

// Nicknames used on the sheets -> full names in the directory.
const NICKNAMES = { jerry: 'Jeremiah Lorance', q: 'Quinten Talamantes' };

// Extra column titles the sheets use for a stat, beyond its label in sports.js.
const ALIASES = {
  bad_rec: ['bad serve rec', 'bad rec'],
  good_rec: ['good serve rec', 'good rec'],
  serve_err: ['serves missed', 'service errors', 'serve errors'],
  serves_made: ['serves made'],
  dig_err: ['dig errors'],
  assists: ['assist', 'ast'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');

function parseCsv(text) {
  const rows = [];
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const cells = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === '\t') { cells.push(cur.trim()); cur = ''; } else cur += c;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

function columnKey(sport, title) {
  const n = norm(title);
  if (!n || /%/.test(title)) return null;
  for (const [key, label] of SPORTS[sport].stats) {
    if (n === norm(key) || n === norm(label) || (ALIASES[key] || []).some((a) => norm(a) === n)) return key;
  }
  return null;
}

// Section title row: "A-Team", "B Team", "Chi C" -> its team letter, plus anything else on that row:
// "Game 3", a date (MM/DD/YYYY) and a result ("W 2-1").
function sectionOf(row) {
  const letter = row[0].match(/^(?:chi\s+([a-z]\d?)|([a-z]\d?)\s*-?\s*team)$/i);
  if (!letter) return null;
  const rest = row.slice(1).join(' ');
  const d = rest.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const res = rest.match(/\b([WLT])\s*(\d+)\s*-\s*(\d+)/i);
  return {
    letter: (letter[1] || letter[2]).toUpperCase(),
    date: d ? `${d[3]}-${d[1].padStart(2, '0')}-${d[2].padStart(2, '0')}` : null,
    result: res ? { outcome: res[1].toUpperCase(), chi: Number(res[2]), opp: Number(res[3]) } : null,
  };
}

// Finds the athlete a sheet name means: exact full name, nickname, then a unique first or last name,
// preferring players on that Chi team when a name is shared.
function matcher(sport) {
  const people = all('SELECT id, name, im_team_id FROM athletes WHERE sport = ? AND active = 1', sport);
  const by = (fn) => (name) => people.filter((p) => fn(p, name));
  const exact = by((p, n) => p.name.toLowerCase() === n);
  const first = by((p, n) => p.name.toLowerCase().split(/\s+/)[0] === n);
  const lastN = by((p, n) => p.name.toLowerCase().split(/\s+/).slice(-1)[0] === n);
  return (raw, teamId) => {
    const n = raw.trim().toLowerCase();
    if (NICKNAMES[n]) return exact(NICKNAMES[n].toLowerCase())[0] || null;
    for (const list of [exact(n), first(n), lastN(n)]) {
      if (list.length === 1) return list[0];
      const onTeam = list.filter((p) => p.im_team_id === teamId);
      if (onTeam.length === 1) return onTeam[0];
      if (list.length > 1) return { ambiguous: list.map((p) => p.name) };
    }
    return null;
  };
}

const TZ = 'America/Chicago';
const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

// Reads a whole game night (or several). Each section is matched to the game its Chi team played that
// day: the date on the section row, or `date` (YYYY-MM-DD) when the sheet has none.
// Returns { sections: [{ letter, date, game, result, rows, unmatched }], problems: [text] }.
function readSheet(sport, text, date = null) {
  if (!SPORTS[sport]) throw Object.assign(new Error('Unknown sport.'), { status: 400 });
  const grid = parseCsv(text).filter((r) => r.some((c) => c));
  const sections = [];
  let cur = null, labeled = null;
  for (const r of grid) {
    const sec = sectionOf(r);
    if (sec) { cur = { ...sec, raw: [] }; sections.push(cur); continue; }
    if (/^player$/i.test(r[0])) { if (r.slice(1).some((c) => c)) labeled = r; if (cur) cur.header = labeled; continue; }
    if (!r[0] || /^total/i.test(r[0])) continue;
    if (!cur) { cur = { letter: null, date: null, result: null, raw: [] }; sections.push(cur); }
    if (!cur.header) cur.header = labeled;
    cur.raw.push(r);
  }
  if (!labeled) throw Object.assign(new Error('Could not find the "Player" header row with the stat columns.'), { status: 400 });
  const find = matcher(sport);
  const problems = [];
  const out = [];
  for (const sec of sections.filter((x) => x.raw.length)) {
    const day = sec.date || date;
    const club = sec.letter ? one(`SELECT * FROM im_teams WHERE sport = ? AND is_club = 1 AND name = ?`, sport, `Chi ${sec.letter}`) : null;
    if (sec.letter && !club) { problems.push(`There is no Chi ${sec.letter} team in ${SPORTS[sport].name}.`); continue; }
    let game = null;
    if (club && day) {
      game = all(`SELECT g.*, h.name AS home_name, a.name AS away_name FROM games g
          LEFT JOIN im_teams h ON h.id = g.home_team_id LEFT JOIN im_teams a ON a.id = g.away_team_id
         WHERE g.sport = ? AND (g.home_team_id = ? OR g.away_team_id = ?)`, sport, club.id, club.id)
        .find((g) => dayOf(g.starts_at) === day) || null;
    }
    const label = sec.letter ? `Chi ${sec.letter}` : 'The sheet';
    if (!day) problems.push(`${label}: the sheet has no date. Pick the game night's date.`);
    else if (!game) problems.push(`${label} has no game on ${day}.`);
    const cols = (sec.header || labeled).map((title, i) => [i, columnKey(sport, title)]).filter(([i, k]) => i > 0 && k);
    const rows = [], unmatched = [];
    for (const r of sec.raw) {
      const stats = {};
      for (const [i, k] of cols) {
        const v = Number(String(r[i] || '').replace(/[^0-9.\-]/g, ''));
        if (r[i] && Number.isFinite(v) && v) stats[k] = v;
      }
      const who = find(r[0], club?.id);
      if (!who) unmatched.push({ sheet_name: r[0], reason: 'No player with that name.' });
      else if (who.ambiguous) unmatched.push({ sheet_name: r[0], reason: `Could be ${who.ambiguous.join(' or ')}. Use the full name in the sheet.` });
      else rows.push({ sheet_name: r[0], athlete_id: who.id, name: who.name, stats });
    }
    out.push({
      letter: sec.letter, date: day, result: sec.result, rows, unmatched,
      columns: cols.map(([, k]) => k),
      game: game ? { id: game.id, home_name: game.home_name, away_name: game.away_name, starts_at: game.starts_at, status: game.status,
        club_home: game.home_team_id === club.id } : null,
    });
  }
  return { sections: out, problems };
}

module.exports = { readSheet, parseCsv, NICKNAMES };
