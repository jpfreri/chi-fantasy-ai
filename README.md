# ΧΛΦ Fantasy

Fantasy leagues for Chi Lambda Phi intramurals at Oklahoma Christian University: softball, flag football, volleyball, basketball and soccer. Each sport has its own league and its own snake draft, and the app shows the schedule, scores and box scores for every game.

## Run it

You need Node.js 22.13 or newer.

```bash
npm install
npm run seed     # optional: wipes the database and loads made-up demo data
npm start        # http://localhost:3000
```

With the demo data, log in as `commish` (admin) or `jp`, `quin`, `brody`, `steven`. Every password is `password`.

The demo data is built from the club's own files: the 2026-27 directory (names and flag football A/B teams only), the intramural stat sheets and the 26-27 softball, flag football and volleyball schedules. They live in `scripts/demo-data.json` and `scripts/schedules-2026-27.json`. Only this season's sheets ("Softball 26", "Football 26") are used, and names not in the directory (graduates) are left out. The sheets only have season totals, so the seed spreads each player's totals over his team's games at random; the totals add up exactly. Volleyball, basketball and soccer have not started, so their rosters and stats are empty for an admin to fill in.

Without the demo data, the first account you create becomes the commissioner (admin).

`npm test` runs the API tests (draft order, turn rules, auto-pick, scoring, add/drop, head-to-head records, playoffs).

## How a season works

1. **Admin → a sport → Manage:** add the intramural teams and paste in the players (`Name, Position, Team`, one per line).
2. **Schedule tab:** add the games.
3. **Fantasy leagues tab:** create the league. Members open it and join with a team name.
4. **League page:** set or randomize the draft order, then start the draft. The draft room updates live for everyone. When a pick clock runs out, the server drafts the best available player.
5. **After each game:** open it, choose **Enter score & stats**, type the box score and set the game to final. Standings update right away.
6. After the draft, managers can add and drop free agents. A player's points only count for games that start while they are on your roster.

### Chi teams and tiers

Chi fields several teams per sport (for example Chi A, Chi B and Chi B2 in flag football). On a sport's **Manage** tab each team can be marked as counting for intramural points or not, and each has a fantasy multiplier: a player's fantasy points from a game are multiplied by the multiplier of the team he played for. The demo uses A ×1, B ×0.75, and the non-points teams (Softball B, Flag Football B2, Volleyball C) ×0.5. In softball and flag football, members who are not on a listed roster go on the non-points team.

### Admin page

- **Chi rosters:** put every member on his team in each sport.
- **Games & stats:** every scheduled game, which ones still need stats, and an Edit button to set teams (for playoff slots), score, status and the box score. You can add subs to a box score.
- **Fantasy rosters & bots:** move any player onto any fantasy team (optionally counting his past games), remove players, and add secret bots.

### Secret bots

An admin can add two kinds of bot teams to a league before its draft: one that always tries to win (drafts and picks up the best available players) and one that always tries to lose (always takes the worst). They look like ordinary members to everyone else; only admins see the 🤖 badge. Bots draft instantly when on the clock and make at most one roster move every 6 hours during the season.

### Head-to-head and playoffs

Fantasy week N is intramural week N. When the draft ends, the app draws a round-robin schedule for the regular season (with a bye each week if the number of teams is odd). Each week you win if your players score more fantasy points than your opponent's. A week is final once every intramural game in it is marked final.

Standings rank teams by record, then by season points. The top 4 (or top 2) make the playoffs, which use the intramural weeks right after the regular season: semifinals (1 vs 4, 2 vs 3) and then a championship. Ties in the playoffs go to the higher seed. The commissioner sets the regular season length and playoff size under **Scoring & settings**. Changing the season length redraws the schedule.

Each league has its own scoring rules (points per stat), which the commissioner can change at any time. Everything recalculates from the raw stats.

## Settings

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DATA_DIR` | Folder for the SQLite database (default `./data`) |
| `CLUB_CODE` | If set, people need this code to create an account. Use it so only brothers can sign up. |
| `NODE_ENV=production` | Marks the login cookie as HTTPS-only |

## Deploying

It is one Node process and one SQLite file, so any host that runs Node and keeps a persistent disk works (Render, Railway, Fly.io, a small VPS). Point `DATA_DIR` at the persistent disk and set `CLUB_CODE`. A `Dockerfile` is included.

## How it's built

- `src/server.js`: Express API and static file server
- `src/fantasy.js`: standings, snake draft and auto-pick logic
- `src/sports.js`: the five sports, their stats, positions and default scoring
- `src/db.js`: SQLite schema (Node's built-in `node:sqlite`, so no native builds)
- `public/`: the web app (plain HTML, CSS and JavaScript, no build step). Club colors are CSS variables at the top of `public/styles.css`.

## Ideas for polishing

Starting lineups, trades, draft queues, a stat keeper role, push notifications, seasons that archive old games, league chat.
