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

function fmtDate(iso, withTime = true) {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return withTime ? `${day} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : day;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function fromLocalInput(v) {
  return v ? new Date(v).toISOString() : null;
}

const pts = (n) => `<span class="pts ${n < 0 ? 'neg' : ''}">${Number(n || 0).toFixed(1)}</span>`;
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
    return;
  }
  const here = location.hash;
  const link = (href, text) => `<a href="${href}" class="${here.startsWith(href) && href !== '#/' ? 'on' : ''}">${text}</a>`;
  nav.innerHTML = `
    ${link('#/', 'Home')}
    ${Object.values(S.sports).map((s) => link(`#/sport/${s.key}`, `${s.icon} ${esc(s.name)}`)).join('')}
    ${S.me.is_admin ? link('#/admin', 'Admin') : ''}
    <span class="spacer"></span>
    <span class="who">${esc(S.me.display_name)}</span>
    ${link('#/account', 'Account')}
    <a href="#" data-act="logout">Log out</a>`;
}

const routes = [
  [/^#\/login$/, pageLogin],
  [/^#\/register$/, pageRegister],
  [/^#\/sport\/(\w+)(?:\/(\w+))?$/, pageSport],
  [/^#\/game\/(\d+)(?:\/(edit))?$/, pageGame],
  [/^#\/player\/(\d+)$/, pagePlayer],
  [/^#\/league\/(\d+)\/draft$/, pageDraft],
  [/^#\/league\/(\d+)(?:\/(\w+))?$/, pageLeague],
  [/^#\/admin$/, pageAdmin],
  [/^#\/account$/, pageAccount],
  [/^#?\/?$/, pageHome],
];

async function route() {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  actions = { logout: doLogout };
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
      <p class="switch muted small">New here? <a href="#/register">Create an account</a></p>
    </div>`);
  forms.login = async (d) => {
    await POST('/api/auth/login', d);
    await refreshMe();
    location.hash = '#/';
  };
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
        <h2>Change password</h2>
        <div class="field"><label>Current password</label><input name="current_password" type="password" required></div>
        <div class="field"><label>New password</label><input name="new_password" type="password" required></div>
        <button>Change password</button>
      </form>
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
    toast('Password changed');
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
        <div class="${awayWin ? 'win' : ''}"><span>${esc(g.away_name || 'TBD')}</span><span>${showScore ? esc(g.away_score) : ''}</span></div>
        <div class="${homeWin ? 'win' : ''}"><span>${esc(g.home_name || 'TBD')}</span><span>${showScore ? esc(g.home_score) : ''}</span></div>
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
    <div class="page-head"><h1>Hey ${esc(S.me.display_name.split(' ')[0])} 👋</h1></div>

    <div class="grid sports" style="margin-bottom:18px">
      ${Object.values(S.sports).map((s) => `
        <a class="sport-tile" href="#/sport/${s.key}"><span class="icon">${s.icon}</span><span class="name">${esc(s.name)}</span></a>`).join('')}
    </div>

    <div class="card">
      <h2>My fantasy teams</h2>
      ${d.myTeams.length ? `<div class="grid cards">${d.myTeams.map((t) => `
        <div class="card" style="margin:0">
          <div class="row"><strong>${sportName(t.sport)}</strong><span class="grow"></span>${statusBadge(t.status)}</div>
          <h3 style="margin:8px 0 2px"><a href="#/league/${t.league_id}">${esc(t.team_name)}</a></h3>
          <div class="muted small">${esc(t.league_name)}</div>
          <div class="row" style="margin-top:8px">
            ${t.status === 'setup' ? `<span class="muted small">Waiting for the draft · ${t.teams} teams</span>` : ''}
            ${t.status === 'drafting' ? `<a class="btn gold" href="#/league/${t.league_id}/draft">Enter draft room</a>` : ''}
            ${['active', 'complete'].includes(t.status) ? `<span>Rank <strong>${t.rank}</strong> of ${t.teams}</span><span class="grow"></span>${pts(t.points)}<span class="muted small">pts</span>` : ''}
          </div>
        </div>`).join('')}</div>` : '<p class="empty">You are not in any leagues yet. Join one below or ask a commissioner to create one.</p>'}
    </div>

    ${open.length ? `<div class="card"><h2>Leagues open to join</h2>
      <table><tbody>${open.map((l) => `<tr class="click" data-act="go" data-href="#/league/${l.id}">
        <td>${sportName(l.sport)}</td><td><strong>${esc(l.name)}</strong></td><td class="muted">${esc(l.season || '')}</td>
        <td class="num"><a href="#/league/${l.id}">Join →</a></td></tr>`).join('')}</tbody></table></div>` : ''}

    <div class="grid two">
      <div class="card"><h2>Coming up</h2>${d.upcoming.map(gameRow).join('') || '<p class="empty">No games scheduled.</p>'}</div>
      <div class="card"><h2>Recent results</h2>${d.recent.map(gameRow).join('') || '<p class="empty">No results yet.</p>'}</div>
    </div>`);
  actions.go = (el) => (location.hash = el.dataset.href);
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
    schedule: () => `
      ${isAdmin ? `<details class="card"><summary><strong>Add a game</strong></summary>${gameForm(d.teams, {})}</details>` : ''}
      ${weeks.length ? weeks.map((w) => `
        <div class="card"><h2>Week ${esc(w)}</h2>${d.games.filter((g) => g.week === w).map(gameRow).join('')}</div>`).join('')
        : '<div class="card empty">No games yet.</div>'}`,

    standings: () => `
      <div class="card table-wrap"><table>
        <thead><tr><th>Team</th><th class="num">W</th><th class="num">L</th><th class="num">T</th><th class="num">PF</th><th class="num">PA</th></tr></thead>
        <tbody>${[...d.teams].sort((a, b) => b.record.w - a.record.w || a.record.l - b.record.l).map((t) => `
          <tr><td>${esc(t.name)} ${t.is_club ? '<span class="badge club">ΧΛΦ</span>' : ''}</td>
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
        </div>
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
      <table><tbody>${d.teams.map((t) => `<tr><td>${esc(t.name)} ${t.is_club ? '<span class="badge club">ΧΛΦ</span>' : ''}</td>
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

async function pageGame(id, mode) {
  const d = await GET(`/api/games/${id}`);
  const { game: g, sport: s } = d;
  const isAdmin = S.me.is_admin;
  const editing = mode === 'edit' && isAdmin;
  const showScore = g.status !== 'scheduled' && g.home_score != null;
  const side = (teamId) => d.players.filter((p) => p.im_team_id === teamId);
  const others = d.players.filter((p) => p.im_team_id !== g.home_team_id && p.im_team_id !== g.away_team_id);

  const boxTable = (title, players) => {
    const cols = s.stats.filter(([k]) => editing || players.some((p) => p.stats?.[k]));
    return `<div class="card table-wrap"><h2>${esc(title)}</h2>${players.length ? `<table>
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
      <div class="card row"><span class="grow">Type each player's numbers below, then save. Blank means zero. Set the game to <strong>live</strong> or <strong>final</strong> above for points to count.</span><button class="gold" data-act="saveStats">Save stats</button></div>` : ''}
    ${boxTable(g.away_name || 'Away', side(g.away_team_id))}
    ${boxTable(g.home_name || 'Home', side(g.home_team_id))}
    ${others.length ? boxTable('Others', others) : ''}
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
  actions.delGame = async () => {
    if (!confirm('Delete this game and its stats?')) return;
    await DEL(`/api/games/${g.id}`);
    location.hash = `#/sport/${g.sport}`;
  };
}

// ---------- Player ----------

async function pagePlayer(id) {
  const d = await GET(`/api/athletes/${id}`);
  const { athlete: a, sport: s } = d;
  const cols = s.stats.filter(([k]) => d.log.some((r) => r.stats[k]));
  const total = d.log.filter((r) => r.status !== 'scheduled').reduce((t, r) => t + r.points, 0);
  render(`
    <div class="page-head"><a href="#/sport/${a.sport}">${sportName(a.sport)}</a><span class="muted">/ Players</span></div>
    <div class="card">
      <h1>${esc(a.name)} ${a.active ? '' : '<span class="badge">inactive</span>'}</h1>
      <p class="muted">${esc(a.position || 'No position')} · ${esc(a.team_name || 'No team')}</p>
      <div class="row"><span>Season fantasy points (default scoring):</span>${pts(total)}</div>
      ${d.owners.length ? `<p>Owned in: ${d.owners.map((o) => `<a href="#/league/${o.league_id}">${esc(o.team_name)}</a> <span class="muted small">(${esc(o.league_name)})</span>`).join(', ')}</p>` : '<p class="muted">Free agent in every league.</p>'}
    </div>
    <div class="card table-wrap"><h2>Game log</h2>
      ${d.log.length ? `<table><thead><tr><th>Game</th>${cols.map(([, l]) => `<th class="num">${esc(l)}</th>`).join('')}<th class="num">FPTS</th></tr></thead>
      <tbody>${d.log.map((r) => `<tr><td><a href="#/game/${r.game_id}">Wk ${r.week}: ${esc(r.away_name)} @ ${esc(r.home_name)}</a>
        <div class="muted small">${fmtDate(r.starts_at, false)} ${r.status === 'final' ? `· ${r.away_score}-${r.home_score}` : `· ${r.status}`}</div></td>
        ${cols.map(([k]) => `<td class="num">${esc(r.stats[k] ?? 0)}</td>`).join('')}<td class="num">${pts(r.points)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="empty">No stats yet.</p>'}
    </div>`);
}

// ---------- League ----------

async function pageLeague(id, tab) {
  const d = await GET(`/api/leagues/${id}`);
  const { league: L, sport: s, myTeam } = d;
  const tabs = [['standings', 'Standings'], ['rosters', 'Rosters'], ['players', 'Free agents'], ['scoring', 'Scoring'], ['activity', 'Activity']];
  if (L.status === 'setup') tabs.splice(0, 3, ['setup', 'Draft setup']);
  tab = tab && tabs.some(([k]) => k === tab) ? tab : tabs[0][0];

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
            <td><strong>${esc(t.name)}</strong><div class="muted small">${esc(t.owner_name)}</div></td>
            <td class="num">${d.isCommish ? `
              <button class="small secondary" data-act="move" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="small secondary" data-act="move" data-i="${i}" data-dir="1" ${i === arr.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
              ${d.isCommish || t.user_id === S.me.id ? `<button class="small danger" data-act="kick" data-id="${t.id}">${t.user_id === S.me.id ? 'Leave' : 'Remove'}</button>` : ''}
            </td></tr>`).join('')}</tbody></table>` : '<p class="empty">Nobody has joined yet.</p>'}
          ${d.isCommish ? `<div class="row" style="margin-top:12px">
            <button class="secondary" data-act="randomize">Randomize order</button><span class="grow"></span>
            <button class="gold" data-act="startDraft">Start the draft</button></div>` : ''}
        </div>
        <div class="card">
          ${myTeam ? `<h2>You're in!</h2><p>Your team: <strong>${esc(myTeam.name)}</strong></p>
            <form data-form="rename" class="row"><input name="name" value="${esc(myTeam.name)}" maxlength="40"><button class="secondary">Rename</button></form>`
            : `<h2>Join this league</h2><form data-form="join"><div class="field"><label>Team name</label>
              <input name="name" maxlength="40" placeholder="${esc(S.me.display_name)}'s ${esc(s.name)} squad"></div><button class="gold">Join league</button></form>`}
          <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
          <h3>How it works</h3>
          <ul class="small">
            <li>Snake draft: ${d.standings.length || 'N'} teams, ${L.roster_size} rounds. Order flips every round.</li>
            <li>${L.pick_seconds ? `${L.pick_seconds} seconds per pick. If the clock runs out, the best available player is picked for you.` : 'No pick clock.'}</li>
            <li>Every player on your roster scores. After the draft you can add and drop free agents.</li>
            <li>Points only count for games that start while the player is on your roster.</li>
          </ul>
        </div>
      </div>`,

    standings: () => {
      const weeks = d.weeks;
      return `<div class="card table-wrap"><table>
        <thead><tr><th>#</th><th>Team</th>${weeks.map((w) => `<th class="num">Wk ${w}</th>`).join('')}<th class="num">Total</th></tr></thead>
        <tbody>${d.standings.map((t) => `<tr class="${t.user_id === S.me.id ? 'me' : ''}">
          <td>${t.rank}</td><td><strong>${esc(t.name)}</strong><div class="muted small">${esc(t.owner_name)}</div></td>
          ${weeks.map((w) => `<td class="num">${t.weeks[w] != null ? Number(t.weeks[w]).toFixed(1) : '<span class="muted">–</span>'}</td>`).join('')}
          <td class="num">${pts(t.points)}</td></tr>`).join('')}</tbody></table></div>
        ${myTeam ? rosterCard(myTeam, true) : ''}`;
    },

    rosters: () => `<div class="grid cards">${d.standings.map((t) => rosterCard(t, t.user_id === S.me.id)).join('')}</div>`,

    players: () => {
      const full = myTeam && myTeam.players.length >= L.roster_size;
      return `<div class="card">
        ${L.status !== 'active' ? '<p class="muted">Free agency is closed.</p>' : myTeam ? `<p class="muted small">${full
          ? 'Your roster is full, so adding a player means choosing someone to drop.'
          : `You have ${L.roster_size - myTeam.players.length} open roster spot(s).`}</p>` : '<p class="muted small">You are not in this league.</p>'}
        <div class="table-wrap"><table><thead><tr><th>Player</th><th>Pos</th><th>Team</th><th class="num">GP</th><th class="num">Pts</th><th></th></tr></thead>
        <tbody>${d.freeAgents.map((a) => `<tr><td><a href="#/player/${a.id}">${esc(a.name)}</a></td><td>${esc(a.position || '')}</td>
          <td>${esc(a.team_name || '')}</td><td class="num">${a.games}</td><td class="num">${pts(a.points)}</td>
          <td class="num">${myTeam && L.status === 'active' ? `<button class="small" data-act="add" data-id="${a.id}" data-name="${esc(a.name)}">Add</button>` : ''}</td></tr>`).join('') ||
          '<tr><td colspan="6" class="empty">No free agents.</td></tr>'}</tbody></table></div></div>`;
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
      </div>
      <div class="row"><button>Save settings</button><span class="grow"></span>
        ${L.status === 'active' ? '<button type="button" class="secondary" data-act="finish">End season</button>' : ''}
        ${L.status === 'complete' ? '<button type="button" class="secondary" data-act="reopen">Reopen season</button>' : ''}
        ${S.me.is_admin ? '<button type="button" class="danger" data-act="delLeague">Delete league</button>' : ''}</div>
    </form>` : ''}`,

    activity: () => `<div class="card"><ul class="feed">${d.activity.map((a) => `<li>${esc(a.text)} <span class="muted small">· ${fmtDate(a.created_at)}</span></li>`).join('') || '<li class="empty">Nothing yet.</li>'}</ul></div>`,
  };

  render(`
    <div class="page-head">
      <span class="big-icon">${s.icon}</span>
      <div class="grow"><h1>${esc(L.name)}</h1><div class="muted">${esc(s.name)}${L.season ? ` · ${esc(L.season)}` : ''} · ${L.roster_size} players per team</div></div>
      ${statusBadge(L.status === 'complete' ? 'final' : L.status)}
    </div>
    ${drafting}
    ${L.status === 'complete' && d.standings[0] ? `<div class="card" style="text-align:center"><span style="font-size:2rem">🏆</span><h2>${esc(d.standings[0].name)} wins the season!</h2><p class="muted">${esc(d.standings[0].owner_name)} · ${d.standings[0].points.toFixed(1)} points</p></div>` : ''}
    <div class="tabs">${tabs.map(([k, label]) => `<a href="#/league/${L.id}/${k}" class="${k === tab ? 'on' : ''}">${label}</a>`).join('')}
      ${['drafting', 'active', 'complete'].includes(L.status) ? `<a href="#/league/${L.id}/draft">Draft board</a>` : ''}</div>
    ${body[tab]()}`);

  const reload = () => pageLeague(id, tab);
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
    await POST(`/api/leagues/${L.id}/transactions`, { drop_id: el.dataset.id });
    toast(`Dropped ${el.dataset.name}`);
    reload();
  };
  actions.add = async (el) => {
    let drop_id = null;
    if (myTeam.players.length >= L.roster_size) {
      const list = myTeam.players.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
      const pick = prompt(`Your roster is full. Who do you want to drop for ${el.dataset.name}? Type the number:\n\n${list}`);
      if (!pick) return;
      const p = myTeam.players[Number(pick) - 1];
      if (!p) return toast('That number is not on the list.', true);
      drop_id = p.athlete_id;
    }
    await POST(`/api/leagues/${L.id}/transactions`, { add_id: el.dataset.id, drop_id });
    toast(`Added ${el.dataset.name}`);
    reload();
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

  function rosterCard(t, mine) {
    const canDrop = mine && L.status === 'active';
    return `<div class="card">
      <div class="row"><h3 style="margin:0">${esc(t.name)}</h3><span class="grow"></span>${pts(t.points)}</div>
      <div class="muted small" style="margin-bottom:8px">${esc(t.owner_name)} · Rank ${t.rank}</div>
      <table><tbody>${t.players.map((p) => `<tr><td><a href="#/player/${p.athlete_id}">${esc(p.name)}</a>
        <div class="muted small">${esc(p.position || '')} ${p.team_name ? `· ${esc(p.team_name)}` : ''}</div></td>
        <td class="num">${pts(p.points)}</td>
        ${canDrop ? `<td class="num"><button class="small danger" data-act="drop" data-id="${p.athlete_id}" data-name="${esc(p.name)}">Drop</button></td>` : ''}</tr>`).join('') ||
        '<tr><td class="empty">No players yet.</td></tr>'}</tbody></table></div>`;
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
  onCleanup(() => { clearInterval(poll); clearInterval(timer); });
}

// ---------- Admin ----------

async function pageAdmin() {
  if (!S.me.is_admin) return render('<div class="card">Only admins can see this page.</div>');
  const users = await GET('/api/users');
  render(`
    <div class="page-head"><h1>Admin</h1></div>
    <div class="card">
      <h2>Getting a season going</h2>
      <ol>
        <li>Open a sport (top menu) → <strong>Manage</strong>, add the intramural teams and paste in the players.</li>
        <li><strong>Schedule</strong> tab → add the games.</li>
        <li><strong>Fantasy leagues</strong> tab → create the league and share the link so brothers can join.</li>
        <li>On the league page, set the draft order and hit <strong>Start the draft</strong>.</li>
        <li>After each game, open it → <strong>Enter score & stats</strong>, mark it final, and the standings update.</li>
      </ol>
    </div>
    <div class="card table-wrap">
      <h2>Members (${users.length})</h2>
      <table><thead><tr><th>Name</th><th>Username</th><th>Joined</th><th>Admin</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.display_name)}</td><td class="muted">${esc(u.username)}</td><td class="muted small">${fmtDate(u.created_at, false)}</td>
        <td>${u.is_admin ? '<span class="badge club">admin</span>' : ''}</td>
        <td class="num">${u.id !== S.me.id ? `<button class="small secondary" data-act="toggleAdmin" data-id="${u.id}" data-admin="${u.is_admin}">${u.is_admin ? 'Remove admin' : 'Make admin'}</button>` : ''}
        <button class="small secondary" data-act="resetPw" data-id="${u.id}" data-name="${esc(u.display_name)}">Reset password</button></td></tr>`).join('')}
      </tbody></table>
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
  await refreshMe();
  window.addEventListener('hashchange', route);
  route();
})();
