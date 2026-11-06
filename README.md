# ΧΛΦ Fantasy

Fantasy leagues for Chi Lambda Phi intramurals at Oklahoma Christian University: softball, flag football, volleyball, basketball and soccer. Each sport has its own league and its own snake draft, and the app shows the schedule, scores and box scores for every game.

## Run it

You need Node.js 22.13 or newer.

```bash
npm install
npm run seed     # optional: wipes the database and loads made-up demo data
npm start        # http://localhost:3000
```

With the demo data, log in as `admin` (admin) or `jp`, `quinten`, `brody`, `steven`. Every password is `password`.

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

Every night Chi plays is a fantasy round, and all the Chi games that night count (so Chi A, B and C players all score). When the draft ends, the app draws a round-robin schedule so you play a different team each round (with a bye if the number of teams is odd). You win a round if your players score more fantasy points than your opponent's. A round is final once every Chi game that night is marked final. A commissioner can switch a league to weekly rounds (round N = intramural week N) under **Scoring & settings**.

Standings rank teams by record, then by season points. The top 4 (or top 2) make the playoffs, which use the last rounds of the season: semifinals (1 vs 4, 2 vs 3) and then a championship. Ties in the playoffs go to the higher seed. The commissioner sets the regular season length and playoff size under **Scoring & settings**. Changing the season length redraws the schedule. By default the regular season fills every round the playoffs don't need.

### ESPN-style league features

The league works like an ESPN fantasy league (modeled on the data the [espn-api](https://github.com/cwendt94/espn-api) project exposes):

- **Starters and bench.** Each team starts a set number of players (default: roster size minus one; the commissioner changes it under **Scoring & settings**). Only starters score. A new player fills an open starting spot, otherwise goes to the bench. A player locks once his Chi game has started that night and unlocks the next day. Lineup changes never rewrite past games: each stat line counts if the player was starting when that game began.
- **Box scores.** "See player points" on a matchup shows each side's starters and bench with projected and actual points.
- **Standings.** Record, then head-to-head among tied teams, then points for, then points against (ESPN's order). Streaks (W3, L1), playoff seeds, and each team's adds/drops. A league records card shows the top and lowest scorer, most points against, and the best and worst round.
- **Power rankings.** ESPN's formula: 80% two-step dominance (your wins plus the wins of the teams you beat), 15% average score, 5% average margin.
- **Players.** Free agents list average and projected points and the next game. Player pages show total, average, projected average, % rostered, % started and the next game.
- **Activity.** Filter the league log by adds and drops, trades, draft, commissioner moves, or league news.
- **Trades.** On **Rosters**, press **Propose trade** on another team, tick the players each side gives, and add a note. The other team accepts or rejects it on **Trades & waivers**. An accepted trade waits out the review period (default 24 hours), when the commissioner can veto it or approve it early, then goes through. Rosters can't go over the limit, so an uneven trade needs an open spot. If a player in an open offer gets traded or dropped first, the offer falls through. No trades are offered or accepted after the trade deadline. Bots answer offers right away.
- **Waivers.** A dropped player sits on waivers (default 24 hours). Teams put in a claim instead of adding him, with an optional player to drop. When his time is up, the claim from the team highest in the waiver order wins. The order is reverse standings (last place first), or reverse draft order before any round is final. The commissioner sets the trade deadline, review period and waiver period under **Scoring & settings** (0 hours turns either off).

### AI win predictions

Every matchup shows who the AI picks, the win chance, and both teams' projected points. Each player's expected points per game is his average fantasy points per game, pulled toward the club average for his tier until he has a few games (a game his team played where he has no stat line counts as 0). A team's projection is the sum over its players of expected points times the number of Chi games his team plays that night. The win chance comes from the gap between the two projections and how much single games usually vary. Upcoming and finished rounds use only games played before the round, so finished rounds show whether the pick was right, and the matchups tab keeps the AI's record. During a live round, the points already scored count as they are. It runs inside the app with no API key or cost.

Each league has its own scoring rules (points per stat), which the commissioner can change at any time. Everything recalculates from the raw stats.

## Demo version

`npm run demo` builds a separate demo database (`data/demo.db`) and starts the app at http://localhost:3001 with a red **Demo** badge. Your real leagues in `data/fantasy.db` are never touched. Every league has 4 teams of 6 players and is drafted. Softball and Flag Football are finished, and Basketball and Soccer (made-up games) have finished rounds, with AI predictions.

**Volleyball is the league to present.** It is drafted (4 people: admin, jp, brody, steven), with a trade, an open offer and a waiver claim, but no game has a score or stats yet, so every team is at 0. During the demo, upload a game night from `scripts/demo/game-nights/` (Admin > Games & stats > Upload), or type a game's score and stats by hand, and the matchups, standings and player points update right away. Each player who played gets +10 when his Chi team wins and -20 when it loses, before the tier multiplier.

`npm run demo` again resets the demo to that starting point. `npm run demo:start` restarts it without rebuilding. Log in as admin / password.

## Uploading stats from the stat sheet

Admin > Games & stats (or Enter score & stats on any game) has **Upload a game night from your stat sheet**. Export the sheet as CSV and pick it. Each section (A-Team, B-Team, C-Team) goes to that Chi team's game on the sheet's date, or the date you pick. Players can be first names, last names or nicknames (Q, Jerry); a shared first name goes to the player on that Chi team. Column titles are matched to the sport's stats, and % columns are ignored. Preview first, then save: the box scores, final scores (from "W 2-1" on the section row) and fantasy points update right away. Typing numbers by hand on a game's page still works too; each game lists the players on each Chi team.

## Settings

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DATA_DIR` | Folder for the SQLite database (default `./data`) |
| `CLUB_CODE` | If set, people need this code to create an account. Use it so only brothers can sign up. |
| `NODE_ENV=production` | Marks the login cookie as HTTPS-only |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Turn on "Continue with Google". See below. |
| `ADMIN_EMAILS` | Comma-separated Google emails that become admins when they sign in |
| `PUBLIC_URL` | The site's address, like `https://chi-fantasy.onrender.com`. Used to build the Google callback URL. Defaults to the address the browser used. |

Put these in a `.env` file next to `package.json` (copy `.env.example`). `npm start` reads it. Never commit `.env`.

## Google sign-in

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project (any name, like "Chi Fantasy").
2. Open **APIs & Services > OAuth consent screen**. Choose **External**, fill in the app name and your email, and add yourself as a test user. While the app is in "Testing", only test users can sign in, so add the brothers' emails there, or click **Publish app** when you're ready. The scopes it asks for (email, profile, openid) don't need Google's review.
3. Open **APIs & Services > Credentials > Create credentials > OAuth client ID**. Pick **Web application**.
4. Under **Authorized redirect URIs**, add `http://localhost:3000/auth/google/callback`. When you deploy, also add `https://<your site>/auth/google/callback`.
5. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, set `ADMIN_EMAILS` to your Gmail, and restart the app.

How accounts work:
- The first Google sign-in makes a new account named after your Google profile. After that, the same Google account always signs into it.
- Already have a username? Log in the normal way, open **Account**, and click **Link Google account**.
- Emails in `ADMIN_EMAILS` become admins (commissioners). Everyone else is a regular member.
- If `CLUB_CODE` is set, a new member types it on the sign-up page before clicking Google.
- Username and password login still works as a backup. Google accounts can set a password on the Account page.

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
