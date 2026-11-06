// The five intramural sports. Each stat is [key, label, default fantasy points per unit].
// Leagues copy the defaults when they are created, and the commissioner can change them later.

const SPORTS = {
  softball: {
    key: 'softball',
    name: 'Softball',
    icon: '🥎',
    rosterSize: 6,
    positions: ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'ROV', 'UT'],
    stats: [
      ['ab', 'At bats', 0],
      ['single', 'Singles', 1],
      ['double', 'Doubles', 2],
      ['triple', 'Triples', 3],
      ['hr', 'Home runs', 4],
      ['r', 'Runs', 1],
      ['rbi', 'RBI', 1],
      ['bb', 'Walks', 1],
      ['k', 'Strikeouts', -1],
      ['e', 'Errors', -1],
    ],
  },
  flag_football: {
    key: 'flag_football',
    name: 'Flag Football',
    icon: '🏈',
    rosterSize: 5,
    positions: ['QB', 'WR', 'RB', 'C', 'RUSH', 'LB', 'DB'],
    stats: [
      ['pass_td', 'Passing TDs', 4],
      ['pass_yds', 'Passing yards', 0.04],
      ['int_thrown', 'Interceptions thrown', -2],
      ['rush_td', 'Rushing TDs', 6],
      ['rush_yds', 'Rushing yards', 0.1],
      ['rec', 'Receptions', 1],
      ['rec_yds', 'Receiving yards', 0.1],
      ['rec_td', 'Receiving TDs', 6],
      ['xp', 'Extra points scored', 1],
      ['flag_pull', 'Flag pulls (tackles)', 1],
      ['sack', 'Sacks', 2],
      ['tfl', 'Tackles for loss', 1],
      ['pbu', 'Pass breakups', 1],
      ['def_int', 'Interceptions (D)', 3],
      ['def_td', 'Defensive TDs', 6],
      ['safety', 'Safeties', 2],
    ],
  },
  volleyball: {
    key: 'volleyball',
    name: 'Volleyball',
    icon: '🏐',
    rosterSize: 4,
    positions: ['S', 'OH', 'MB', 'OPP', 'L', 'DS'],
    // Chi's volleyball stat sheet columns and points (from the club, 2026-11-06).
    stats: [
      ['serves_made', 'Serves made', 0.5],
      ['serve_err', 'Serves missed', -1],
      ['aces', 'Aces', 3],
      ['bad_rec', 'Bad serve receives', -2],
      ['good_rec', 'Good serve receives', 2],
      ['attack_err', 'Attack errors', -5],
      ['attacks', 'Attacks', 2],
      ['kills', 'Kills', 3],
      ['assists', 'Assists', 1],
      ['blocks', 'Blocks', 4],
      ['digs', 'Digs', 2],
      ['dig_err', 'Dig errors', -3],
    ],
  },
  basketball: {
    key: 'basketball',
    name: 'Basketball',
    icon: '🏀',
    rosterSize: 5,
    positions: ['PG', 'SG', 'SF', 'PF', 'C'],
    stats: [
      ['pts', 'Points', 1],
      ['threes', '3-pointers made', 0.5],
      ['reb', 'Rebounds', 1.2],
      ['ast', 'Assists', 1.5],
      ['stl', 'Steals', 3],
      ['blk', 'Blocks', 3],
      ['tov', 'Turnovers', -1],
    ],
  },
  soccer: {
    key: 'soccer',
    name: 'Soccer',
    icon: '⚽',
    rosterSize: 6,
    positions: ['GK', 'DEF', 'MID', 'FWD'],
    stats: [
      ['goals', 'Goals', 6],
      ['assists', 'Assists', 3],
      ['shots_on', 'Shots on target', 1],
      ['saves', 'Saves', 1],
      ['clean_sheet', 'Clean sheet', 4],
      ['yellow', 'Yellow cards', -1],
      ['red', 'Red cards', -3],
      ['own_goal', 'Own goals', -2],
    ],
  },
};

function defaultScoring(sport) {
  const out = {};
  for (const [key, , pts] of SPORTS[sport].stats) out[key] = pts;
  return out;
}

// Fantasy points for one stat line: the sum of stat value x weight.
function scoreLine(stats, scoring) {
  let total = 0;
  for (const [key, weight] of Object.entries(scoring)) {
    total += (Number(stats[key]) || 0) * (Number(weight) || 0);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { SPORTS, defaultScoring, scoreLine };
