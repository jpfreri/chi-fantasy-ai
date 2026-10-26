const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'fantasy.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Real intramural teams (Chi Lambda Phi's own teams and the teams they play).
CREATE TABLE IF NOT EXISTS im_teams (
  id INTEGER PRIMARY KEY,
  sport TEXT NOT NULL,
  name TEXT NOT NULL,
  is_club INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sport, name)
);

-- Real people who play intramurals and can be drafted.
CREATE TABLE IF NOT EXISTS athletes (
  id INTEGER PRIMARY KEY,
  sport TEXT NOT NULL,
  name TEXT NOT NULL,
  position TEXT,
  im_team_id INTEGER REFERENCES im_teams(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  sport TEXT NOT NULL,
  week INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  location TEXT,
  home_team_id INTEGER REFERENCES im_teams(id) ON DELETE SET NULL,
  away_team_id INTEGER REFERENCES im_teams(id) ON DELETE SET NULL,
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | final
  notes TEXT
);

CREATE TABLE IF NOT EXISTS game_stats (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  stats TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (game_id, athlete_id)
);

CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY,
  sport TEXT NOT NULL,
  name TEXT NOT NULL,
  season TEXT,
  status TEXT NOT NULL DEFAULT 'setup', -- setup | drafting | active | complete
  roster_size INTEGER NOT NULL,
  pick_seconds INTEGER NOT NULL DEFAULT 90,
  scoring TEXT NOT NULL,
  clock_started_at INTEGER,          -- ms epoch when the current pick's clock started
  draft_paused INTEGER NOT NULL DEFAULT 0,
  paused_remaining INTEGER,          -- ms left on the clock when paused
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS league_teams (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  draft_slot INTEGER,
  UNIQUE (league_id, user_id)
);

CREATE TABLE IF NOT EXISTS draft_picks (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  pick_no INTEGER NOT NULL,
  round INTEGER NOT NULL,
  league_team_id INTEGER NOT NULL REFERENCES league_teams(id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  auto INTEGER NOT NULL DEFAULT 0,
  picked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (league_id, pick_no),
  UNIQUE (league_id, athlete_id)
);

-- Who owned whom and when. Points count for games that start while the player is on the roster.
CREATE TABLE IF NOT EXISTS roster (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  league_team_id INTEGER NOT NULL REFERENCES league_teams(id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL,
  dropped_at TEXT,
  how TEXT NOT NULL DEFAULT 'draft'
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Head-to-head regular season. Playoff games are worked out from the standings, so they are not stored.
CREATE TABLE IF NOT EXISTS matchups (
  id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  week INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES league_teams(id) ON DELETE CASCADE,
  away_team_id INTEGER NOT NULL REFERENCES league_teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_matchups_league ON matchups(league_id);
CREATE INDEX IF NOT EXISTS idx_athletes_sport ON athletes(sport);
CREATE INDEX IF NOT EXISTS idx_games_sport ON games(sport);
CREATE INDEX IF NOT EXISTS idx_roster_league ON roster(league_id);
`);

// Columns added after the first version. Older databases get them on startup.
function addColumn(table, column, definition) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('leagues', 'regular_weeks', 'INTEGER NOT NULL DEFAULT 5');
addColumn('leagues', 'playoff_teams', 'INTEGER NOT NULL DEFAULT 4');
// Chi fields several teams per sport. Some do not count for intramural points, and stats from
// lower teams are worth less in fantasy: each team's multiplier scales its players' points.
addColumn('im_teams', 'for_points', 'INTEGER NOT NULL DEFAULT 1');
addColumn('im_teams', 'multiplier', 'REAL NOT NULL DEFAULT 1');
// Secret bot managers: 'win' always tries to win, 'lose' always tries to lose. Only admins can see this.
addColumn('users', 'bot', 'TEXT');
addColumn('league_teams', 'bot_checked_at', 'INTEGER');

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

module.exports = { db, tx, one, all, run, DB_FILE };
