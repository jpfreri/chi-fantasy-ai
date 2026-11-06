// ΧΛΦ Fantasy: a small single-page app. Each route renders HTML into #app.
// Clicks on [data-act] and submits on form[data-form] go to the handlers the current page registers.

const S = { me: null, meta: null, sports: {} };
let actions = {};
let forms = {};
let cleanup = [];

// ---------- Helpers ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth')) {
      S.me = null;
      location.hash = '#/login';
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b = {}) => api('POST', u, b);
const PUT = (u, b = {}) => api('PUT', u, b);
const DEL = (u) => api('DELETE', u);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3200);
}

// Games are on campus in Oklahoma, so times always show in Central time wherever you open the app.
const TZ = 'America/Chicago';

function fmtDate(iso, withTime = true) {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });
  return withTime ? `${day} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: TZ })}` : day;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function fromLocalInput(v) {
  return v ? new Date(v).toISOString() : null;
}

const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 >= 11 && n % 100 <= 13) || n % 10 > 3 ? 0 : n % 10]}`;
const pts = (n) => `<span class="pts ${n < 0 ? 'neg' : ''}">${Number(n || 0).toFixed(1)}</span>`;
// Round initials badge with a color picked from the name, for players and teams.
function avatar(name, size = '') {
  const words = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/);
  const ini = ((words[0]?.[0] || '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) % 360;
  return `<span class="av ${size}" style="--h:${h}" aria-hidden="true">${esc(ini)}</span>`;
}
const posChip = (p) => (p ? `<span class="pos">${esc(p)}</span>` : '');
const statusBadge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const sportName = (k) => `${S.sports[k]?.icon || ''} ${esc(S.sports[k]?.name || k)}`;
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const options = (list, selected, label = (x) => x.name, value = (x) => x.id) =>
  list.map((x) => `<option value="${esc(value(x))}" ${String(value(x)) === String(selected) ? 'selected' : ''}>${esc(label(x))}</option>`).join('');

function render(html) {
  document.getElementById('app').innerHTML = html;
}

function onCleanup(fn) {
  cleanup.push(fn);
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  try {
    await actions[el.dataset.act](el, e);
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form || !forms[form.dataset.form]) return;
  e.preventDefault();
  const btn = form.querySelector('button[type=submit], button:not([type])');
  if (btn) btn.disabled = true;
  try {
    await forms[form.dataset.form](formData(form), form);
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ---------- Nav & routing ----------

function renderNav() {
  const nav = document.getElementById('nav');
  if (!S.me) {
    nav.innerHTML = '';
    document.getElementById('tabbar').innerHTML = '';
    return;
  }
  const here = location.hash;
  const link = (href, text) => `<a href="${href}" class="${here.startsWith(href) && href !== '#/' ? 'on' : ''}">${text}</a>`;
  nav.innerHTML = `
    ${link('#/', 'Home')}
    ${Object.values(S.sports).map((s) => link(`#/sport/${s.key}`, `${s.icon} ${esc(s.name)}`)).join('')}
    ${S.me.is_admin ? link('#/admin', 'Admin') : ''}
    <span class="spacer"></span>
    <a href="#/account" class="keep who" title="Account">${avatar(S.me.display_name, 'sm')}<span class="who-name">${esc(S.me.display_name)}</span></a>
    <a href="#" class="keep" data-act="logout">Log out</a>`;
  // Phone: a floating tab bar at the bottom, like a sports app.
  const tab = (href, icon, text, on) => `<a href="${href}" class="${on ? 'on' : ''}"><span class="i">${icon}</span>${text}</a>`;
  const sportOn = (k) => here.startsWith(`#/sport/${k}`);
  document.getElementById('tabbar').innerHTML = `
    ${tab('#/', '🏠', 'Home', here === '#/' || here === '' || here.startsWith('#/league'))}
    ${Object.values(S.sports).map((s) => tab(`#/sport/${s.key}`, s.icon, esc(s.name.split(' ')[0]), sportOn(s.key))).join('')}
    ${S.me.is_admin ? tab('#/admin', '⚙️', 'Admin', here.startsWith('#/admin')) : ''}`;
}

const routes = [
  [/^#\/login$/, pageLogin],
  [/^#\/register$/, pageRegister],
  [/^#\/sport\/(\w+)(?:\/(\w+))?$/, pageSport],
  [/^#\/game\/(\d+)(?:\/(edit))?$/, pageGame],
  [/^#\/player\/(\d+)$/, pagePlayer],
  [/^#\/league\/(\d+)\/draft$/, pageDraft],
  [/^#\/league\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/, pageLeague],
  [/^#\/admin(?:\/(\w+))?(?:\/(\w+))?$/, pageAdmin],
  [/^#\/account$/, pageAccount],
  [/^#?\/?$/, pageHome],
];

async function route() {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  actions = { logout: doLogout, closeDialog };
  closeDialog();
  forms = {};
  const hash = location.hash || '#/';
  const publicPage = hash === '#/login' || hash === '#/register';
  if (!S.me && !publicPage) {
    location.hash = '#/login';
    return;
  }
  renderNav();
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(...m.slice(1));
      } catch (err) {
        render(`<div class="card"><h2>Something went wrong</h2><p>${esc(err.message)}</p><a href="#/">Back home</a></div>`);
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  render('<div class="card"><h2>Page not found</h2><a href="#/">Back home</a></div>');
}

// A simple modal. Content is HTML; buttons inside use data-act like everything else.
function openDialog(html) {
  closeDialog();
  const dlg = document.createElement('dialog');
  dlg.id = 'dlg';
  dlg.innerHTML = `<button class="dlg-x secondary small" data-act="closeDialog" aria-label="Close">✕</button>${html}`;
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

function closeDialog() {
  document.getElementById('dlg')?.close();
}

async function doLogout() {
  await POST('/api/auth/logout');
  S.me = null;
  location.hash = '#/login';
}

async function refreshMe() {
  S.me = (await GET('/api/me')).user;
}

// ---------- Auth pages ----------

function pageLogin() {
  if (S.me) return (location.hash = '#/');
  render(`
    <div class="auth card">
      <h1>Welcome back</h1>
      <p class="muted">Chi Lambda Phi intramural fantasy. Draft your brothers, talk your trash.</p>
      <form data-form="login">
        <div class="field"><label>Username</label><input name="username" autocomplete="username" required></div>
        <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
        <button type="submit">Log in</button>
      </form>
      ${googleButton()}
      <p class="switch muted small">New here? <a href="#/register">Create an account</a></p>
    </div>`);
  forms.login = async (d) => {
    await POST('/api/auth/login', d);
    await refreshMe();
    location.hash = '#/';
  };
}

// "Continue with Google" sends the browser through /auth/google. On sign-up the club code goes along.
function googleButton(withCode) {
  if (!S.meta.google) return '';
  actions.google = () => {
    const code = withCode ? document.querySelector('input[name=club_code]')?.value.trim() : '';
    if (withCode && !code) return toast('Enter the club code first', true);
    location.href = '/auth/google' + (code ? `?club_code=${encodeURIComponent(code)}` : '');
  };
  return `<div class="or muted small">or</div>
    <button class="secondary google" data-act="google"><span class="g">G</span> Continue with Google</button>`;
}

function pageRegister() {
  if (S.me) return (location.hash = '#/');
  render(`
    <div class="auth card">
      <h1>Join the league</h1>
      ${S.meta.firstUser ? '<p class="badge drafting">You are the first account, so you will be the commissioner.</p>' : ''}
      <form data-form="register">
        <div class="field"><label>Your name (shown to everyone)</label><input name="display_name" required></div>
        <div class="field"><label>Username</label><input name="username" autocomplete="username" required></div>
        <div class="field"><label>Password (6+ characters)</label><input name="password" type="password" autocomplete="new-password" required></div>
        ${S.meta.needsClubCode ? '<div class="field"><label>Club code (ask a commissioner)</label><input name="club_code" required></div>' : ''}
        <button type="submit">Create account</button>
      </form>
      ${googleButton(S.meta.needsClubCode)}
      <p class="switch muted small">Already have one? <a href="#/login">Log in</a></p>
    </div>`);
  forms.register = async (d) => {
    await POST('/api/auth/register', d);
    S.meta.firstUser = false;
    await refreshMe();
    location.hash = '#/';
  };
}

function pageAccount() {
  render(`
    <div class="page-head"><h1>Your account</h1></div>
    <div class="grid two">
      <form class="card" data-form="name">
        <h2>Display name</h2>
        <div class="field"><input name="display_name" value="${esc(S.me.display_name)}" required></div>
        <button>Save</button>
      </form>
      <form class="card" data-form="pw">
        <h2>${S.me.has_password ? 'Change password' : 'Set a password'}</h2>
        ${S.me.has_password ? '' : '<p class="muted small">You signed up with Google. Set a password if you also want to log in with your username.</p>'}
        ${S.me.has_password ? '<div class="field"><label>Current password</label><input name="current_password" type="password" required></div>' : ''}
        <div class="field"><label>New password</label><input name="new_password" type="password" required></div>
        <button>${S.me.has_password ? 'Change password' : 'Set password'}</button>
      </form>
      ${S.meta.google ? `<div class="card">
        <h2>Google</h2>
        ${S.me.email ? `<p>Linked to <strong>${esc(S.me.email)}</strong>. You can sign in with Google.</p>` : '<p class="muted">Link your Google account so you can sign in with it.</p>'}
        <a class="btn secondary" href="/auth/google">${S.me.email ? 'Link a different Google account' : 'Link Google account'}</a>
      </div>` : ''}
    </div>`);
  forms.name = async (d) => {
    await PUT('/api/me', d);
    await refreshMe();
    renderNav();
    toast('Saved');
  };
  forms.pw = async (d, f) => {
    await PUT('/api/me', d);
    f.reset();
    const set = !S.me.has_password;
    await refreshMe();
    if (set) pageAccount();
    toast(set ? 'Password set' : 'Password changed');
  };
}

// ---------- Shared bits ----------

function gameRow(g) {
  const final = g.status === 'final';
  const homeWin = final && g.home_score > g.away_score;
  const awayWin = final && g.away_score > g.home_score;
  const showScore = g.status !== 'scheduled' && g.home_score != null;
  return `
    <a class="game-row" href="#/game/${g.id}">
      <div class="teams">
        ${!g.home_name && !g.away_name && g.notes ? `<div><span><strong>${esc(g.notes)}</strong> <span class="muted small">· teams TBD</span></span></div>` : `
        <div class="${awayWin ? 'win' : ''}"><span>${esc(g.away_name || 'TBD')}</span><span>${showScore ? esc(g.away_score) : ''}</span></div>
        <div class="${homeWin ? 'win' : ''}"><span>${esc(g.home_name || 'TBD')}</span><span>${showScore ? esc(g.home_score) : ''}</span></div>`}
      </div>
      <div class="meta">
        ${g.status === 'scheduled' ? fmtDate(g.starts_at) : statusBadge(g.status)}
        <div>${g.sport && !location.hash.startsWith('#/sport') ? sportName(g.sport) : `Week ${esc(g.week)}`}</div>
        ${g.location ? `<div>${esc(g.location)}</div>` : ''}
      </div>
    </a>`;
}

// ---------- Home ----------

async function pageHome() {
  const d = await GET('/api/home');
  const joined = new Set(d.myTeams.map((t) => t.league_id));
  const open = d.leagues.filter((l) => l.status === 'setup' && !joined.has(l.id));
  render(`
    <div class="page-head hello">${avatar(S.me.display_name, 'lg')}<div class="grow"><div class="muted small">Welcome back</div>
      <h1>Hey ${esc(S.me.display_name.split(' ')[0])} 👋</h1></div></div>

    <div class="sport-chips">
      ${Object.values(S.sports).map((s) => `
        <a class="sport-chip" href="#/sport/${s.key}"><span class="icon">${s.icon}</span>${esc(s.name)}</a>`).join('')}
    </div>

    ${d.allLeagues ? adminLeagues(d.allLeagues) : ''}

    <div class="card">
      <h2>My fantasy teams</h2>
      ${d.myTeams.length ? `<div class="grid cards">${d.myTeams.map((t) => `
        <div class="card" style="margin:0">
          <div class="row"><strong>${sportName(t.sport)}</strong><span class="grow"></span>${statusBadge(t.status)}</div>
          <div class="who-cell" style="margin:10px 0 2px">${avatar(t.team_name)}<h3 style="margin:0"><a href="#/league/${t.league_id}">${esc(t.team_name)}</a></h3></div>
          <div class="muted small">${esc(t.league_name)}</div>
          <div class="row" style="margin-top:8px">
            ${t.status === 'setup' ? `<span class="muted small">Waiting for the draft · ${t.teams} teams</span>` : ''}
            ${t.status === 'drafting' ? `<a class="btn gold" href="#/league/${t.league_id}/draft">Enter draft room</a>` : ''}
            ${['active', 'complete'].includes(t.status) ? `<span><strong>${t.w}-${t.l}${t.ties ? `-${t.ties}` : ''}</strong> · ${ordinal(t.rank)} of ${t.teams}</span><span class="grow"></span>${pts(t.points)}<span class="muted small">pts</span>` : ''}
          </div>
          ${t.champion ? `<div class="small" style="margin-top:8px">🏆 Champion: <strong>${esc(t.champion.name)}</strong></div>`
            : t.matchup && t.status === 'active' ? `<a class="minimatch" href="#/league/${t.league_id}/matchups/${t.week}">
              <span class="muted small">${t.matchup.label ? esc(t.matchup.label) : `${t.round_by === 'week' ? 'Week' : 'Round'} ${t.week}`} vs ${esc(t.matchup.opponent)}
                ${t.matchup.win_chance != null && t.matchup.state !== 'final' ? `<br>🤖 ${Math.round(t.matchup.win_chance * 100)}% to win` : ''}</span>
              <span>${t.matchup.state === 'upcoming' ? statusBadge('upcoming') : `${pts(t.matchup.mine)} – ${pts(t.matchup.theirs)}`}</span></a>` : ''}
        </div>`).join('')}</div>` : '<p class="empty">You are not in any leagues yet. Join one below or ask a commissioner to create one.</p>'}
    </div>

    ${open.length ? `<div class="card"><h2>Leagues open to join</h2>
      <table><tbody>${open.map((l) => `<tr class="click" data-act="go" data-href="#/league/${l.id}">
        <td>${sportName(l.sport)}</td><td><strong>${esc(l.name)}</strong></td><td class="muted">${esc(l.season || '')}</td>
        <td class="num"><a href="#/league/${l.id}">Join →</a></td></tr>`).join('')}</tbody></table></div>` : ''}

    <div class="grid two">
      <div class="card"><h2>Live &amp; coming up</h2>${d.upcoming.map(gameRow).join('') || '<p class="empty">No games scheduled.</p>'}</div>
      <div class="card"><h2>Recent results</h2>${d.recent.map(gameRow).join('') || '<p class="empty">No results yet.</p>'}</div>
    </div>`);
  actions.go = (el) => (location.hash = el.dataset.href);
}

// The commissioner's dashboard: every league, its leader and this round's matchups, one click from each tab.
function adminLeagues(list) {
  const rec = (x) => `${x.w}-${x.l}${x.t ? `-${x.t}` : ''}`;
  const unit = (l) => (l.round_by === 'week' ? 'Week' : 'Round');
  const roundName = (l) => (l.week > l.regular_weeks ? (l.week === l.last_week ? 'Championship' : 'Playoffs') : `${unit(l)} ${l.week}`);
  const card = (l) => {
    const live = l.status === 'active' || l.status === 'complete';
    const links = live
      ? [['matchups', 'Matchups'], ['standings', 'Standings'], ['rosters', 'Rosters'], ['trades', 'Trades'], ['activity', 'Activity']]
      : l.status === 'drafting' ? [['draft', 'Draft room'], ['setup', 'Teams']] : [['setup', 'Draft setup']];
    return `<div class="card admin-league">
      <div class="row"><span class="big-icon sm">${S.sports[l.sport]?.icon || ''}</span>
        <div class="grow"><a href="#/league/${l.id}"><strong>${esc(l.name)}</strong></a><div class="muted small">${l.teams} teams${l.season ? ` · ${esc(l.season)}` : ''}</div></div>
        ${statusBadge(l.status === 'complete' ? 'final' : l.status)}</div>
      ${l.champion ? `<p class="small" style="margin:10px 0 0">🏆 Champion: <strong>${esc(l.champion)}</strong></p>`
        : l.leader ? `<p class="small" style="margin:10px 0 0">Leader: <strong>${esc(l.leader.name)}</strong> <span class="muted">${rec(l.leader)} · ${esc(l.leader.owner || '')}</span></p>` : ''}
      ${l.draft ? `<p class="small" style="margin:10px 0 0">Draft: pick ${l.draft.made + 1} of ${l.draft.total}${l.draft.on_clock ? ` · <strong>${esc(l.draft.on_clock)}</strong> on the clock` : ''}</p>` : ''}
      ${l.status === 'setup' ? `<p class="small muted" style="margin:10px 0 0">Waiting for the draft.</p>` : ''}
      ${l.matchups.length ? `<div class="muted small" style="margin-top:10px">${esc(roundName(l))}</div>
        ${l.matchups.map((m) => `<a class="minimatch" href="#/league/${l.id}/matchups/${l.week}">
          <span class="small">${esc(m.away)} <span class="muted">vs</span> ${esc(m.home)}${m.pick && m.state !== 'final' ? `<br><span class="muted">🤖 ${esc(m.pick)} ${m.pick_pct}%</span>` : ''}</span>
          <span>${m.state === 'upcoming' ? statusBadge('upcoming') : `${Number(m.away_points).toFixed(1)} – ${Number(m.home_points).toFixed(1)}`}</span></a>`).join('')}` : ''}
      <div class="row" style="margin-top:12px;gap:6px">${links.map(([k, label]) => `<a class="btn secondary small" href="#/league/${l.id}${k === 'draft' ? '/draft' : `/${k}`}">${label}</a>`).join('')}</div>
    </div>`;
  };
  return `<div class="card"><div class="row"><h2 style="margin:0">Commissioner view</h2><span class="badge seedb">Admin</span><span class="grow"></span>
      <span class="muted small">Every league, live</span></div>
    <p class="muted small">As admin you can open any league, see every team's roster and matchups, set any team's lineup, and review trades.</p>
    <div class="grid cards">${list.map(card).join('')}</div></div>`;
}

// ---------- Sport ----------

async function pageSport(key, tab = 'schedule') {
  const d = await GET(`/api/sports/${key}`);
  const s = d.sport;
  const isAdmin = S.me.is_admin;
  const tabs = [['schedule', 'Schedule'], ['standings', 'Standings'], ['players', 'Players'], ['leagues', 'Fantasy leagues']];
  if (isAdmin) tabs.push(['manage', 'Manage']);
  const weeks = [...new Set(d.games.map((g) => g.week))];

  const body = {
    schedule: () => {
      const shown = (w) => d.games.filter((g) => g.week === w && (allGames || g.club_game || (!g.home_team_id && !g.away_team_id)));
      return `
      ${isAdmin ? `<details class="card"><summary><strong>Add a game</strong></summary>${gameForm(d.teams, {})}</details>` : ''}
      <div class="row" style="margin-bottom:12px"><span class="muted small">${allGames ? 'Showing every intramural game.' : 'Showing Chi games and playoff slots.'}</span>
        <a href="#" class="small" data-act="toggleAll">${allGames ? 'Only Chi games' : 'Show all games'}</a></div>
      ${weeks.length ? weeks.map((w) => `
        <div class="card"><h2>Week ${esc(w)} <span class="muted small">· ${fmtDate(d.games.find((g) => g.week === w)?.starts_at, false)}</span></h2>
          ${shown(w).map(gameRow).join('') || '<p class="empty">No Chi games this week.</p>'}</div>`).join('')
        : '<div class="card empty">No games yet.</div>'}`;
    },

    standings: () => `
      <div class="card table-wrap"><table>
        <thead><tr><th>Team</th><th class="num">W</th><th class="num">L</th><th class="num">T</th><th class="num">PF</th><th class="num">PA</th></tr></thead>
        <tbody>${[...d.teams].sort((a, b) => b.record.w - a.record.w || a.record.l - b.record.l).map((t) => `
          <tr><td>${esc(t.name)} ${teamBadges(t)}</td>
          <td class="num">${t.record.w}</td><td class="num">${t.record.l}</td><td class="num">${t.record.t}</td>
          <td class="num">${t.record.pf}</td><td class="num">${t.record.pa}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No teams yet.</td></tr>'}
        </tbody></table></div>`,

    players: () => `
      <div class="card">
        <p class="muted small">Fantasy points use the default ${esc(s.name.toLowerCase())} scoring. Each league can set its own.</p>
        <div class="table-wrap"><table>
        <thead><tr><th>Player</th><th>Pos</th><th>Team</th><th class="num">GP</th><th class="num">Fantasy pts</th></tr></thead>
        <tbody>${d.athletes.filter((a) => a.active).sort((a, b) => b.points - a.points).map((a) => `
          <tr class="click" data-act="go" data-href="#/player/${a.id}"><td><a href="#/player/${a.id}">${esc(a.name)}</a></td>
          <td>${esc(a.position || '')}</td><td>${esc(a.team_name || '')}</td><td class="num">${a.games}</td><td class="num">${pts(a.points)}</td></tr>`).join('') ||
          '<tr><td colspan="5" class="empty">No players yet.</td></tr>'}
        </tbody></table></div></div>`,

    leagues: () => `
      <div class="card">
        ${d.leagues.length ? `<table><tbody>${d.leagues.map((l) => `
          <tr class="click" data-act="go" data-href="#/league/${l.id}"><td><a href="#/league/${l.id}"><strong>${esc(l.name)}</strong></a></td>
          <td class="muted">${esc(l.season || '')}</td><td class="num">${statusBadge(l.status)}</td></tr>`).join('')}</tbody></table>`
          : `<p class="empty">No ${esc(s.name.toLowerCase())} fantasy league yet.</p>`}
      </div>
      ${isAdmin ? `<form class="card" data-form="league">
        <h2>Create a ${esc(s.name.toLowerCase())} league</h2>
        <div class="form-grid">
          <div class="field"><label>League name</label><input name="name" value="ΧΛΦ ${esc(s.name)}" required></div>
          <div class="field"><label>Season</label><input name="season" placeholder="Fall 2026"></div>
          <div class="field"><label>Players per team</label><input name="roster_size" type="number" min="1" max="20" value="${s.rosterSize}"></div>
          <div class="field"><label>Seconds per pick (0 = no clock)</label><input name="pick_seconds" type="number" min="0" value="90"></div>
          <div class="field"><label>Rounds</label><select name="round_by"><option value="game">One per Chi game night</option><option value="week">One per intramural week</option></select></div>
          <div class="field"><label>Regular season rounds (blank = fill the season)</label><input name="regular_weeks" type="number" min="1" max="30" placeholder="Auto"></div>
          <div class="field"><label>Trade deadline (last day)</label><input name="trade_deadline" type="date" value="${esc(L.trade_deadline || '')}"></div>
        <div class="field"><label>Trade review period (hours, 0 = none)</label><input name="trade_review_hours" type="number" min="0" max="168" value="${L.trade_review_hours}"></div>
        <div class="field"><label>Waiver period (hours, 0 = none)</label><input name="waiver_hours" type="number" min="0" max="168" value="${L.waiver_hours}"></div>
        <div class="field"><label>Playoff teams</label><select name="playoff_teams"><option value="4">Top 4 (semis + final)</option><option value="2">Top 2 (final)</option><option value="0">No playoffs</option></select></div>
        </div>
        <p class="muted small">Each round you play a different fantasy team. With game-night rounds, every night Chi plays is a round, and all the Chi games that night count. The playoffs use the last rounds of the season.</p>
        <button>Create league</button>
      </form>` : ''}`,

    manage: () => manageSport(d),
  };

  render(`
    <div class="page-head"><span class="big-icon">${s.icon}</span><h1>${esc(s.name)}</h1></div>
    <div class="tabs">${tabs.map(([k, label]) => `<a href="#/sport/${key}/${k}" class="${k === tab ? 'on' : ''}">${label}</a>`).join('')}</div>
    ${(body[tab] || body.schedule)()}`);

  actions.go = (el) => (location.hash = el.dataset.href);
  forms.game = async (f) => {
    const { id } = await POST('/api/games', { ...f, sport: key, starts_at: fromLocalInput(f.starts_at) });
    toast('Game added');
    location.hash = `#/game/${id}`;
  };
  forms.league = async (f) => {
    const { id } = await POST('/api/leagues', { ...f, sport: key });
    location.hash = `#/league/${id}`;
  };
  forms.team = async (f, form) => {
    await POST('/api/teams', { ...f, sport: key, is_club: !!f.is_club });
    toast('Team added');
    pageSport(key, 'manage');
  };
  forms.athlete = async (f) => {
    await POST('/api/athletes', { ...f, sport: key });
    toast('Player added');
    pageSport(key, 'manage');
  };
  forms.bulk = async (f) => {
    const { added } = await POST('/api/athletes/bulk', { ...f, sport: key });
    toast(`Added ${added} players`);
    pageSport(key, 'manage');
  };
  actions.delTeam = async (el) => {
    if (!confirm('Delete this team? Its games will show TBD.')) return;
    await DEL(`/api/teams/${el.dataset.id}`);
    pageSport(key, 'manage');
  };
  actions.renameTeam = async (el) => {
    const t = d.teams.find((x) => x.id === Number(el.dataset.id));
    const name = prompt('Team name', t.name);
    if (!name) return;
    await PUT(`/api/teams/${t.id}`, { name, is_club: t.is_club });
    pageSport(key, 'manage');
  };
  actions.toggleClub = async (el) => {
    const t = d.teams.find((x) => x.id === Number(el.dataset.id));
    await PUT(`/api/teams/${t.id}`, { name: t.name, is_club: !t.is_club });
    pageSport(key, 'manage');
  };
  actions.delAthlete = async (el) => {
    if (!confirm('Remove this player from the pool?')) return;
    const r = await DEL(`/api/athletes/${el.dataset.id}`);
    toast(r.archived ? 'Player archived (they have history, so it is kept)' : 'Player removed');
    pageSport(key, 'manage');
  };
  actions.restoreAthlete = async (el) => {
    await PUT(`/api/athletes/${el.dataset.id}`, { active: true });
    pageSport(key, 'manage');
  };
  actions.toggleAll = () => {
    allGames = !allGames;
    pageSport(key, 'schedule');
  };
  document.querySelectorAll('[data-team-flag]').forEach((box) => box.addEventListener('change', async () => {
    try { await PUT(`/api/teams/${box.dataset.teamFlag}`, { for_points: box.checked }); toast('Saved'); } catch (err) { toast(err.message, true); }
  }));
  document.querySelectorAll('[data-team-mult]').forEach((input) => input.addEventListener('change', async () => {
    try { await PUT(`/api/teams/${input.dataset.teamMult}`, { multiplier: input.value }); toast('Saved. Fantasy points recalculate everywhere.'); } catch (err) { toast(err.message, true); }
  }));
  // Inline edits on the manage table save on change.
  document.querySelectorAll('[data-edit-athlete]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await PUT(`/api/athletes/${input.dataset.editAthlete}`, { [input.name]: input.value });
        toast('Saved');
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

// Remembered while you move around, so the schedule keeps your choice.
let allGames = false;

function teamBadges(t) {
  if (!t) return '';
  return `${t.is_club ? '<span class="badge club">ΧΛΦ</span>' : ''}
    ${t.is_club && !t.for_points ? '<span class="badge" title="Does not count for intramural points">no IM pts</span>' : ''}
    ${t.is_club && Number(t.multiplier) !== 1 ? `<span class="badge" title="Fantasy points are multiplied by this">×${Number(t.multiplier)}</span>` : ''}`;
}

function gameForm(teams, g) {
  const statuses = ['scheduled', 'live', 'final'].map((x) => ({ id: x, name: x }));
  return `
    <form data-form="game" style="margin-top:12px">
      <div class="form-grid">
        <div class="field"><label>Away team</label><select name="away_team_id" required><option value="">Pick…</option>${options(teams, g.away_team_id)}</select></div>
        <div class="field"><label>Home team</label><select name="home_team_id" required><option value="">Pick…</option>${options(teams, g.home_team_id)}</select></div>
        <div class="field"><label>Date & time</label><input name="starts_at" type="datetime-local" value="${toLocalInput(g.starts_at)}" required></div>
        <div class="field"><label>Week</label><input name="week" type="number" min="1" value="${esc(g.week || 1)}"></div>
        <div class="field"><label>Location</label><input name="location" value="${esc(g.location || '')}" placeholder="RAC Court 1"></div>
        <div class="field"><label>Status</label><select name="status">${options(statuses, g.status || 'scheduled')}</select></div>
        <div class="field"><label>Away score</label><input name="away_score" type="number" min="0" value="${esc(g.away_score ?? '')}"></div>
        <div class="field"><label>Home score</label><input name="home_score" type="number" min="0" value="${esc(g.home_score ?? '')}"></div>
      </div>
      <div class="field"><label>Notes</label><input name="notes" value="${esc(g.notes || '')}" placeholder="Rivalry week, playoff seeding, etc."></div>
      <button>${g.id ? 'Save game' : 'Add game'}</button>
    </form>`;
}

function manageSport(d) {
  const s = d.sport;
  const teamOpts = (sel) => `<option value="">No team</option>${options(d.teams, sel)}`;
  return `
    <div class="grid two">
      <form class="card" data-form="team">
        <h2>Add an intramural team</h2>
        <div class="field"><label>Team name</label><input name="name" required placeholder="ΧΛΦ A, Sigma Phi Gamma, …"></div>
        <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="is_club" value="1"> This is a Chi Lambda Phi team</label>
        <p></p><button>Add team</button>
      </form>
      <form class="card" data-form="athlete">
        <h2>Add a player</h2>
        <div class="form-grid">
          <div class="field"><label>Name</label><input name="name" required></div>
          <div class="field"><label>Position</label><select name="position"><option value="">—</option>${s.positions.map((p) => `<option>${p}</option>`).join('')}</select></div>
          <div class="field"><label>Team</label><select name="im_team_id">${teamOpts()}</select></div>
        </div>
        <button>Add player</button>
      </form>
    </div>
    <form class="card" data-form="bulk">
      <h2>Paste a list of players</h2>
      <p class="muted small">One per line as <code>Name, Position, Team</code>. Position and team are optional, and new team names are created for you. You can paste straight from a spreadsheet.</p>
      <textarea name="text" placeholder="Jake Miller, QB, ΧΛΦ A&#10;Sam Ortiz, WR, ΧΛΦ A&#10;Luke Chen, RUSH, Sigma Phi Gamma"></textarea>
      <p></p><button>Add players</button>
    </form>
    <div class="card table-wrap">
      <h2>Teams</h2>
      <p class="muted small">Chi teams can earn intramural points or not, and each team has a fantasy multiplier: its players' fantasy points are multiplied by it, so A-team stats can be worth more than B-team stats.</p>
      <table><thead><tr><th>Team</th><th>IM points</th><th>Fantasy ×</th><th></th></tr></thead><tbody>${d.teams.map((t) => `<tr><td>${esc(t.name)} ${teamBadges(t)}</td>
        <td><label style="display:flex;gap:6px;align-items:center;color:var(--text);margin:0"><input type="checkbox" data-team-flag="${t.id}" ${t.for_points ? 'checked' : ''}> Counts</label></td>
        <td><input class="stat" type="number" step="0.05" min="0" max="5" value="${esc(t.multiplier)}" data-team-mult="${t.id}"></td>
        <td class="num"><button class="small secondary" data-act="toggleClub" data-id="${t.id}">${t.is_club ? 'Unmark club' : 'Mark as club'}</button>
        <button class="small secondary" data-act="renameTeam" data-id="${t.id}">Rename</button>
        <button class="small danger" data-act="delTeam" data-id="${t.id}">Delete</button></td></tr>`).join('') || '<tr><td class="empty">No teams yet.</td></tr>'}</tbody></table>
    </div>
    <div class="card table-wrap">
      <h2>Player pool (${d.athletes.filter((a) => a.active).length})</h2>
      <p class="muted small">Edits save as soon as you change a field.</p>
      <table><thead><tr><th>Name</th><th>Position</th><th>Team</th><th></th></tr></thead><tbody>
      ${d.athletes.map((a) => `<tr style="${a.active ? '' : 'opacity:.5'}">
        <td><input name="name" value="${esc(a.name)}" data-edit-athlete="${a.id}"></td>
        <td><select name="position" data-edit-athlete="${a.id}"><option value="">—</option>${s.positions.map((p) => `<option ${p === a.position ? 'selected' : ''}>${p}</option>`).join('')}</select></td>
        <td><select name="im_team_id" data-edit-athlete="${a.id}">${teamOpts(a.im_team_id)}</select></td>
        <td class="num">${a.active ? `<button class="small danger" data-act="delAthlete" data-id="${a.id}">Remove</button>`
          : `<button class="small secondary" data-act="restoreAthlete" data-id="${a.id}">Restore</button>`}</td></tr>`).join('') || '<tr><td class="empty">No players yet.</td></tr>'}
      </tbody></table>
    </div>`;
}

// ---------- Game ----------

async function pageGame(id, mode, extra = []) {
  const d = await GET(`/api/games/${id}`);
  for (const a of d.pool.filter((p) => extra.includes(p.id))) d.players.push({ ...a, im_team_id: -1, stats: null, points: null });
  const { game: g, sport: s } = d;
  const isAdmin = S.me.is_admin;
  const editing = mode === 'edit' && isAdmin;
  const showScore = g.status !== 'scheduled' && g.home_score != null;
  const side = (teamId) => d.players.filter((p) => p.im_team_id === teamId);
  const others = d.players.filter((p) => p.im_team_id !== g.home_team_id && p.im_team_id !== g.away_team_id);

  const boxTable = (title, players, team) => {
    const cols = s.stats.filter(([k]) => editing || players.some((p) => p.stats?.[k]));
    return `<div class="card table-wrap"><h2>${esc(title)} ${teamBadges(team)}</h2>
      ${team?.is_club && Number(team.multiplier) !== 1 && !editing ? `<p class="muted small">Fantasy points from this team are multiplied by ${Number(team.multiplier)}.</p>` : ''}
      ${players.length ? `<table>
      <thead><tr><th>Player</th>${cols.map(([k, label]) => `<th class="num" title="${esc(label)}">${esc(label)}</th>`).join('')}${editing ? '' : '<th class="num">FPTS</th>'}</tr></thead>
      <tbody>${players.map((p) => `<tr>
        <td><a href="#/player/${p.id}">${esc(p.name)}</a> <span class="muted small">${esc(p.position || '')}</span></td>
        ${cols.map(([k]) => editing
          ? `<td class="num"><input class="stat" type="number" step="any" data-a="${p.id}" data-k="${k}" value="${esc(p.stats?.[k] ?? '')}"></td>`
          : `<td class="num">${esc(p.stats?.[k] ?? (p.stats ? 0 : '–'))}</td>`).join('')}
        ${editing ? '' : `<td class="num">${p.points == null ? '<span class="muted">–</span>' : pts(p.points)}</td>`}
      </tr>`).join('')}</tbody></table>` : '<p class="empty">No players on this team yet.</p>'}</div>`;
  };

  render(`
    <div class="page-head">
      <a href="#/sport/${g.sport}">${sportName(g.sport)}</a><span class="muted">/ Week ${esc(g.week)}</span>
      <span class="grow"></span>
      ${isAdmin && !editing ? `<a class="btn" href="#/game/${g.id}/edit">Enter score & stats</a>` : ''}
      ${editing ? `<a class="btn secondary" href="#/game/${g.id}">Done</a>` : ''}
    </div>
    <div class="card">
      <div class="scoreboard">
        <div><div class="team">${esc(g.away_name || 'TBD')}</div><div class="score">${showScore ? esc(g.away_score) : ''}</div><div class="muted small">Away</div></div>
        <div class="vs">${statusBadge(g.status)}<div style="margin-top:6px">${fmtDate(g.starts_at)}</div>${g.location ? `<div class="small">${esc(g.location)}</div>` : ''}</div>
        <div><div class="team">${esc(g.home_name || 'TBD')}</div><div class="score">${showScore ? esc(g.home_score) : ''}</div><div class="muted small">Home</div></div>
      </div>
      ${g.notes ? `<p class="muted" style="text-align:center;margin:12px 0 0">${esc(g.notes)}</p>` : ''}
    </div>
    ${editing ? `<details class="card" open><summary><strong>Game details & score</strong></summary>${gameForm(d.teams, g)}
      <p></p><button class="danger" data-act="delGame">Delete game</button></details>
      ${importCard(g.sport, new Date(g.starts_at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }), true)}
      <div class="card row"><span class="grow">Type each player's numbers below, then save. Blank means zero. Set the game to <strong>live</strong> or <strong>final</strong> above for points to count.</span><button class="gold" data-act="saveStats">Save stats</button></div>` : ''}
    ${boxTable(g.away_name || 'Away', side(g.away_team_id), g.away_team)}
    ${boxTable(g.home_name || 'Home', side(g.home_team_id), g.home_team)}
    ${others.length ? boxTable('Others', others) : ''}
    ${editing && d.pool.length ? `<div class="card row"><span>Someone else played (a sub, or a member from another Chi team)?</span>
      <select id="sub"><option value="">Add a player to the box score…</option>${options(d.pool.filter((p) => !extra.includes(p.id)), '')}</select>
      <button class="secondary" data-act="addSub">Add</button></div>` : ''}
    ${editing ? '<div class="row end"><button class="gold" data-act="saveStats">Save stats</button></div>' : ''}`);

  forms.game = async (f) => {
    await PUT(`/api/games/${g.id}`, { ...f, starts_at: fromLocalInput(f.starts_at) });
    toast('Game saved');
    pageGame(id, 'edit');
  };
  actions.saveStats = async () => {
    const rows = {};
    document.querySelectorAll('input.stat').forEach((i) => {
      (rows[i.dataset.a] ||= {})[i.dataset.k] = i.value;
    });
    await PUT(`/api/games/${g.id}/stats`, { rows: Object.entries(rows).map(([athlete_id, stats]) => ({ athlete_id: Number(athlete_id), stats })) });
    toast('Stats saved');
  };
  actions.addSub = async () => {
    const pick = Number(document.getElementById('sub').value);
    if (!pick) return;
    await actions.saveStats();
    pageGame(id, 'edit', [...extra, pick]);
  };
  wireImport(g.sport, () => pageGame(id, 'edit'));
  actions.delGame = async () => {
    if (!confirm('Delete this game and its stats?')) return;
    await DEL(`/api/games/${g.id}`);
    location.hash = `#/sport/${g.sport}`;
  };
}

// ---------- Stat sheet upload ----------

// Upload a game night from the club's stat sheet (CSV: File > Download > CSV in Google Sheets or Excel).
// Sections ("A-Team", "B-Team", "C-Team") go to that Chi team's game on the sheet's date, or the date picked here.
function importCard(sport, date = '', compact = false) {
  return `<details class="card" ${compact ? '' : 'open'}><summary><strong>📄 Upload a game night from your stat sheet</strong></summary>
    <p class="muted small">Export the sheet as CSV and pick it below. Each team section (A-Team, B-Team, C-Team) goes to that Chi team's game that day.
      Players can be first names or nicknames (Q, Jerry, Santos). You'll see a preview before anything is saved.</p>
    <div class="form-grid">
      <div class="field"><label>Stat sheet (.csv)</label><input type="file" id="imp-file" accept=".csv,text/csv,.txt"></div>
      <div class="field"><label>Game night date (if the sheet has none)</label><input type="date" id="imp-date" value="${esc(date)}"></div>
    </div>
    <div class="field"><label>…or paste the sheet</label><textarea id="imp-text" placeholder="A-Team&#10;Player,Serves Made,Serves Missed,Aces,…&#10;Luke,5,0,1,…"></textarea></div>
    <label class="check" style="border:0"><input type="checkbox" id="imp-scores" checked> Mark the games final, and use the result on the sheet (like "W 2-1") as the score</label>
    <div class="row" style="margin-top:8px"><button class="secondary" data-act="impPreview">Preview</button><span class="grow"></span><span id="imp-status" class="muted small"></span></div>
    <div id="imp-out"></div></details>`;
}

function wireImport(sport, after) {
  const body = async () => {
    const f = document.getElementById('imp-file').files[0];
    const text = f ? await f.text() : document.getElementById('imp-text').value;
    if (!text.trim()) throw new Error('Pick a CSV file or paste the sheet first.');
    return { text, date: document.getElementById('imp-date').value, set_scores: document.getElementById('imp-scores').checked };
  };
  const label = (k) => S.sports[sport].stats.find(([x]) => x === k)?.[1] || k;
  actions.impPreview = async () => {
    const r = await POST(`/api/sports/${sport}/import`, await body());
    const ok = r.sections.filter((x) => x.game);
    document.getElementById('imp-out').innerHTML = `
      ${r.problems.map((p) => `<p class="bad small">⚠ ${esc(p)}</p>`).join('')}
      ${r.sections.map((x) => `<div class="card" style="margin:10px 0">
        <div class="row"><strong>${x.letter ? `Chi ${esc(x.letter)}` : 'Sheet'}</strong>
          <span class="muted small">${x.game ? `${esc(x.game.away_name)} @ ${esc(x.game.home_name)} · ${fmtDate(x.game.starts_at)}` : 'no matching game'}</span>
          <span class="grow"></span>${x.result ? `<span class="badge final">${esc(x.result.outcome)} ${x.result.chi}-${x.result.opp}</span>` : ''}</div>
        <div class="table-wrap"><table><thead><tr><th>Sheet</th><th>Player</th><th>Stats</th></tr></thead><tbody>
          ${x.rows.map((p) => `<tr><td class="muted">${esc(p.sheet_name)}</td><td>${esc(p.name)}</td>
            <td class="small">${Object.entries(p.stats).map(([k, v]) => `${esc(label(k))} ${v}`).join(' · ') || '<span class="muted">no stats (removes his line)</span>'}</td></tr>`).join('')}
          ${x.unmatched.map((u) => `<tr><td class="bad">${esc(u.sheet_name)}</td><td colspan="2" class="bad small">${esc(u.reason)}</td></tr>`).join('')}
        </tbody></table></div></div>`).join('')}
      ${ok.length ? `<div class="row"><span class="grow small muted">${ok.length} game${ok.length === 1 ? '' : 's'}, ${ok.reduce((t, x) => t + x.rows.length, 0)} players ready.</span>
        <button class="gold" data-act="impSave">Save box scores</button></div>` : ''}`;
  };
  actions.impSave = async () => {
    const r = await POST(`/api/sports/${sport}/import`, { ...(await body()), save: true });
    toast(`Saved ${r.saved.lines} stat lines in ${r.saved.games} game${r.saved.games === 1 ? '' : 's'}. Fantasy points are updated.`);
    after();
  };
}

// ---------- Player ----------

// "Tue 8:30 PM vs Kappa A", or a tag when his team has nothing left on the schedule.
function nextGameText(g) {
  if (!g) return 'No game scheduled';
  return `${g.status === 'live' ? 'Live now' : fmtDate(g.starts_at)} vs ${esc(g.opponent)}`;
}

// Last few games as bars, green at or above his average over those games and red below, with the average as a dashed line.
function recentChart(games) {
  if (!games.length) return '';
  const avg = games.reduce((t, g) => t + g.points, 0) / games.length;
  const top = Math.max(avg, ...games.map((g) => g.points), 1) * 1.15;
  const opp = (g) => (g.club_side === 'home' ? g.away_name : g.club_side === 'away' ? g.home_name : `${g.away_name} @ ${g.home_name}`);
  return `<div class="card"><div class="row"><h2 style="margin:0">Last ${games.length} game${games.length === 1 ? '' : 's'}</h2><span class="grow"></span>
      <span class="muted small"><strong style="color:var(--text)">${avg.toFixed(1)}</strong> avg</span></div>
    <div class="bars">${games.map((g) => `<div class="bar ${g.points < avg ? 'lo' : ''}" title="${esc(opp(g))}"><b>${Number(g.points).toFixed(1)}</b><i style="height:${Math.max(2, (g.points / top) * 100)}%"></i></div>`).join('')}
      <div class="avg" style="bottom:${(avg / top) * 100}%"><span>${avg.toFixed(1)}</span></div></div>
    <div class="barlabels">${games.map((g) => `<span>${esc(String(opp(g) || '').slice(0, 14))}<br>${fmtDate(g.starts_at, false).replace(/^\w+,?\s*/, '')}</span>`).join('')}</div></div>`;
}

async function pagePlayer(id) {
  const d = await GET(`/api/athletes/${id}`);
  const { athlete: a, sport: s } = d;
  const cols = s.stats.filter(([k]) => d.log.some((r) => r.stats[k]));
  const total = d.log.filter((r) => r.status !== 'scheduled').reduce((t, r) => t + r.points, 0);
  render(`
    <div class="page-head"><a href="#/sport/${a.sport}">${sportName(a.sport)}</a><span class="muted">/ Players</span></div>
    <div class="card">
      <div class="player-hero">${avatar(a.name, 'lg')}<div class="grow">
        <h1 style="margin:0">${esc(a.name)} ${a.active ? '' : '<span class="badge">inactive</span>'}</h1>
        <p class="muted" style="margin:4px 0 0">${sportName(a.sport)} · ${esc(a.team_name || 'No team')} ${posChip(a.position)}</p></div></div>
      <div class="statgrid">
        <div><span class="muted small">Total pts</span><strong>${pts(d.card.total)}</strong></div>
        <div><span class="muted small">Avg / game</span><strong>${d.card.avg.toFixed(1)}</strong></div>
        <div><span class="muted small">Proj avg</span><strong>${d.card.proj_avg.toFixed(1)}</strong></div>
        <div><span class="muted small">% rostered</span><strong>${d.card.pct_rostered ?? '–'}${d.card.pct_rostered != null ? '%' : ''}</strong></div>
        <div><span class="muted small">% started</span><strong>${d.card.pct_started ?? '–'}${d.card.pct_started != null ? '%' : ''}</strong></div>
        <div><span class="muted small">Next game</span><strong class="small">${nextGameText(d.card.next_game)}</strong></div>
      </div>
      <p class="muted small">Points use the default scoring. Projected average is his average pulled toward his tier's average until he has a few games.</p>
      ${d.owners.length ? `<p>Owned in: ${d.owners.map((o) => `<a href="#/league/${o.league_id}">${esc(o.team_name)}</a> <span class="muted small">(${esc(o.league_name)})</span>`).join(', ')}</p>` : '<p class="muted">Free agent in every league.</p>'}
    </div>
    ${recentChart(d.log.filter((r) => r.status !== 'scheduled').slice(-5))}
    <div class="card table-wrap"><h2>Game log</h2>
      ${d.log.length ? `<table><thead><tr><th>Game</th>${cols.map(([, l]) => `<th class="num">${esc(l)}</th>`).join('')}<th class="num">FPTS</th></tr></thead>
      <tbody>${d.log.map((r) => `<tr><td><a href="#/game/${r.game_id}">Wk ${r.week}: ${esc(r.away_name)} @ ${esc(r.home_name)}</a>
        <div class="muted small">${fmtDate(r.starts_at, false)} ${r.status === 'final' ? `· ${r.away_score}-${r.home_score}` : `· ${r.status}`}</div></td>
        ${cols.map(([k]) => `<td class="num">${esc(r.stats[k] ?? 0)}</td>`).join('')}<td class="num">${pts(r.points)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No stats yet.</p>'}
    </div>`);
}

// ---------- League ----------

async function pageLeague(id, tab, weekParam) {
  const d = await GET(`/api/leagues/${id}`);
  const { league: L, sport: s, myTeam } = d;
  const byId = Object.fromEntries(d.standings.map((t) => [t.id, t]));
  const R = L.regular_weeks;
  const unit = d.roundBy === 'week' ? 'Week' : 'Round';
  // The third part of the URL: a round number on the matchups tab, a filter on the activity tab.
  const tabArg = weekParam;
  const tabs = [['matchups', 'Matchups'], ['standings', 'Standings'], ['power', 'Power rankings'], ['playoffs', 'Playoffs'], ['rosters', 'Rosters'],
    ['players', 'Free agents'], ['trades', 'Trades & waivers'], ['scoring', 'Scoring & settings'], ['activity', 'Activity']];
  if (!d.playoffs) tabs.splice(tabs.findIndex(([k]) => k === 'playoffs'), 1);
  if (L.status !== 'active' && !d.trades?.length) tabs.splice(tabs.findIndex(([k]) => k === 'trades'), 1);
  if (L.status === 'setup' || L.status === 'drafting') tabs.splice(0, tabs.length - 2, ['setup', L.status === 'setup' ? 'Draft setup' : 'Teams']);
  tab = tab && tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  const week = Math.min(d.lastWeek, Math.max(1, Number(weekParam) || d.currentWeek || 1));
  const weekName = (w) => (w <= R ? `${unit} ${w}` : d.playoffs?.rounds.find((r) => r.week === w)?.name || `${unit} ${w}`);
  const gamesInWeek = (w) => (w <= R ? d.matchups.filter((m) => m.week === w) : d.playoffs?.rounds.find((r) => r.week === w)?.games || []);

  const drafting = L.status === 'drafting' ? `
    <div class="clock"><div class="who"><strong>The draft is live!</strong>Head to the draft room to make your picks.</div>
    <a class="btn gold" href="#/league/${L.id}/draft">Enter draft room</a></div>` : '';

  const body = {
    setup: () => `
      <div class="grid two">
        <div class="card">
          <h2>Teams & draft order (${d.standings.length})</h2>
          ${d.standings.length ? `<table><tbody>${[...d.standings].sort((a, b) => a.draft_slot - b.draft_slot).map((t, i, arr) => `
            <tr class="${t.user_id === S.me.id ? 'me' : ''}"><td class="num" style="width:30px">${i + 1}</td>
            <td><strong>${esc(t.name)}</strong> ${BOT_BADGE(t)}<div class="muted small">${esc(t.owner_name)}</div></td>
            <td class="num">${d.isCommish && L.status === 'setup' ? `
              <button class="small secondary" data-act="move" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="small secondary" data-act="move" data-i="${i}" data-dir="1" ${i === arr.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
              ${L.status === 'setup' && (d.isCommish || t.user_id === S.me.id) ? `<button class="small danger" data-act="kick" data-id="${t.id}">${t.user_id === S.me.id ? 'Leave' : 'Remove'}</button>` : ''}
            </td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nobody has joined yet.</p>'}
          ${d.isCommish && L.status === 'setup' ? `<div class="row" style="margin-top:12px">
            <button class="secondary" data-act="randomize">Randomize order</button><span class="grow"></span>
            <button class="gold" data-act="startDraft">Start the draft</button></div>` : ''}
        </div>
        <div class="card">
          ${myTeam ? `<h2>You're in!</h2><p>Your team: <strong>${esc(myTeam.name)}</strong></p>
            <form data-form="rename" class="row"><input name="name" value="${esc(myTeam.name)}" maxlength="40"><button class="secondary">Rename</button></form>`
            : L.status !== 'setup' ? '<h2>Draft in progress</h2><p class="muted">This league is already drafting, so it is closed to new teams.</p>'
            : `<h2>Join this league</h2><form data-form="join"><div class="field"><label>Team name</label>
              <input name="name" maxlength="40" placeholder="${esc(S.me.display_name)}'s ${esc(s.name)} squad"></div><button class="gold">Join league</button></form>`}
          <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
          <h3>How it works</h3>
          <ul class="small">
            <li>Snake draft: ${d.standings.length || 'N'} teams, ${L.roster_size} rounds. Order flips every round.</li>
            <li>${L.pick_seconds ? `${L.pick_seconds} seconds per pick. If the clock runs out, the best available player is picked for you.` : 'No pick clock.'}</li>
            <li>You start ${d.starters} of your ${L.roster_size} players. Only starters score; the bench is backup. A player locks once his Chi game starts that night.</li>
            <li>After the draft you can add and drop free agents. A new player fills an open starting spot, or goes to the bench.</li>
            <li>Head-to-head: you play a different team each ${d.roundBy === 'week' ? 'week' : 'Chi game night'} for ${R} rounds. Win the round by scoring more fantasy points.</li>
            <li>${d.playoffs ? `The top ${d.playoffs.size} teams make the playoffs (${unit.toLowerCase()} ${R + 1}${d.playoffs.size === 4 ? ` and ${R + 2}` : ''}). Ties go to the higher seed.` : 'No playoffs: the best record wins.'}</li>
            <li>🤖 Every matchup gets a win prediction from players' past fantasy points.</li>
            <li>Points only count for games that start while the player is on your roster.</li>
          </ul>
        </div>
      </div>`,

    standings: () => {
      const cut = d.playoffs?.size || 0;
      return `<div class="card table-wrap"><table>
        <thead><tr><th>#</th><th>Team</th><th class="num">W-L-T</th><th class="num">Strk</th><th class="num">PF</th><th class="num">PA</th><th class="num" title="Adds / drops">Moves</th></tr></thead>
        <tbody>${d.standings.map((t) => `<tr class="${t.user_id === S.me.id ? 'me' : ''} ${t.rank === cut && cut < d.standings.length ? 'cutline' : ''}">
          <td>${t.rank}</td><td><strong>${esc(t.name)}</strong> ${BOT_BADGE(t)}${t.seed ? ` <span class="badge seedb">x-${t.seed}</span>` : ''}<div class="muted small">${esc(t.owner_name)}</div></td>
          <td class="num"><strong>${t.w}-${t.l}${t.t ? `-${t.t}` : ''}</strong></td>
          <td class="num ${t.streak?.[0] === 'W' ? 'good' : t.streak?.[0] === 'L' ? 'bad' : ''}">${t.streak || '–'}</td>
          <td class="num">${t.pf.toFixed(1)}</td><td class="num">${t.pa.toFixed(1)}</td>
          <td class="num">${t.adds}/${t.drops}</td></tr>`).join('')}</tbody></table>
        <p class="muted small" style="margin-bottom:0">Ranked like ESPN: record, then head-to-head among tied teams, then points for, then points against. PF and PA count finished head-to-head ${unit.toLowerCase()}s only.
          ${cut ? `x = playoff seed if the season ended today. Teams above the line make the playoffs.` : ''}</p></div>
        ${recordsCard()}
        ${myTeam ? rosterCard(myTeam, true) : ''}`;
    },

    power: () => d.power.length ? `<div class="card table-wrap"><table>
        <thead><tr><th>#</th><th>Team</th><th class="num">Power</th><th class="num" title="Wins plus the wins of the teams you beat">Dominance</th><th class="num">Avg score</th><th class="num">Avg margin</th><th class="num">Record</th></tr></thead>
        <tbody>${d.power.map((p) => { const t = byId[p.team_id]; return `<tr class="${t?.user_id === S.me.id ? 'me' : ''}">
          <td>${p.rank}</td><td><strong>${esc(p.name)}</strong> ${t ? BOT_BADGE(t) : ''}<div class="muted small">${esc(p.owner_name)}</div></td>
          <td class="num"><strong>${p.power.toFixed(2)}</strong></td><td class="num">${p.dominance}</td>
          <td class="num">${p.avg_score.toFixed(1)}</td><td class="num ${p.avg_margin > 0 ? 'good' : p.avg_margin < 0 ? 'bad' : ''}">${p.avg_margin > 0 ? '+' : ''}${p.avg_margin.toFixed(1)}</td>
          <td class="num">${t ? `${t.w}-${t.l}${t.t ? `-${t.t}` : ''}` : ''}</td></tr>`; }).join('')}</tbody></table>
        <p class="muted small" style="margin-bottom:0">ESPN's formula: 80% two-step dominance (your wins, plus the wins of the teams you beat), 15% average score, 5% average margin.</p></div>`
      : '<div class="card empty">Power rankings start after the first finished round.</div>',

    matchups: () => {
      const games = gamesInWeek(week);
      const playing = new Set(games.flatMap((g) => [g.home_team_id, g.away_team_id]));
      const byes = week <= R ? d.standings.filter((t) => !playing.has(t.id)) : [];
      const ws = d.weekStates[week] || {};
      const short = unit === 'Week' ? 'Wk' : 'Rd';
      const ai = d.aiRecord?.total ? `<p class="muted small">🤖 AI picks this season: <strong>${d.aiRecord.right} of ${d.aiRecord.total}</strong> right.</p>` : '';
      return `
        <div class="weekpills">${Array.from({ length: d.lastWeek }, (_, i) => i + 1).map((w) => `
          <a href="#/league/${L.id}/matchups/${w}" class="${w === week ? 'on' : ''} ${w > R ? 'po' : ''}">${w > R ? esc(weekName(w)) : `${short} ${w}`}${w === d.currentWeek ? ' •' : ''}</a>`).join('')}</div>
        <p class="muted small">${esc(weekName(week))} · ${ws.games
          ? unit === 'Round'
            ? `${ws.first_game ? fmtDate(ws.first_game, false) : ''}: ${ws.chi_games.map((g) => `<a href="#/game/${g.id}">${esc(g.label)}</a>`).join(', ')}`
            : `${ws.games} intramural game${ws.games === 1 ? '' : 's'}${ws.first_game ? `, starting ${fmtDate(ws.first_game)}` : ''}`
          : 'No Chi games scheduled for this round yet.'}
          ${ws.state === 'live' ? ' Scores update as stats are entered.' : ''}</p>
        ${ai}
        ${games.length ? `<div class="grid cards">${games.map(matchCard).join('')}</div>` : '<div class="card empty">No matchups this round.</div>'}
        ${byes.length ? `<p class="muted">Bye: ${byes.map((t) => esc(t.name)).join(', ')}</p>` : ''}`;
    },

    playoffs: () => {
      const p = d.playoffs;
      const projected = d.standings.slice(0, p.size);
      return `
        ${p.seeded ? '' : `<div class="card"><h2>Playoff picture</h2>
          <p class="muted">Seeds lock when ${unit.toLowerCase()} ${R} is final. If the season ended today:</p>
          <ol>${projected.map((t) => `<li><strong>${esc(t.name)}</strong> <span class="muted small">${t.w}-${t.l}${t.t ? `-${t.t}` : ''} · ${t.points.toFixed(1)} pts</span></li>`).join('')}</ol></div>`}
        <div class="bracket">${p.rounds.map((r) => `<div><h3>${esc(r.name)} <span class="muted small">· ${unit.toLowerCase()} ${r.week}</span></h3>
          ${r.games.map(matchCard).join('')}</div>`).join('')}
          ${d.champion ? `<div><h3>Champion</h3><div class="card champ">🏆<strong>${esc(d.champion.name)}</strong><div class="muted small">${esc(d.champion.owner_name)}</div></div></div>` : ''}
        </div>`;
    },

    rosters: () => `<div class="grid cards">${d.standings.map((t) => rosterCard(t, t.user_id === S.me.id)).join('')}</div>`,

    players: () => {
      const full = myTeam && myTeam.players.length >= L.roster_size;
      return `<div class="card">
        ${L.status !== 'active' ? '<p class="muted">Free agency is closed.</p>' : myTeam ? `<p class="muted small">${full
          ? 'Your roster is full, so adding a player means choosing someone to drop.'
          : `You have ${L.roster_size - myTeam.players.length} open roster spot(s).`}${L.waiver_hours > 0 ? ` Dropped players sit on waivers for ${L.waiver_hours} hours: put in a claim, and the team with the best waiver priority gets him.` : ''}</p>` : '<p class="muted small">You are not in this league.</p>'}
        <div class="table-wrap"><table><thead><tr><th>Player</th><th>Pos</th><th>Team</th><th>Next game</th><th class="num">GP</th><th class="num">Pts</th><th class="num">Avg</th><th class="num">Proj</th><th></th></tr></thead>
        <tbody>${d.freeAgents.map((a) => `<tr><td><div class="who-cell">${avatar(a.name, 'sm')}<div class="nm"><a href="#/player/${a.id}">${esc(a.name)}</a>${a.waiver_until
          ? ` <span class="badge wv" title="On waivers until ${esc(fmtDate(a.waiver_until))}">W</span><div class="muted small">Waivers clear ${fmtDate(a.waiver_until)}</div>` : ''}</div></div></td><td>${posChip(a.position)}</td>
          <td>${esc(a.team_name || '')}</td><td class="small muted">${nextGameText(a.next_game)}</td><td class="num">${a.games}</td><td class="num">${pts(a.points)}</td>
          <td class="num">${a.avg.toFixed(1)}</td><td class="num"><strong>${a.proj_avg.toFixed(1)}</strong></td>
          <td class="num">${myTeam && L.status === 'active' ? `<button class="small ${a.waiver_until ? 'secondary' : ''}" data-act="add" data-id="${a.id}" data-name="${esc(a.name)}" data-waiver="${a.waiver_until ? 1 : ''}">${a.waiver_until ? 'Claim' : 'Add'}</button>` : ''}</td></tr>`).join('') ||
          '<tr><td colspan="9" class="empty">No free agents.</td></tr>'}</tbody></table></div></div>`;
    },

    trades: () => {
      const T = d.trades || [];
      const me = myTeam?.id;
      const open = T.filter((t) => t.status === 'pending' || t.status === 'review');
      const done = T.filter((t) => !(t.status === 'pending' || t.status === 'review'));
      const W = d.waivers;
      const deadline = L.trade_deadline ? `Trade deadline: <strong>${fmtDate(L.trade_deadline + 'T12:00:00', false)}</strong>${d.pastDeadline ? ' (passed)' : ''}.` : 'No trade deadline.';
      const review = L.trade_review_hours > 0 ? `Accepted trades wait ${L.trade_review_hours} hours for the commissioner to review before they go through.` : 'Accepted trades go through right away.';
      return `<div class="grid two">
        <div class="card"><h2>Trades</h2>
          <p class="muted small">${deadline} ${review} ${myTeam && L.status === 'active' && !d.pastDeadline ? 'To offer a trade, open <a href="#/league/' + L.id + '/rosters">Rosters</a> and pick a team.' : ''}</p>
          ${open.map((t) => tradeCard(t, me)).join('') || '<p class="empty">No open trades.</p>'}
          ${done.length ? `<h3>Recent</h3>${done.map((t) => tradeCard(t, me)).join('')}` : ''}
        </div>
        ${W ? `<div class="card"><h2>Waivers</h2>
          <p class="muted small">${W.hours > 0 ? `Dropped players sit on waivers for ${W.hours} hours. When their time is up, the claim from the team highest on this list wins. The order is reverse standings: the last-place team picks first.` : 'Waivers are off: dropped players are free agents right away.'}</p>
          <h3>Waiver order</h3><ol class="small">${W.order.map((o) => `<li class="${o.team_id === me ? 'me' : ''}"><strong>${esc(o.name)}</strong> <span class="muted">${esc(o.owner_name || '')}</span></li>`).join('')}</ol>
          <h3>On waivers now</h3>${W.players.length ? `<table><tbody>${W.players.map((p) => `<tr><td><a href="#/player/${p.athlete_id}">${esc(p.name)}</a></td>
            <td class="muted small">clears ${fmtDate(p.clears_at)}</td>
            <td class="num">${myTeam ? `<button class="small secondary" data-act="add" data-id="${p.athlete_id}" data-name="${esc(p.name)}" data-waiver="1">Claim</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nobody is on waivers.</p>'}
          ${myTeam ? `<h3>Your claims</h3>${W.claims.length ? `<table><tbody>${W.claims.map((c) => `<tr><td><strong>${esc(c.name)}</strong>${c.drop_name ? ` <span class="muted small">· drop ${esc(c.drop_name)}</span>` : ''}
              ${c.reason ? `<div class="muted small">${esc(c.reason)}</div>` : ''}</td>
            <td class="small ${c.status === 'won' ? 'good' : c.status === 'lost' ? 'bad' : 'muted'}">${c.status === 'pending' && c.clears_at ? `pending · ${fmtDate(c.clears_at)}` : esc(c.status)}</td>
            <td class="num">${c.status === 'pending' ? `<button class="small danger" data-act="cancelClaim" data-id="${c.id}">Cancel</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No claims.</p>'}` : ''}
        </div>` : ''}
      </div>`;
    },

    scoring: () => `<form class="card" data-form="scoring">
      <h2>${esc(s.name)} scoring</h2>
      <p class="muted small">Fantasy points per stat. A player's score is each stat times its points, added up.${d.isCommish ? ' As commissioner you can change these at any time, and every score recalculates.' : ''}</p>
      <div class="form-grid">${s.stats.map(([k, label]) => `<div class="field"><label>${esc(label)}</label>
        <input name="${k}" type="number" step="any" value="${esc(L.scoring[k] ?? 0)}" ${d.isCommish ? '' : 'disabled'}></div>`).join('')}</div>
      ${d.isCommish ? '<button>Save scoring</button>' : ''}
    </form>
    ${d.isCommish ? `<form class="card" data-form="settings"><h2>League settings</h2>
      <div class="form-grid">
        <div class="field"><label>Name</label><input name="name" value="${esc(L.name)}"></div>
        <div class="field"><label>Season</label><input name="season" value="${esc(L.season || '')}"></div>
        <div class="field"><label>Seconds per pick</label><input name="pick_seconds" type="number" min="0" value="${L.pick_seconds}"></div>
        ${L.status === 'setup' ? `<div class="field"><label>Players per team</label><input name="roster_size" type="number" min="1" max="20" value="${L.roster_size}"></div>` : ''}
        <div class="field"><label>Starters (the rest sit on the bench)</label><input name="starters" type="number" min="1" max="${L.roster_size}" value="${d.starters}"></div>
        <div class="field"><label>Rounds</label><select name="round_by">${options([{ id: 'game', name: 'One per Chi game night' }, { id: 'week', name: 'One per intramural week' }], L.round_by)}</select></div>
        <div class="field"><label>Regular season rounds</label><input name="regular_weeks" type="number" min="1" max="30" value="${R}"></div>
        <div class="field"><label>Playoff teams</label><select name="playoff_teams">${options([{ id: 0, name: 'No playoffs' }, { id: 2, name: 'Top 2 (final)' }, { id: 4, name: 'Top 4 (semis + final)' }], L.playoff_teams)}</select></div>
      </div>
      ${['active', 'complete'].includes(L.status) ? '<p class="muted small">Changing the rounds or their number redraws the head-to-head schedule. Switching between game nights and weeks also resets the number of rounds to fill the season.</p>' : ''}
      <div class="row"><button>Save settings</button><span class="grow"></span>
        ${L.status === 'active' ? '<button type="button" class="secondary" data-act="finish">End season</button>' : ''}
        ${L.status === 'complete' ? '<button type="button" class="secondary" data-act="reopen">Reopen season</button>' : ''}
        ${S.me.is_admin ? '<button type="button" class="danger" data-act="delLeague">Delete league</button>' : ''}</div>
    </form>` : ''}`,

    activity: () => {
      const kinds = [['all', 'All'], ['move', 'Adds & drops'], ['trade', 'Trades'], ['draft', 'Draft'], ['commish', 'Commissioner'], ['league', 'League']];
      const k = kinds.some(([x]) => x === tabArg) ? tabArg : 'all';
      const rows = d.activity.filter((a) => k === 'all' || a.kind === k);
      return `<div class="weekpills">${kinds.map(([x, label]) => `<a href="#/league/${L.id}/activity/${x}" class="${x === k ? 'on' : ''}">${label}</a>`).join('')}</div>
        <div class="card"><ul class="feed">${rows.map((a) => `<li>${esc(a.text)} <span class="muted small">· ${fmtDate(a.created_at)}</span></li>`).join('') || '<li class="empty">Nothing yet.</li>'}</ul></div>`;
    },
  };

  render(`
    <div class="page-head">
      <span class="big-icon">${s.icon}</span>
      <div class="grow"><h1>${esc(L.name)}</h1><div class="muted">${esc(s.name)}${L.season ? ` · ${esc(L.season)}` : ''} · ${L.roster_size} players per team</div></div>
      ${statusBadge(L.status === 'complete' ? 'final' : L.status)}
    </div>
    ${drafting}
    ${d.isCommish && !myTeam && S.me.is_admin ? `<div class="card commish-note small"><strong>Commissioner view.</strong> You're not playing in this league, but you can see every team, roster and matchup, set any team's lineup, edit rosters from Admin, and approve or veto trades.</div>` : ''}
    ${d.champion ? `<div class="card champ-banner"><span style="font-size:2rem">🏆</span><h2>${esc(d.champion.name)} ${L.status === 'complete' ? 'won' : 'wins'} the ${esc(s.name.toLowerCase())} title!</h2>
      <p class="muted">${esc(d.champion.owner_name)} · ${d.champion.points.toFixed(1)} season points</p>
      ${d.isCommish && L.status === 'active' ? '<button class="secondary" data-act="finish">End the season</button>' : ''}</div>` : ''}
    <div class="tabs">${tabs.map(([k, label]) => `<a href="#/league/${L.id}/${k}" class="${k === tab ? 'on' : ''}">${label}</a>`).join('')}
      ${['drafting', 'active', 'complete'].includes(L.status) ? `<a href="#/league/${L.id}/draft">Draft board</a>` : ''}</div>
    ${body[tab]()}`);

  const reload = () => pageLeague(id, tab, weekParam);
  forms.join = async (f) => { await POST(`/api/leagues/${L.id}/join`, f); toast('Welcome to the league!'); reload(); };
  forms.rename = async (f) => { await PUT(`/api/leagues/${L.id}/teams/${myTeam.id}`, f); toast('Renamed'); reload(); };
  forms.scoring = async (f) => { await PUT(`/api/leagues/${L.id}`, { scoring: f }); toast('Scoring saved'); reload(); };
  forms.settings = async (f) => { await PUT(`/api/leagues/${L.id}`, f); toast('Settings saved'); reload(); };
  actions.kick = async (el) => {
    if (!confirm('Remove this team from the league?')) return;
    await DEL(`/api/leagues/${L.id}/teams/${el.dataset.id}`);
    reload();
  };
  actions.move = async (el) => {
    const order = [...d.standings].sort((a, b) => a.draft_slot - b.draft_slot).map((t) => t.id);
    const i = Number(el.dataset.i), j = i + Number(el.dataset.dir);
    [order[i], order[j]] = [order[j], order[i]];
    await POST(`/api/leagues/${L.id}/order`, { team_ids: order });
    reload();
  };
  actions.randomize = async () => { await POST(`/api/leagues/${L.id}/order`, { randomize: true }); toast('Order shuffled'); reload(); };
  actions.startDraft = async () => {
    if (!confirm('Start the draft now? The clock starts for the first pick right away.')) return;
    await POST(`/api/leagues/${L.id}/draft/start`);
    location.hash = `#/league/${L.id}/draft`;
  };
  actions.drop = async (el) => {
    if (!confirm(`Drop ${el.dataset.name}? They become a free agent.`)) return;
    if (el.dataset.team) await POST(`/api/leagues/${L.id}/admin/roster`, { team_id: Number(el.dataset.team), drop_id: el.dataset.id });
    else await POST(`/api/leagues/${L.id}/transactions`, { drop_id: el.dataset.id });
    toast(`Dropped ${el.dataset.name}`);
    reload();
  };
  async function addPlayer(addId, name, dropId) {
    await POST(`/api/leagues/${L.id}/transactions`, { add_id: addId, drop_id: dropId });
    closeDialog();
    toast(`Added ${name}`);
    reload();
  }
  actions.add = async (el) => {
    if (myTeam.players.length < L.roster_size) return addPlayer(el.dataset.id, el.dataset.name, null);
    openDialog(`<h2>Add ${esc(el.dataset.name)}</h2><p class="muted">Your roster is full. Pick who to drop.</p>
      <div class="stack">${myTeam.players.map((p) => `<button class="secondary droppick" data-act="confirmAdd" data-add="${esc(el.dataset.id)}" data-name="${esc(el.dataset.name)}" data-drop="${p.athlete_id}">
        Drop <strong>${esc(p.name)}</strong> <span class="muted small">${esc(p.position || '')} · ${Number(p.points).toFixed(1)} pts</span></button>`).join('')}</div>`);
  };
  actions.confirmAdd = (el) => addPlayer(el.dataset.add, el.dataset.name, el.dataset.drop);
  actions.cancelClaim = async (el) => { await DEL(`/api/leagues/${L.id}/claims/${el.dataset.id}`); toast('Claim cancelled'); reload(); };
  const tradeAct = (action, msg) => async (el) => {
    if (action === 'veto' && !confirm('Veto this trade? Neither team gets the players.')) return;
    const r = await POST(`/api/leagues/${L.id}/trades/${el.dataset.id}/${action}`);
    if (r.status === 'done') return tradeDone('Your player swap is done!', 'Now set your lineup and get ready for game night.');
    if (r.status === 'review') return tradeDone('Trade accepted!', 'It goes through after the league review period unless the commissioner vetoes it.');
    toast(msg);
    reload();
  };
  // A celebration card for trades, then back to the trades tab.
  function tradeDone(title, line) {
    openDialog(`<div class="success"><div class="burst">⇄</div><h2>${esc(title)}</h2><p class="muted">${esc(line)}</p>
      <button data-act="tradeOk">Done</button></div>`);
    actions.tradeOk = () => { closeDialog(); location.hash = `#/league/${L.id}/trades`; reload(); };
  }
  actions.acceptTrade = tradeAct('accept', 'Trade done!');
  actions.rejectTrade = tradeAct('reject', 'Offer rejected');
  actions.cancelTrade = tradeAct('cancel', 'Offer cancelled');
  actions.approveTrade = tradeAct('approve', 'Trade approved');
  actions.vetoTrade = tradeAct('veto', 'Trade vetoed');
  actions.tradeWith = (el) => {
    const them = byId[el.dataset.id];
    const pick = (team, name) => team.players.map((p) => `<label class="check"><input type="checkbox" name="${name}" value="${p.athlete_id}">
      ${avatar(p.name, 'sm')}<span class="grow">${esc(p.name)} ${posChip(p.position)}</span>${pts(p.points)}</label>`).join('') || '<p class="empty">No players.</p>';
    openDialog(`<h2>Trade with ${esc(them.name)}</h2>
      <form data-form="trade"><input type="hidden" name="to" value="${them.id}">
        <div class="grid two"><div><h3>You give</h3>${pick(myTeam, 'give')}</div><div><h3>You get</h3>${pick(them, 'get')}</div></div>
        <div class="field"><label>Note (optional)</label><input name="note" maxlength="200" placeholder="Why it's a good deal for them"></div>
        <p class="muted small">Rosters can't go over ${L.roster_size} players, so an uneven trade needs an open spot.</p>
        <button class="gold">Send offer</button></form>`);
    forms.trade = async (f, form) => {
      const ids = (n) => [...form.querySelectorAll(`input[name=${n}]:checked`)].map((x) => Number(x.value));
      const r = await POST(`/api/leagues/${L.id}/trades`, { to_team_id: Number(f.to), give: ids('give'), get: ids('get'), note: f.note });
      const [title, line] = {
        pending: ['Offer sent!', `${them.name} can accept or reject it on the Trades & waivers tab.`],
        rejected: ['Offer turned down', `${them.name} said no this time. Try sweetening the deal.`],
        review: ['Trade accepted!', 'It goes through after the league review period unless the commissioner vetoes it.'],
        done: ['Your player swap is done!', 'Now set your lineup and get ready for game night.'],
      }[r.status] || ['Offer sent!', ''];
      tradeDone(title, line);
    };
  };
  const lineup = async (body) => {
    await POST(`/api/leagues/${L.id}/lineup`, body);
    closeDialog();
    reload();
  };
  const teamArg = (el) => (el.dataset.team ? { team_id: Number(el.dataset.team) } : {});
  actions.bench = (el) => lineup({ athlete_id: el.dataset.id, starter: false, ...teamArg(el) });
  actions.start = (el) => {
    const team = el.dataset.team ? byId[el.dataset.team] : myTeam;
    const starters = team.players.filter((p) => p.starter);
    if (starters.length < d.starters) return lineup({ athlete_id: el.dataset.id, starter: true, ...teamArg(el) });
    const free = starters.filter((p) => !p.locked);
    openDialog(`<h2>Start ${esc(el.dataset.name)}</h2><p class="muted">Your lineup is full. Pick a starter to move to the bench.</p>
      <div class="stack">${free.map((p) => `<button class="secondary droppick" data-act="swap" data-id="${esc(el.dataset.id)}" data-swap="${p.athlete_id}"${el.dataset.team ? ` data-team="${esc(el.dataset.team)}"` : ''}>
        Bench <strong>${esc(p.name)}</strong> <span class="muted small">${esc(p.position || '')} · ${nextGameText(p.next_game)}</span></button>`).join('') || '<p class="empty">Every starter is locked tonight.</p>'}</div>`);
  };
  actions.swap = (el) => lineup({ athlete_id: el.dataset.id, starter: true, swap_id: el.dataset.swap, ...teamArg(el) });
  // ESPN-style box score: each side's starters, then bench, with projected and actual points.
  actions.detail = (el) => {
    const w = Number(el.dataset.week);
    const all = [...d.matchups, ...(d.playoffs?.rounds.flatMap((r) => r.games) || [])];
    const m = all.find((g) => g.week === w && g.home_team_id === Number(el.dataset.h) && g.away_team_id === Number(el.dataset.a));
    const p = m?.prediction;
    const col = (t, lineupRows, projShown) => {
      const got = t.byWeek[w] || {};
      const proj = Object.fromEntries((lineupRows || []).map((x) => [x.athlete_id, x]));
      const rows = Object.values(got).map((r) => ({ ...r, starter: !r.bench, proj: proj[r.athlete_id]?.proj }));
      const seen = new Set(rows.map((r) => `${r.athlete_id}:${r.starter}`));
      for (const x of lineupRows || t.players.map((q) => ({ ...q, proj: null }))) {
        if (!seen.has(`${x.athlete_id}:${!!x.starter}`)) rows.push({ ...x, points: 0, proj: x.proj });
      }
      rows.sort((a, b) => b.starter - a.starter || b.points - a.points || (b.proj || 0) - (a.proj || 0));
      const total = rows.filter((r) => r.starter).reduce((sum, r) => sum + r.points, 0);
      const tr = (r) => `<tr class="${r.starter ? '' : 'bench'}"><td class="slot"><span>${r.starter ? 'S' : 'BN'}</span></td>
        <td><a href="#/player/${r.athlete_id}">${esc(r.name)}</a> <span class="muted small">${esc(r.position || '')}${r.dropped ? ' · dropped' : ''}</span></td>
        <td class="num muted">${r.proj != null ? Number(r.proj).toFixed(1) : ''}</td><td class="num">${pts(r.points)}</td></tr>`;
      return `<div><h3>${esc(t.name)}</h3><table><thead><tr><th>Slot</th><th>Player</th><th class="num">Proj</th><th class="num">Pts</th></tr></thead><tbody>
        ${rows.map(tr).join('') || '<tr><td colspan="4" class="empty">No players.</td></tr>'}
        <tr><td></td><td><strong>Total</strong> <span class="muted small">(starters)</span></td><td class="num muted">${projShown != null ? projShown.toFixed(1) : ''}</td><td class="num"><strong>${pts(total)}</strong></td></tr></tbody></table></div>`;
    };
    const keys = (t, list) => list?.length ? `<p class="small"><strong>${esc(t.name)}</strong>: ${list.map((k) => `${esc(k.name)} (${k.proj.toFixed(1)})`).join(', ')}</p>` : '';
    const why = p?.basis === 'stats' ? `<div class="card" style="margin-top:12px"><h3>🤖 Why the AI picked it</h3>
      <p class="muted small">Projected ${p.away_proj.toFixed(1)} (${esc(byId[el.dataset.a].name)}) vs ${p.home_proj.toFixed(1)} (${esc(byId[el.dataset.h].name)}), starters only. Each player's average fantasy points per game, pulled toward the club average for their tier until they have a few games, times the Chi games their team plays in the round${p.pregame ? '. Uses only games played before the round.' : ', plus the points already scored.'}</p>
      ${keys(byId[el.dataset.a], p.away_key)}${keys(byId[el.dataset.h], p.home_key)}</div>` : '';
    openDialog(`<h2>${esc(weekName(w))} box score</h2><div class="grid two">${col(byId[el.dataset.a], p?.away_lineup, p?.away_proj)}${col(byId[el.dataset.h], p?.home_lineup, p?.home_proj)}</div>${why}`);
  };
  actions.finish = async () => {
    if (!confirm('End the season and crown the champion?')) return;
    await PUT(`/api/leagues/${L.id}`, { status: 'complete' });
    reload();
  };
  actions.reopen = async () => { await PUT(`/api/leagues/${L.id}`, { status: 'active' }); reload(); };
  actions.delLeague = async () => {
    if (!confirm('Delete this league for everyone? This cannot be undone.')) return;
    await DEL(`/api/leagues/${L.id}`);
    location.hash = `#/sport/${L.sport}/leagues`;
  };

  function tradeCard(t, me) {
    const list = (items) => items.map((i) => `<div class="who-cell" style="margin:4px 0">${avatar(i.name, 'sm')}<span><a href="#/player/${i.athlete_id}">${esc(i.name)}</a> <span class="muted small">${i.points.toFixed(1)}</span></span></div>`).join('') || '<span class="muted">nothing</span>';
    const label = { pending: 'Offer', review: 'Under review', done: 'Done', rejected: 'Rejected', cancelled: 'Cancelled', vetoed: 'Vetoed', failed: 'Fell through' }[t.status] || t.status;
    const btns = [];
    if (t.status === 'pending' && t.receiver_team_id === me) btns.push(['acceptTrade', 'Accept', ''], ['rejectTrade', 'Reject', 'danger']);
    if (t.status === 'pending' && (t.proposer_team_id === me || d.isCommish)) btns.push(['cancelTrade', 'Cancel offer', 'secondary']);
    if (t.status === 'review' && d.isCommish) btns.push(['approveTrade', 'Approve now', ''], ['vetoTrade', 'Veto', 'danger']);
    return `<div class="trade ${t.status}">
      <div class="row small"><span class="badge">${label}</span><span class="grow"></span><span class="muted">${fmtDate(t.decided_at || t.accepted_at || t.created_at)}</span></div>
      <div class="tradecols"><div><div class="muted small">${esc(t.proposer)} gives</div>${list(t.gives)}</div>
        <div class="arrow">⇄</div><div><div class="muted small">${esc(t.receiver)} gives</div>${list(t.gets)}</div></div>
      ${t.note ? `<p class="small">“${esc(t.note)}”</p>` : ''}
      ${t.status === 'review' && t.process_at ? `<p class="muted small">Goes through ${fmtDate(t.process_at)} unless the commissioner vetoes it.</p>` : ''}
      ${t.reason && t.status !== 'done' ? `<p class="muted small">${esc(t.reason)}</p>` : ''}
      ${btns.length ? `<div class="row">${btns.map(([a, l, c]) => `<button class="small ${c}" data-act="${a}" data-id="${t.id}">${l}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  function recordsCard() {
    const r = d.records;
    if (!r) return '';
    const row = (label, name, value) => `<tr><td class="muted">${label}</td><td><strong>${esc(name)}</strong></td><td class="num">${value}</td></tr>`;
    return `<div class="card"><h2>League records</h2><table><tbody>
      ${row('Top scorer (PF)', r.top_scorer.name, Number(r.top_scorer.value).toFixed(1))}
      ${row('Lowest scorer (PF)', r.least_scorer.name, Number(r.least_scorer.value).toFixed(1))}
      ${row('Most points against', r.most_against.name, Number(r.most_against.value).toFixed(1))}
      ${row(`Best ${unit.toLowerCase()}`, `${r.best_round.name} · ${weekName(r.best_round.week)}`, Number(r.best_round.points).toFixed(1))}
      ${row(`Worst ${unit.toLowerCase()}`, `${r.worst_round.name} · ${weekName(r.worst_round.week)}`, Number(r.worst_round.points).toFixed(1))}
    </tbody></table></div>`;
  }

  function matchCard(m) {
    const h = byId[m.home_team_id], a = byId[m.away_team_id];
    const mine = myTeam && (m.home_team_id === myTeam.id || m.away_team_id === myTeam.id);
    const showPts = m.state !== 'upcoming';
    const side = (t, p, seed) => `<div class="mside ${m.winner && t && m.winner === t.id ? 'win' : ''}">
      <span>${seed ? `<span class="seed">${seed}</span>` : ''}${t ? avatar(t.name) : ''}<span class="nm">${t ? `<strong>${esc(t.name)}</strong>` : '<span class="muted">TBD</span>'}
        ${t ? `<div class="muted small">${esc(t.owner_name)} · ${t.w}-${t.l}${t.t ? `-${t.t}` : ''}</div>` : ''}</span></span>
      <span class="mscore">${showPts && t ? Number(p).toFixed(1) : ''}</span></div>`;
    return `<div class="card match ${mine ? 'mine' : ''}">
      <div class="row small muted"><span>${m.label ? `${esc(m.label)} · ` : ''}${unit} ${m.week}</span><span class="grow"></span>${statusBadge(m.state)}</div>
      ${m.kind === 'playoff'
        ? side(h, m.home_points, m.home_seed) + side(a, m.away_points, m.away_seed)
        : side(a, m.away_points, m.away_seed) + side(h, m.home_points, m.home_seed)}
      ${h && a ? predictionBar(m, h, a) : ''}
      ${h && a ? `<a href="#" class="small" data-act="detail" data-week="${m.week}" data-h="${h.id}" data-a="${a.id}">${showPts ? 'See player points' : 'See rosters'}</a>` : ''}
    </div>`;
  }

  // The AI pick: who is likely to win, by how much, and (once the round is over) whether it was right.
  function predictionBar(m, h, a) {
    const p = m.prediction;
    if (!p) return '';
    if (p.basis === 'none') return '<div class="pred muted small">🤖 No stats yet, so no prediction.</div>';
    const pct = Math.round(p.home_win * 100);
    const fav = pct >= 50 ? h : a;
    const favPct = Math.max(pct, 100 - pct);
    // Bar order matches the card: away on top/left for the regular season, home first in the playoffs.
    const [first, second, firstPct] = m.kind === 'playoff' ? [h, a, pct] : [a, h, 100 - pct];
    const verdict = m.state === 'final' && p.correct !== undefined ? (p.correct ? ' · <span class="good">called it ✓</span>' : ' · <span class="bad">missed ✗</span>') : '';
    return `<div class="pred">
      <div class="small"><span>🤖 ${m.state === 'final' ? 'Picked' : 'Picks'} <strong>${esc(fav.name)}</strong> · ${favPct}%</span>${verdict}</div>
      <div class="predbar" title="${esc(first.name)} ${firstPct}% · ${esc(second.name)} ${100 - firstPct}%"><span style="width:${firstPct}%"></span></div>
      <div class="muted small">Projected ${(m.kind === 'playoff' ? p.home_proj : p.away_proj).toFixed(1)} – ${(m.kind === 'playoff' ? p.away_proj : p.home_proj).toFixed(1)}${p.pregame ? '' : ' (live)'}</div>
    </div>`;
  }

  function rosterCard(t, mine) {
    // The commissioner can set any team's lineup; owners set their own.
    const canEdit = (mine || d.isCommish) && L.status === 'active';
    const tid = mine ? '' : ` data-team="${t.id}"`;
    const settled = L.status !== 'setup' && L.status !== 'drafting';
    const row = (p) => `<tr class="${p.starter || !settled ? '' : 'bench'}">
      <td class="slot">${settled ? `<span>${p.starter ? 'S' : 'BN'}</span>` : ''}</td>
      <td><div class="who-cell">${avatar(p.name, 'sm')}<div class="nm"><a href="#/player/${p.athlete_id}">${esc(p.name)}</a> ${posChip(p.position)}${p.locked ? ' <span title="His game has started tonight">🔒</span>' : ''}
        <div class="muted small">${esc(p.team_name || '')}${settled && L.status === 'active' ? ` · ${nextGameText(p.next_game)}` : ''}</div></div></div></td>
      <td class="num">${pts(p.points)}</td>
      ${canEdit ? `<td class="num nowrap">${p.locked ? '' : p.starter
        ? `<button class="small secondary" data-act="bench" data-id="${p.athlete_id}"${tid}>Bench</button>`
        : `<button class="small" data-act="start" data-id="${p.athlete_id}" data-name="${esc(p.name)}"${tid}>Start</button>`}
        <button class="small danger" data-act="drop" data-id="${p.athlete_id}" data-name="${esc(p.name)}"${tid}>Drop</button></td>` : ''}</tr>`;
    const starters = settled ? t.players.filter((p) => p.starter) : t.players;
    const bench = settled ? t.players.filter((p) => !p.starter) : [];
    const open = settled ? Math.max(0, d.starters - starters.length) : 0;
    return `<div class="card">
      <div class="row">${avatar(t.name)}<h3 style="margin:0">${esc(t.name)}</h3><span class="grow"></span>${pts(t.points)}</div>
      ${myTeam && !mine && L.status === 'active' && !d.pastDeadline ? `<button class="small secondary" data-act="tradeWith" data-id="${t.id}" style="margin:4px 0">Propose trade</button>` : ''}
      <div class="muted small" style="margin-bottom:8px">${esc(t.owner_name)} · ${settled ? `${t.w}-${t.l}${t.t ? `-${t.t}` : ''} · Rank ${t.rank}${t.streak ? ` · ${t.streak}` : ''}` : ''}</div>
      <table><tbody>${starters.map(row).join('')}
        ${Array.from({ length: open }, () => `<tr><td class="slot"><span>S</span></td><td class="muted">Empty starting spot</td><td></td>${canEdit ? '<td></td>' : ''}</tr>`).join('')}
        ${bench.length ? `<tr class="benchhead"><td colspan="${canEdit ? 4 : 3}" class="muted small">Bench</td></tr>` : ''}
        ${bench.map(row).join('')}
        ${t.players.length ? '' : '<tr><td class="empty">No players yet.</td></tr>'}</tbody></table>
      ${settled ? '<p class="muted small" style="margin:6px 0 0">Player points include bench nights; the team total counts starters only.</p>' : ''}</div>`;
  }

}

// ---------- Draft room ----------

async function pageDraft(id) {
  let d = null;
  let clockOffset = 0;
  let filter = { q: '', pos: '' };
  let lastPickCount = -1;

  render(`
    <div class="page-head"><a href="#/league/${id}">← Back to league</a><span class="grow"></span><span id="draft-controls"></span></div>
    <div id="clock"></div>
    <div class="layout-draft">
      <div>
        <div class="card"><h2 id="board-title">Draft board</h2><div id="board" class="board"></div></div>
      </div>
      <div>
        <div class="card" id="pool-card">
          <h2>Available players</h2>
          <div class="row" style="margin-bottom:10px">
            <input id="q" placeholder="Search name or team" style="flex:1">
            <select id="pos"><option value="">All</option></select>
          </div>
          <div id="pool" class="list-scroll"></div>
        </div>
        <div class="card"><h2>My team</h2><div id="mine"></div></div>
      </div>
    </div>`);

  const q = document.getElementById('q');
  const pos = document.getElementById('pos');
  q.addEventListener('input', () => { filter.q = q.value.toLowerCase(); drawPool(); });
  pos.addEventListener('change', () => { filter.pos = pos.value; drawPool(); });

  async function load() {
    try {
      d = await GET(`/api/leagues/${id}/draft`);
    } catch (err) {
      return toast(err.message, true);
    }
    clockOffset = d.serverNow - Date.now();
    if (pos.options.length === 1) pos.innerHTML += d.sport.positions.map((p) => `<option>${p}</option>`).join('');
    drawControls();
    drawClock();
    if (d.picks.length !== lastPickCount || !document.getElementById('board').innerHTML) {
      lastPickCount = d.picks.length;
      drawBoard();
      drawPool();
      drawMine();
    } else {
      drawPool();
    }
  }

  const canPick = () => d && d.league.status === 'drafting' && !d.league.draft_paused && d.state.onClock &&
    (d.state.onClock.id === d.myTeamId || d.isCommish);

  function drawControls() {
    const el = document.getElementById('draft-controls');
    el.innerHTML = d.isCommish && d.league.status === 'drafting'
      ? `<button class="secondary" data-act="pause">${d.league.draft_paused ? '▶ Resume draft' : '⏸ Pause draft'}</button>` : '';
  }

  function drawClock() {
    const el = document.getElementById('clock');
    if (d.league.status === 'setup') {
      el.innerHTML = `<div class="clock"><div class="who"><strong>The draft has not started yet.</strong>The commissioner starts it from the league page.</div></div>`;
      return;
    }
    if (d.league.status !== 'drafting') {
      el.innerHTML = `<div class="clock"><div class="who"><strong>The draft is complete ✅</strong>${d.picks.length} picks made. Good luck this season!</div>
        <a class="btn gold" href="#/league/${id}">See standings</a></div>`;
      return;
    }
    const on = d.state.onClock;
    const mine = on.id === d.myTeamId;
    document.title = mine && !d.league.draft_paused ? '⏰ Your pick! · ΧΛΦ Fantasy' : 'Draft room · ΧΛΦ Fantasy';
    const pickInRound = ((d.state.picksMade) % d.state.teams) + 1;
    el.innerHTML = `<div class="clock ${mine ? 'mine' : ''}">
      <div class="timer" id="timer">${d.league.pick_seconds ? '' : '∞'}</div>
      <div class="who"><span class="small">Round ${d.state.round}, pick ${pickInRound} · #${d.state.picksMade + 1} overall</span>
        <strong>${mine ? "You're on the clock!" : `${esc(on.name)} is on the clock`}</strong>
        ${d.league.draft_paused ? '<span class="badge">paused</span>' : ''}
        ${!mine && d.isCommish ? '<span class="small">As commissioner you can pick for them.</span>' : ''}</div>
    </div>`;
    tick();
  }

  function tick() {
    const t = document.getElementById('timer');
    if (!t || !d || d.league.status !== 'drafting' || !d.league.pick_seconds) return;
    const ms = d.league.draft_paused ? d.state.remainingMs : d.state.deadline - (Date.now() + clockOffset);
    const secs = Math.max(0, Math.ceil(ms / 1000));
    t.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    t.classList.toggle('low', secs <= 10);
    if (secs === 0 && !d.league.draft_paused && !tick.waiting) {
      // The server auto-picks when the clock hits zero; fetch the result.
      tick.waiting = true;
      setTimeout(() => { tick.waiting = false; load(); }, 700);
    }
  }

  function drawBoard() {
    const n = d.order.length;
    const rounds = d.league.roster_size;
    const byPick = Object.fromEntries(d.picks.map((p) => [p.pick_no, p]));
    const current = d.league.status === 'drafting' ? d.state.picksMade + 1 : null;
    let html = `<div class="board" style="grid-template-columns:repeat(${n}, minmax(110px, 1fr))">`;
    html += d.order.map((t) => `<div class="cell head ${t.id === d.myTeamId ? 'mine' : ''}">${esc(t.name)}<div class="small" style="opacity:.75;font-weight:400">${esc(t.owner_name || '')}</div></div>`).join('');
    for (let r = 1; r <= rounds; r++) {
      for (let c = 0; c < n; c++) {
        const idx = r % 2 === 1 ? c : n - 1 - c;
        const pickNo = (r - 1) * n + idx + 1;
        const p = byPick[pickNo];
        html += `<div class="cell ${pickNo === current ? 'now' : ''} ${p?.auto ? 'auto' : ''}">
          <div class="n">${r}.${idx + 1}</div>
          ${p ? `<div class="p">${esc(p.athlete_name)}</div><div class="n">${esc(p.position || '')} ${p.im_team ? `· ${esc(p.im_team)}` : ''}</div>` : ''}
        </div>`;
      }
    }
    html += '</div>';
    document.getElementById('board').outerHTML = `<div id="board">${html}</div>`;
    document.getElementById('board-title').textContent = `Draft board · ${d.picks.length}/${n * rounds} picks`;
  }

  function drawPool() {
    const el = document.getElementById('pool');
    if (d.league.status !== 'drafting') {
      document.getElementById('pool-card').style.display = 'none';
      return;
    }
    const list = d.available.filter((a) =>
      (!filter.pos || a.position === filter.pos) &&
      (!filter.q || a.name.toLowerCase().includes(filter.q) || (a.team_name || '').toLowerCase().includes(filter.q)));
    const ok = canPick();
    el.innerHTML = `<table><tbody>${list.map((a) => `<tr>
      <td><strong>${esc(a.name)}</strong><div class="muted small">${esc(a.position || '—')} · ${esc(a.team_name || 'No team')}</div></td>
      <td class="num small">${pts(a.points)}</td>
      <td class="num"><button class="small ${ok ? 'gold' : ''}" data-act="pick" data-id="${a.id}" data-name="${esc(a.name)}" ${ok ? '' : 'disabled'}>Draft</button></td>
    </tr>`).join('') || '<tr><td class="empty">No players match.</td></tr>'}</tbody></table>`;
  }

  function drawMine() {
    const mine = d.picks.filter((p) => p.league_team_id === d.myTeamId);
    document.getElementById('mine').innerHTML = d.myTeamId
      ? (mine.map((p) => `<div class="row" style="padding:4px 0;border-bottom:1px solid var(--line)"><span class="muted small">R${p.round}</span><strong>${esc(p.athlete_name)}</strong><span class="muted small">${esc(p.position || '')}</span></div>`).join('') ||
        '<p class="empty">No picks yet.</p>') + `<p class="muted small">${mine.length}/${d.league.roster_size} roster spots filled</p>`
      : '<p class="muted">You are watching this draft. You do not have a team in it.</p>';
  }

  actions.pick = async (el) => {
    if (!canPick()) return;
    const forOther = d.state.onClock.id !== d.myTeamId;
    if (forOther && !confirm(`Draft ${el.dataset.name} for ${d.state.onClock.name}?`)) return;
    el.disabled = true;
    await POST(`/api/leagues/${id}/draft/pick`, { athlete_id: el.dataset.id });
    toast(`Drafted ${el.dataset.name}`);
    await load();
  };
  actions.pause = async () => {
    await POST(`/api/leagues/${id}/draft/pause`, { paused: !d.league.draft_paused });
    await load();
  };

  await load();
  const poll = setInterval(load, 2500);
  const timer = setInterval(tick, 250);
  onCleanup(() => { clearInterval(poll); clearInterval(timer); document.title = 'ΧΛΦ Fantasy'; });
}

// ---------- Admin ----------

const BOT_BADGE = (t) => (t?.bot ? `<span class="badge bot" title="Only admins see this">🤖 ${t.bot === 'win' ? 'win bot' : 'lose bot'}</span>` : '');

async function pageAdmin(tab = 'members', arg) {
  if (!S.me.is_admin) return render('<div class="card">Only admins can see this page.</div>');
  const sportKeys = Object.keys(S.sports);
  const tabs = [['members', 'Members'], ['rosters', 'Chi rosters'], ['stats', 'Games & stats'], ['leagues', 'Fantasy rosters & bots']];
  const head = `<div class="page-head"><h1>Admin</h1></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</div>`;
  const sportPills = (base, cur) => `<div class="weekpills">${sportKeys.map((k) =>
    `<a href="#/admin/${base}/${k}" class="${k === cur ? 'on' : ''}">${sportName(k)}</a>`).join('')}</div>`;

  if (tab === 'rosters') {
    const sport = S.sports[arg] ? arg : sportKeys[0];
    const d = await GET(`/api/sports/${sport}`);
    const club = d.teams.filter((t) => t.is_club);
    const count = (id) => d.athletes.filter((a) => a.active && a.im_team_id === id).length;
    render(`${head}${sportPills('rosters', sport)}
      <div class="card">
        <h2>${sportName(sport)} teams</h2>
        <div class="row">${club.map((t) => `<span>${esc(t.name)} ${teamBadges(t)} <span class="muted small">${count(t.id)} players</span></span>`).join('<span class="muted">·</span>')}</div>
        <p class="muted small">Pick each member's team below; it saves right away. Team settings (intramural points, fantasy multiplier) are on the sport's <a href="#/sport/${sport}/manage">Manage</a> tab.</p>
      </div>
      <div class="card table-wrap"><table><thead><tr><th>Member</th><th>Team</th><th>Position</th><th class="num">Fantasy pts</th></tr></thead><tbody>
      ${d.athletes.filter((a) => a.active).map((a) => `<tr><td><a href="#/player/${a.id}">${esc(a.name)}</a></td>
        <td><select data-edit-athlete="${a.id}" name="im_team_id"><option value="">No team</option>${options(d.teams, a.im_team_id)}</select></td>
        <td><select data-edit-athlete="${a.id}" name="position"><option value="">—</option>${d.sport.positions.map((p) => `<option ${p === a.position ? 'selected' : ''}>${p}</option>`).join('')}</select></td>
        <td class="num">${pts(a.points)}</td></tr>`).join('')}</tbody></table></div>`);
    document.querySelectorAll('[data-edit-athlete]').forEach((input) => input.addEventListener('change', async () => {
      try { await PUT(`/api/athletes/${input.dataset.editAthlete}`, { [input.name]: input.value }); toast('Saved'); } catch (err) { toast(err.message, true); }
    }));
    return;
  }

  if (tab === 'stats') {
    const sport = S.sports[arg] ? arg : sportKeys[0];
    const d = await GET(`/api/sports/${sport}`);
    const weeks = [...new Set(d.games.map((g) => g.week))];
    const listed = d.games.filter((g) => allGames || g.club_game || (!g.home_team_id && !g.away_team_id));
    const missing = listed.filter((g) => g.club_game && g.status === 'final' && !g.stat_lines).length;
    render(`${head}${sportPills('stats', sport)}
      <div class="card row"><span class="grow">${listed.length} games${missing ? ` · <strong>${missing} finished Chi game${missing === 1 ? '' : 's'} with no stats yet</strong>` : ''}.
        Open a game to set its teams, score and status and type the box score.</span>
        <a href="#" class="small" data-act="toggleAll">${allGames ? 'Only Chi games' : 'Show all games'}</a>
        <a class="btn secondary" href="#/sport/${sport}/schedule">Add a game</a></div>
      ${importCard(sport)}
      ${weeks.map((w) => `<div class="card table-wrap"><h2>Week ${w}</h2><table><tbody>
        ${listed.filter((g) => g.week === w).map((g) => `<tr>
          <td class="small muted" style="white-space:nowrap">${fmtDate(g.starts_at)}</td>
          <td>${g.home_name || g.away_name ? `${esc(g.home_name || 'TBD')} <span class="muted">vs</span> ${esc(g.away_name || 'TBD')}` : `<strong>${esc(g.notes || 'TBD')}</strong> <span class="muted small">teams TBD</span>`}</td>
          <td>${statusBadge(g.status)}</td>
          <td class="num small">${g.home_score != null ? `${g.away_score}-${g.home_score}` : '<span class="muted">no score</span>'}</td>
          <td class="num small">${g.stat_lines ? `${g.stat_lines} stat lines` : '<span class="muted">no stats</span>'}</td>
          <td class="num"><a class="btn small" href="#/game/${g.id}/edit">Edit</a></td></tr>`).join('') || '<tr><td class="empty">No Chi games this week.</td></tr>'}
        </tbody></table></div>`).join('') || '<div class="card empty">No games scheduled for this sport yet.</div>'}`);
    actions.toggleAll = () => { allGames = !allGames; pageAdmin('stats', sport); };
    wireImport(sport, () => pageAdmin('stats', sport));
    return;
  }

  if (tab === 'leagues') {
    const home = await GET('/api/home');
    const id = Number(arg) || home.leagues[0]?.id;
    if (!id) return render(`${head}<div class="card empty">No fantasy leagues yet. Create one from a sport's Fantasy leagues tab.</div>`);
    const d = await GET(`/api/leagues/${id}`);
    const L = d.league;
    const pool = (await GET(`/api/sports/${L.sport}`)).athletes.filter((a) => a.active);
    const owner = {};
    d.standings.forEach((t) => t.players.forEach((p) => (owner[p.athlete_id] = t.name)));
    const editable = ['active', 'complete'].includes(L.status);
    render(`${head}
      <div class="weekpills">${home.leagues.map((l) => `<a href="#/admin/leagues/${l.id}" class="${l.id === id ? 'on' : ''}">${S.sports[l.sport]?.icon || ''} ${esc(l.name)}</a>`).join('')}</div>
      <div class="card">
        <div class="row"><h2 style="margin:0">${esc(L.name)}</h2>${statusBadge(L.status)}<span class="grow"></span><a href="#/league/${L.id}">Open league</a></div>
        <p class="muted small">Bot teams look like normal members to everyone else. The win bot drafts and picks up the best players; the lose bot always takes the worst. During the season each bot makes at most one roster move every 6 hours.</p>
        ${L.status === 'setup' ? `<div class="row"><button class="gold" data-act="addBot" data-kind="win">Add a bot that tries to win</button>
          <button class="secondary" data-act="addBot" data-kind="lose">Add a bot that tries to lose</button></div>`
          : '<p class="muted small">Bots can join while the league is in draft setup.</p>'}
      </div>
      ${editable ? `<form class="card" data-form="adminRoster"><h2>Move a player</h2>
        <div class="form-grid">
          <div class="field"><label>Player</label><select name="add_id" required><option value="">Pick…</option>
            ${pool.map((a) => `<option value="${a.id}">${esc(a.name)}${owner[a.id] ? ` (on ${esc(owner[a.id])})` : ''}</option>`).join('')}</select></div>
          <div class="field"><label>To team</label><select name="team_id" required>${options(d.standings, '')}</select></div>
        </div>
        <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="count_past" value="1"> Count his past games for the new team (fixes a mistake instead of a normal pickup)</label>
        <p></p><button>Move player</button></form>` : ''}
      <div class="grid cards">${d.standings.map((t) => `<div class="card">
        <div class="row"><h3 style="margin:0">${esc(t.name)}</h3>${BOT_BADGE(t)}<span class="grow"></span>${editable ? pts(t.points) : ''}</div>
        <div class="muted small" style="margin-bottom:8px">${esc(t.owner_name)}</div>
        <table><tbody>${t.players.map((p) => `<tr><td>${esc(p.name)} <span class="muted small">${esc(p.team_name || '')}</span></td>
          <td class="num">${pts(p.points)}</td>
          ${editable ? `<td class="num"><button class="small danger" data-act="adminDrop" data-team="${t.id}" data-id="${p.athlete_id}" data-name="${esc(p.name)}">Remove</button></td>` : ''}</tr>`).join('') ||
          `<tr><td class="empty">${L.status === 'setup' ? 'Drafts when the league does.' : 'No players.'}</td></tr>`}</tbody></table></div>`).join('')}</div>`);
    actions.addBot = async (el) => {
      const r = await POST(`/api/leagues/${id}/bots`, { kind: el.dataset.kind });
      toast(`${r.owner} joined as ${r.name}`);
      pageAdmin('leagues', id);
    };
    actions.adminDrop = async (el) => {
      if (!confirm(`Remove ${el.dataset.name} from this team?`)) return;
      await POST(`/api/leagues/${id}/admin/roster`, { team_id: el.dataset.team, drop_id: el.dataset.id });
      pageAdmin('leagues', id);
    };
    forms.adminRoster = async (f) => {
      await POST(`/api/leagues/${id}/admin/roster`, { ...f, count_past: !!f.count_past });
      toast('Player moved');
      pageAdmin('leagues', id);
    };
    return;
  }

  const users = await GET('/api/users');
  const people = users.filter((u) => !u.bot);
  render(`${head}
    <div class="card">
      <h2>Running a season</h2>
      <ol>
        <li><strong>Chi rosters:</strong> put each member on his team for every sport.</li>
        <li><strong>Games & stats:</strong> after each game, open it, set the score and status to final, and type the box score.</li>
        <li><strong>Fantasy leagues:</strong> create one from a sport's Fantasy leagues tab, share the link, add bots if you want, and start the draft from the league page.</li>
        <li><strong>Fantasy rosters & bots:</strong> fix any fantasy roster by hand.</li>
      </ol>
    </div>
    <div class="card table-wrap">
      <h2>Members (${people.length})</h2>
      <table><thead><tr><th>Name</th><th>Username</th><th>Joined</th><th>Admin</th><th></th></tr></thead><tbody>
      ${people.map((u) => `<tr><td>${esc(u.display_name)}</td><td class="muted">${esc(u.username)}</td><td class="muted small">${fmtDate(u.created_at, false)}</td>
        <td>${u.is_admin ? '<span class="badge club">admin</span>' : ''}</td>
        <td class="num">${u.id !== S.me.id ? `<button class="small secondary" data-act="toggleAdmin" data-id="${u.id}" data-admin="${u.is_admin}">${u.is_admin ? 'Remove admin' : 'Make admin'}</button>` : ''}
        <button class="small secondary" data-act="resetPw" data-id="${u.id}" data-name="${esc(u.display_name)}">Reset password</button></td></tr>`).join('')}
      </tbody></table>
      ${users.length > people.length ? `<p class="muted small">${users.length - people.length} bot account(s) are hidden from this list. They are managed under Fantasy rosters & bots.</p>` : ''}
    </div>`);
  actions.toggleAdmin = async (el) => {
    await PUT(`/api/users/${el.dataset.id}`, { is_admin: el.dataset.admin !== '1' });
    pageAdmin();
  };
  actions.resetPw = async (el) => {
    const pw = prompt(`New password for ${el.dataset.name} (6+ characters). Tell them so they can log in and change it.`);
    if (!pw) return;
    await PUT(`/api/users/${el.dataset.id}`, { password: pw });
    toast('Password reset');
  };
}

// ---------- Boot ----------

(async function boot() {
  S.meta = await GET('/api/meta');
  S.sports = Object.fromEntries(S.meta.sports.map((s) => [s.key, s]));
  if (S.meta.demo) {
    document.querySelector('.brand').insertAdjacentHTML('beforeend', '<span class="badge demo" title="Demo data: made-up games and stats, separate from the real leagues">Demo</span>');
    document.title = 'ΧΛΦ Fantasy · Demo';
  }
  await refreshMe();
  // A failed Google sign-in comes back as ?auth_error=...; show it once and tidy the URL.
  const authError = new URLSearchParams(location.search).get('auth_error');
  if (authError) {
    history.replaceState(null, '', '/' + location.hash);
    setTimeout(() => toast(authError, true), 300);
  }
  window.addEventListener('hashchange', route);
  route();
})();
