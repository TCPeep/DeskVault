// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Storage > Installed apps: every desktop and Microsoft Store app with its icon, size, when you last opened
// it, your own rating and notes, and uninstalling one or many (each app's own uninstaller, one at a time).
import { parseHash, go } from './state.js';
import { get, post } from './api.js';
import * as ui from './ui.js';
const { esc, icon } = ui;

const HALF_YEAR = 182 * 864e5;
const A = { page: null, data: null, error: null, q: '', src: 'all', filter: '', sort: 'size', sel: new Set(), loading: false };
const host = () => (parseHash().name === 'storage' && parseHash().arg === 'apps' ? A.page?.querySelector('#apps') : null);
const appById = id => A.data?.apps.find(a => a.id === id);
const old = a => a.lastUsed && Date.now() - Date.parse(a.lastUsed) > HALF_YEAR;

/** The Files / Installed apps switch shown in the Storage page header. */
export function modeSeg(mode) {
  return `<div class="seg stg-mode"><button data-stmode="files" class="${mode === 'files' ? 'on' : ''}">${icon('pie')}Files &amp; folders</button><button data-stmode="apps" class="${mode === 'apps' ? 'on' : ''}">${icon('app')}Installed apps</button></div>`;
}

export async function renderApps(page) {
  A.page = page;
  page.innerHTML = `<div id="apps">${headHtml()}<div class="loading">${icon('loader', 'spin')} Reading installed apps…</div></div>`;
  await load();
  draw();
}

async function load(refresh = false) {
  A.loading = true;
  try { A.data = await get('/api/apps' + (refresh ? '?refresh=1' : '')); A.error = null; }
  catch (e) { A.error = e.message; }
  A.loading = false;
  if (A.data) for (const id of [...A.sel]) if (!appById(id)) A.sel.delete(id);
}

function headHtml() {
  return `<div class="page-head"><h1>Storage</h1><span class="sub">See what's installed, what you never open, and remove it with its own uninstaller</span><div class="grow"></div>${modeSeg('apps')}</div>`;
}

function draw() {
  const el = host();
  if (!el) return;
  if (A.error && !A.data) { el.innerHTML = `${headHtml()}<div class="empty"><h2>Couldn't read installed apps</h2><p>${esc(A.error)}</p><button class="btn" data-aact="refresh">${icon('refresh')}Try again</button></div>`; return; }
  el.innerHTML = `${headHtml()}
    <div class="kpis" style="margin-top:16px">${kpisHtml()}</div>
    <section class="panel" id="appQueue" ${A.data.queue ? '' : 'hidden'}>${queueHtml()}</section>
    <section class="panel apps-panel">
      <div class="filters apps-filters">
        <input class="input" id="appSearch" placeholder="Search apps or publishers" value="${esc(A.q)}">
        <div class="seg">${[['all', 'All'], ['desktop', 'Desktop'], ['store', 'Store']].map(([k, l]) => `<button data-src="${k}" class="${A.src === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select class="input" id="appSort" aria-label="Sort">${[['size', 'Biggest first'], ['name', 'Name'], ['unused', 'Longest since opened'], ['recent', 'Recently installed'], ['oldest', 'Oldest installs'], ['rating', 'Your rating']].map(([k, l]) => `<option value="${k}" ${A.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="grow"></div>
        <button class="btn sm ghost" data-aact="refresh" ${A.loading ? 'disabled' : ''}>${icon(A.loading ? 'loader' : 'refresh', A.loading ? 'spin' : '')}Refresh</button>
      </div>
      <div class="apps-chips">${[['', 'Everything'], ['unused', 'Not opened in 6 months'], ['never', 'No launch history'], ['unrated', 'Not rated yet'], ['low', 'Rated 1–2 stars'], ['missing', 'Leftover entries']].map(([k, l]) => `<button class="chip ${A.filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
      <div id="appBulk">${bulkHtml()}</div>
      <div class="apps-list" id="appList">${listHtml()}</div>
      <p class="muted apps-foot">"Last opened" comes from Windows' record of programs started from the Start menu, taskbar or Explorer, so apps that only start by themselves show no history. Sizes are what each app reports, or what DeskVault measured.</p>
    </section>`;
}

function kpisHtml() {
  const apps = A.data.apps;
  const sum = list => list.reduce((s, a) => s + (a.size || 0), 0);
  const unused = apps.filter(old), missing = apps.filter(a => a.missing);
  const desk = apps.filter(a => a.kind === 'desktop').length;
  return `
    <div class="kpi"><span class="k">${icon('app')}Installed</span><span class="v">${apps.length}</span><span class="s">${desk} desktop · ${apps.length - desk} Store apps</span></div>
    <div class="kpi"><span class="k">${icon('drive')}Space used</span><span class="v">${ui.fmtBytes(sum(apps))}</span><span class="s">by the ${apps.filter(a => a.size).length} apps that report a size</span></div>
    <button class="kpi click" data-filter="unused"><span class="k">${icon('clock')}Not opened in 6 months</span><span class="v">${unused.length}</span><span class="s">${ui.fmtBytes(sum(unused))} you could get back</span></button>
    <button class="kpi click" data-filter="missing"><span class="k">${icon('alert')}Leftover entries</span><span class="v">${missing.length}</span><span class="s">Listed as installed but their files are gone</span></button>`;
}

function visible() {
  const q = A.q.trim().toLowerCase();
  let list = A.data.apps.filter(a => (A.src === 'all' || a.kind === A.src)
    && (!q || a.name.toLowerCase().includes(q) || (a.publisher || '').toLowerCase().includes(q))
    && (!A.filter || (A.filter === 'unused' ? old(a) : A.filter === 'never' ? !a.lastUsed : A.filter === 'unrated' ? !a.stars : A.filter === 'low' ? a.stars && a.stars <= 2 : A.filter === 'missing' ? a.missing : true)));
  const by = {
    size: (x, y) => (y.size || 0) - (x.size || 0),
    name: (x, y) => x.name.localeCompare(y.name),
    unused: (x, y) => (x.lastUsed || '0').localeCompare(y.lastUsed || '0') || (y.size || 0) - (x.size || 0),
    recent: (x, y) => (y.installed || '').localeCompare(x.installed || ''),
    oldest: (x, y) => (x.installed || '9').localeCompare(y.installed || '9'),
    rating: (x, y) => (y.stars || 0) - (x.stars || 0) || x.name.localeCompare(y.name),
  }[A.sort];
  return list.sort(by);
}

export function appIcon(a, cls = '') {
  if (a.icon) return `<img class="app-ico ${cls}" src="/api/apps/icon/${esc(a.icon)}" alt="" loading="lazy">`;
  const hue = [...a.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<span class="app-ico letter ${cls}" style="background:hsl(${hue} 45% 42%)">${esc((a.name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}</span>`;
}

function stars(a, big = false) {
  return `<span class="stars ${big ? 'big' : ''}" role="group" aria-label="Your rating">${[1, 2, 3, 4, 5].map(n => `<button data-star="${n}" class="${n <= (a.stars || 0) ? 'on' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}" title="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</span>`;
}

function lastUsedText(a) {
  if (!a.lastUsed) return '<span class="muted">No history</span>';
  return `<span class="${old(a) ? 'stale' : ''}" title="${esc(ui.fmtDate(a.lastUsed))}">${esc(ui.timeAgo(a.lastUsed))}</span>`;
}

function listHtml() {
  const list = visible();
  if (!list.length) return `<p class="muted" style="padding:20px 4px">No apps match.</p>`;
  const allOn = list.every(a => A.sel.has(a.id) || a.noRemove);
  return `<div class="app-row head"><label class="cb"><input type="checkbox" data-selall ${allOn ? 'checked' : ''} aria-label="Select all shown"></label><span></span><span>App</span><span class="r">Size</span><span>Installed</span><span>Last opened</span><span>Your rating</span><span></span></div>
    ${list.map(a => `<div class="app-row ${A.sel.has(a.id) ? 'sel' : ''}" data-app="${esc(a.id)}">
      <label class="cb"><input type="checkbox" data-sel ${A.sel.has(a.id) ? 'checked' : ''} ${a.noRemove ? 'disabled title="This app can\'t be removed from here"' : ''} aria-label="Select ${esc(a.name)}"></label>
      ${appIcon(a)}
      <span class="nm"><b>${esc(a.name)}</b><span class="muted">${esc(a.publisher || (a.kind === 'store' ? 'Microsoft Store app' : ''))}${a.version ? ` · ${esc(a.version)}` : ''}</span>
        ${a.missing ? `<span class="tagx warn">${icon('alert')}Files missing</span>` : ''}${a.kind === 'store' ? '<span class="tagx">Store</span>' : ''}</span>
      <span class="r">${a.size ? ui.fmtBytes(a.size) : '<span class="muted">?</span>'}</span>
      <span>${a.installed ? esc(ui.fmtDate(a.installed, false)) : '<span class="muted">?</span>'}</span>
      <span>${lastUsedText(a)}</span>
      ${stars(a)}
      <button class="icon-btn" data-aact="details" title="Details">${icon('info')}</button>
    </div>`).join('')}`;
}

function bulkHtml() {
  if (!A.sel.size) return '';
  const picked = [...A.sel].map(appById).filter(Boolean);
  const bytes = picked.reduce((s, a) => s + (a.size || 0), 0);
  return `<div class="bulk" style="margin:12px 0"><span class="count">${picked.length} selected${bytes ? ` · ${ui.fmtBytes(bytes)}` : ''}</span>
    <div class="grow"></div>
    <button class="btn sm danger" data-aact="uninstall-sel">${icon('trash')}Uninstall ${picked.length === 1 ? 'it' : `${picked.length} apps`}…</button>
    <button class="icon-btn" data-aact="clear-sel" title="Clear selection">${icon('x')}</button></div>`;
}

const STATE = { waiting: ['clock', 'Waiting'], running: ['loader', 'Working'], done: ['check-circle', 'Uninstalled'], kept: ['alert', 'Still installed'], skipped: ['skip', 'Skipped'], cancelled: ['x', 'Cancelled'], failed: ['alert', 'Failed'] };
function queueHtml() {
  const q = A.data?.queue;
  if (!q) return '';
  const done = q.items.filter(i => !['waiting', 'running'].includes(i.state)).length;
  const running = q.state === 'running';
  return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <h2 style="flex:1;margin:0">${icon(running ? 'loader' : 'check', running ? 'spin' : '')}${running ? `Uninstalling ${Math.min(done + 1, q.items.length)} of ${q.items.length}` : `Finished ${q.items.length} uninstall${q.items.length === 1 ? '' : 's'}`}</h2>
      ${running ? `<button class="btn sm" data-aact="q-skip" title="Move on without waiting for this one">${icon('skip')}Skip this one</button><button class="btn sm" data-aact="q-cancel">${icon('x')}Cancel the rest</button>` : `<button class="btn sm" data-aact="q-clear">${icon('x')}Close</button>`}
    </div>
    ${running ? '<p class="desc" style="margin:6px 0 0">Each app\'s own uninstaller opens in turn. Windows may ask for permission for each one, and the window can open behind your browser, so check the taskbar.</p>' : ''}
    <div class="queue-list">${q.items.map(i => {
      const [ic, label] = STATE[i.state] || ['info', i.state];
      return `<div class="queue-row q-${i.state}">${appIcon(i)}<b>${esc(i.name)}</b><span class="badge">${icon(ic, i.state === 'running' ? 'spin' : '')}${label}</span><span class="muted">${esc(i.message || '')}</span></div>`;
    }).join('')}</div>`;
}

function redraw(part) {
  const el = host();
  if (!el) return;
  if (part === 'queue') { const p = el.querySelector('#appQueue'); if (p) { p.hidden = !A.data?.queue; p.innerHTML = queueHtml(); } return; }
  const list = el.querySelector('#appList'), bulk = el.querySelector('#appBulk');
  if (list) list.innerHTML = listHtml();
  if (bulk) bulk.innerHTML = bulkHtml();
}

// ---------- details ----------
async function details(id) {
  const a = appById(id);
  if (!a) return;
  const row = (k, v) => (v ? `<div class="k">${k}</div><div class="v">${v}</div>` : '');
  await ui.modal({
    title: 'App details',
    wide: true,
    body: `<div class="app-detail">
      <div class="app-detail-head">${appIcon(a, 'xl')}<div><div class="nm">${esc(a.name)}</div><div class="muted">${esc(a.publisher || '')}${a.version ? ` · version ${esc(a.version)}` : ''}</div>
        <div class="app-links">${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${icon('globe')}Website</a>` : ''}${a.help ? `<a href="${esc(a.help)}" target="_blank" rel="noopener noreferrer">${icon('lifebuoy')}Help</a>` : ''}</div></div></div>
      ${a.missing ? `<p class="app-warn">${icon('alert')} This app's files seem to be gone but Windows still lists it. Its uninstaller may not run. If it fails, the entry is a harmless leftover.</p>` : ''}
      <div class="kv">
        ${row('Size', `<span id="appSize">${a.size ? `${ui.fmtBytes(a.size)} <span class="muted">(${esc(a.sizeFrom === 'measured' ? `measured ${ui.timeAgo(a.measuredAt)}` : 'reported by the app')})</span>` : '<span class="muted">Unknown</span>'}</span>${a.location ? ` <button class="btn sm ghost" data-measure>${icon('pie')}Measure</button>` : ''}`)}
        ${row('Installed', a.installed ? esc(ui.fmtDate(a.installed, false)) : '<span class="muted">Unknown</span>')}
        ${row('Last opened', a.lastUsed ? `${esc(ui.fmtDate(a.lastUsed))} <span class="muted">(${esc(ui.timeAgo(a.lastUsed))})</span>` : '<span class="muted">No launch history</span>')}
        ${row('Type', esc([a.kind === 'store' ? 'Microsoft Store app' : 'Desktop app', a.arch, a.msi ? 'Windows Installer' : null].filter(Boolean).join(' · ')))}
        ${row('Installed for', esc(a.scope || ''))}
        ${row('Location', a.location ? `<span class="path">${esc(a.location)}</span> <button class="btn sm ghost" data-openfolder>${icon('folder-open')}Open</button>` : '')}
        ${row('About', a.comments ? esc(a.comments) : '')}
        ${row('Uninstaller', `<code class="path">${esc(a.uninstall)}</code>`)}
      </div>
      <div class="app-rate"><span class="k">Your rating</span>${stars(a, true)}<textarea class="input" id="appNote" rows="2" maxlength="1000" placeholder="A note for yourself, e.g. why you keep it">${esc(a.note || '')}</textarea></div>
    </div>`,
    onOpen: m => {
      m.addEventListener('click', async e => {
        const st = e.target.closest('[data-star]');
        if (st) { await rate(a.id, +st.dataset.star); m.querySelector('.stars').outerHTML = stars(appById(a.id), true); return; }
        if (e.target.closest('[data-measure]')) {
          const b = e.target.closest('[data-measure]'); b.disabled = true; b.innerHTML = `${icon('loader', 'spin')}Measuring…`;
          try { const r = await post('/api/apps/measure', { id: a.id }); await load(); m.querySelector('#appSize').innerHTML = `${ui.fmtBytes(r.bytes)} <span class="muted">(measured just now, ${r.files.toLocaleString()} files)</span>`; redraw(); }
          catch (err) { ui.toast(err.message, { type: 'error' }); }
          b.remove();
        }
        if (e.target.closest('[data-openfolder]')) post('/api/apps/open-folder', { id: a.id }).catch(err => ui.toast(err.message, { type: 'error' }));
      });
      m.querySelector('#appNote').addEventListener('change', e => saveNote(a.id, e.target.value));
    },
    actions: [
      ...(a.noRemove ? [] : [{ label: 'Uninstall…', icon: 'trash', kind: 'danger', left: true, onClick: async (m, close) => { saveNote(a.id, m.querySelector('#appNote').value); close(); uninstall([a.id]); } }]),
      { label: 'Done', kind: 'primary', onClick: m => { saveNote(a.id, m.querySelector('#appNote').value); } },
    ],
  });
}

async function rate(id, n) {
  const a = appById(id);
  if (!a) return;
  const stars = a.stars === n ? 0 : n;
  try { Object.assign(a, await post('/api/apps/note', { id, stars })); } catch (e) { ui.toast(e.message, { type: 'error' }); }
  redraw();
}
async function saveNote(id, note) {
  const a = appById(id);
  if (!a || (a.note || '') === note) return;
  try { Object.assign(a, await post('/api/apps/note', { id, note })); } catch (e) { ui.toast(e.message, { type: 'error' }); }
}

// ---------- uninstall ----------
async function uninstall(ids) {
  const picked = ids.map(appById).filter(a => a && !a.noRemove);
  if (!picked.length) return;
  const bytes = picked.reduce((s, a) => s + (a.size || 0), 0);
  const ok = await ui.confirm({
    title: picked.length === 1 ? `Uninstall ${picked[0].name}?` : `Uninstall ${picked.length} apps?`,
    html: `<div class="uninst-list">${picked.map(a => `<div>${appIcon(a)}<span>${esc(a.name)}</span><span class="muted">${a.size ? ui.fmtBytes(a.size) : ''}</span></div>`).join('')}</div>
      <p class="desc">${picked.length > 1 ? 'They run one at a time. ' : ''}Each app's <b>own uninstaller</b> opens and you finish it there, the same as from Windows Settings. Windows may ask for permission, and the window can open behind your browser.${bytes ? ` About <b>${ui.fmtBytes(bytes)}</b> should be freed.` : ''}</p>
      <p class="desc">Settings and saved files some apps keep in your user folder may stay behind.</p>`,
    confirmLabel: picked.length === 1 ? 'Uninstall' : `Uninstall ${picked.length}`,
    danger: true,
  });
  if (!ok) return;
  try {
    A.data.queue = await post('/api/apps/uninstall', { ids: picked.map(a => a.id) });
    for (const a of picked) A.sel.delete(a.id);
    redraw(); redraw('queue');
    host()?.querySelector('#appQueue')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { ui.toast(e.message, { type: 'error' }); }
}

export async function onAppsEvent(d) {
  if (!A.data) return;
  if (d.queue !== undefined) { A.data.queue = d.queue; redraw('queue'); }
  if (d.changed) {
    const before = A.data.apps.length;
    await load(true);
    if (!host()) return;
    draw();
    const gone = before - A.data.apps.length;
    if (gone > 0) ui.toast(`${gone} app${gone === 1 ? '' : 's'} removed`, { type: 'ok' });
  }
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const m = e.target.closest('[data-stmode]');
  if (m && parseHash().name === 'storage') return go('storage', m.dataset.stmode === 'apps' ? 'apps' : null);
  const el = host();
  if (!el || !el.contains(e.target)) return;
  const t = e.target;
  const src = t.closest('[data-src]');
  if (src) { A.src = src.dataset.src; return draw(); }
  const f = t.closest('[data-filter]');
  if (f) { A.filter = A.filter === f.dataset.filter ? '' : f.dataset.filter; return draw(); }
  if (t.closest('[data-selall]')) {
    const list = visible().filter(a => !a.noRemove);
    const on = t.closest('[data-selall]').checked;
    for (const a of list) on ? A.sel.add(a.id) : A.sel.delete(a.id);
    return redraw();
  }
  const row = t.closest('[data-app]');
  const star = t.closest('[data-star]');
  if (row && star) return rate(row.dataset.app, +star.dataset.star);
  if (row && t.closest('[data-sel]')) { const id = row.dataset.app; t.checked ? A.sel.add(id) : A.sel.delete(id); row.classList.toggle('sel', t.checked); const b = el.querySelector('#appBulk'); if (b) b.innerHTML = bulkHtml(); return; }
  if (row && t.closest('.cb')) return;
  const act = t.closest('[data-aact]')?.dataset.aact;
  if (act === 'refresh') { A.loading = true; redrawRefresh(); await load(true); return draw(); }
  if (act === 'clear-sel') { A.sel.clear(); return redraw(); }
  if (act === 'uninstall-sel') return uninstall([...A.sel]);
  if (act === 'q-skip') return post('/api/apps/queue/skip').catch(err => ui.toast(err.message, { type: 'error' }));
  if (act === 'q-cancel') return post('/api/apps/queue/cancel').catch(err => ui.toast(err.message, { type: 'error' }));
  if (act === 'q-clear') { await post('/api/apps/queue/clear').catch(() => {}); A.data.queue = null; return redraw('queue'); }
  if (row) return details(row.dataset.app);
});
function redrawRefresh() { const b = host()?.querySelector('[data-aact="refresh"]'); if (b) { b.disabled = true; b.innerHTML = `${icon('loader', 'spin')}Refresh`; } }
const search = ui.debounce(() => redraw(), 120);
document.addEventListener('input', e => { if (e.target.id === 'appSearch' && host()) { A.q = e.target.value; search(); } });
document.addEventListener('change', e => { if (e.target.id === 'appSort' && host()) { A.sort = e.target.value; redraw(); } });
