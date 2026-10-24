// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Settings + Activity pages.
import { S, refresh, parseHash, openItem, itemById } from './state.js';
import { get, post } from './api.js';
import * as ui from './ui.js';
import { pickPaths } from './actions.js';
const { esc, icon } = ui;

const onSettings = () => parseHash().name === 'settings' && document.querySelector('#settingsPage');

export function renderSettings(page) {
  const s = S.settings, a = S.app;
  const counts = k => S.items.filter(i => i.kind === k).length;
  page.innerHTML = `<div id="settingsPage" style="max-width:860px">
    <div class="page-head"><h1>Settings</h1></div>

    <section class="panel"><h2>${icon('eye')}Appearance</h2>
      <div class="row-field"><div class="grow"><div class="t">Theme</div></div>
        <div class="seg">${[['system', 'System'], ['dark', 'Dark'], ['light', 'Light']].map(([v, l]) => `<button data-theme="${v}" class="${s.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    </section>

    <section class="panel"><h2>${icon('locate')}Tracking</h2>
      <p class="desc">Vault checks every tracked path regularly. When something moves on the same drive (even if it's renamed), Windows tells Vault where it went right away. If it was copied somewhere and the original deleted, Vault searches for it by name and confirms it's the same file before switching.</p>
      <div class="row-field"><div class="grow"><div class="t">Check locations every</div><div class="d">${S.tracker.lastCheck ? `Last checked ${esc(ui.timeAgo(S.tracker.lastCheck))}` : ''}</div></div>
        <select class="input" data-set="checkIntervalSec">${[[30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes']].map(([v, l]) => `<option value="${v}" ${+s.checkIntervalSec === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="row-field"><div class="grow"><div class="t">Also search other drives</div><div class="d">Look on your other drives (not the Windows drive) when something can't be followed directly.</div></div>
        <input type="checkbox" class="switch" data-set="searchOtherDrives" ${s.searchOtherDrives ? 'checked' : ''}></div>
      <div class="field" style="margin-top:6px"><span class="field-label">Places to search</span>
        <div class="list-plain">${(s.searchRoots || []).map((r, i) => `<div class="li">${icon('folder')}<span class="mono">${esc(r)}</span><button class="icon-btn" data-act="rm-root" data-i="${i}" title="Remove">${icon('x')}</button></div>`).join('') || '<div class="muted">None, so only the area around each item\'s last location is searched.</div>'}</div>
        <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm" data-act="add-root">${icon('folder-plus')}Add a folder…</button><button class="btn sm ghost" data-act="reset-roots">Reset to your user folder</button></div>
        <div class="hint">Vault always looks near where the item used to be first. System folders, AppData, node_modules, .git and the Recycle Bin are skipped.</div>
      </div>
    </section>

    <section class="panel"><h2>${icon('backup')}Backups</h2>
      <div class="field"><label>Skip these inside folders when backing up</label>
        <input class="input" data-set="backupExcludes" value="${esc((s.backupExcludes || []).join(', '))}">
        <div class="hint">Folder or file names, comma separated. These are usually rebuildable (like node_modules) or junk.</div></div>
    </section>

    <section class="panel"><h2>${icon('sparkle')}Local AI</h2>
      <p class="desc">Uses Ollama on this PC for Ask AI, summaries and tag suggestions. Nothing is sent online, and locked items are never shown to it.</p>
      <div class="row-field"><div class="grow"><div class="t">Use local AI</div><div class="d"><a href="#/ai">Open Ask AI</a> to pick the model, download the search helper or free GPU memory.</div></div>
        <input type="checkbox" class="switch" data-aiset="enabled" ${s.ai?.enabled !== false ? 'checked' : ''}></div>
      <div class="row-field"><div class="grow"><div class="t">Keep the AI's knowledge up to date</div><div class="d">Re-reads changed notes and documents in the background (uses the GPU briefly).</div></div>
        <input type="checkbox" class="switch" data-aiset="autoIndex" ${s.ai?.autoIndex !== false ? 'checked' : ''}></div>
    </section>

    <section class="panel"><h2>${icon('lock')}Lock</h2>
      <p class="desc">Lock single items from their ⋯ menu, or whole collections in their edit dialog. Locked things stay hidden in Vault until you unlock with Windows Hello: your PIN, fingerprint or face. (A privacy screen inside Vault; the files aren't encrypted.)</p>
      <div class="row-field"><div class="grow"><div class="t">Windows Hello</div><div class="d">${a.lock?.hello === 'Available' ? 'Ready on this PC' : esc(a.lock?.help || a.lock?.hello || 'Checking…')}</div></div>
        ${a.lock?.any ? (a.lock.unlocked ? `<button class="btn sm" data-act="lock-now">${icon('lock')}Lock now</button>` : `<button class="btn sm" data-act="unlock">${icon('unlock')}Unlock</button>`) : ''}</div>
      <div class="row-field"><div class="grow"><div class="t">Lock again after</div><div class="d">Minutes without using anything locked.</div></div>
        <select class="input" data-set="lockMinutes">${[1, 5, 15, 60].map(v => `<option value="${v}" ${(s.lockMinutes || 5) === v ? 'selected' : ''}>${v} minute${v > 1 ? 's' : ''}</option>`).join('')}</select></div>
    </section>

    <section class="panel"><h2>${icon('bookmark')}Save sites from your browser</h2>
      <p class="desc">Drag this button onto your browser's bookmarks bar. On any website, click it and the site is saved to Vault with its title, description and preview picture, so you don't forget good sites.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <a class="bookmarklet" data-bookmarklet href="${esc(bookmarklet(a.port))}" draggable="true">${icon('bookmark')}Save to Vault</a>
        <button class="btn sm" data-act="copy-bm">${icon('copy')}Copy it instead</button>
      </div>
      <div class="hint">Can't see your bookmarks bar? Press Ctrl+Shift+B. Copying: make a new bookmark and paste this as its URL.</div>
    </section>

    <section class="panel"><h2>${icon('monitor')}Windows</h2>
      <div class="row-field"><div class="grow"><div class="t">Start Vault when Windows starts</div><div class="d">Runs quietly in the background (no window), so tracking and automatic backups keep working.</div></div>
        <input type="checkbox" class="switch" data-shortcut="startup" ${a.shortcuts?.startup ? 'checked' : ''}></div>
      <div class="row-field"><div class="grow"><div class="t">Desktop shortcut</div><div class="d">Double-click to open Vault. Starts it if it isn't running.</div></div>
        <input type="checkbox" class="switch" data-shortcut="desktop" ${a.shortcuts?.desktop ? 'checked' : ''}></div>
    </section>

    <section class="panel"><h2>${icon('info')}About</h2>
      <div class="row-field"><div class="grow"><div class="t">DeskVault ${esc(a.version || '')}</div><div class="d">Made by TCPeep. Free software under the GPL-3.0 license; copies must keep this credit.</div></div>
        <a class="btn sm" href="https://github.com/TCPeep/DeskVault" target="_blank" rel="noopener" style="text-decoration:none">${icon('external')}GitHub</a></div>
      <div class="row-field"><div class="grow"><div class="t">Address</div><div class="d mono">http://127.0.0.1:${esc(a.port)}/</div></div><button class="btn sm" data-act="copy-url">${icon('copy')}Copy</button></div>
      <div class="row-field"><div class="grow"><div class="t">Library</div><div class="d">${counts('file')} files · ${counts('folder')} folders · ${counts('link')} links · ${counts('note')} notes · ${S.collections.length} collections</div><div class="d mono">${esc(a.dataDir)}</div></div>
        <button class="btn sm" data-act="open-data">${icon('folder-open')}Open</button></div>
      <div class="row-field"><div class="grow"><div class="t">Stop Vault</div><div class="d">Shuts down the background server. Open it again with the Vault shortcut.</div></div>
        <button class="btn sm" data-act="stop">${icon('power')}Stop</button></div>
    </section>
  </div>`;
}

const bookmarklet = port => `javascript:void(window.open('http://127.0.0.1:${port}/#/save?u='+encodeURIComponent(location.href)+'&t='+encodeURIComponent(document.title)))`;

async function saveSettings(patch) {
  try { S.settings = await post('/api/settings', { patch }); refresh(); }
  catch (e) { ui.toast(e.message, { type: 'error' }); }
}

document.addEventListener('click', async e => {
  const el = onSettings();
  if (!el || !el.contains(e.target)) return;
  const th = e.target.closest('[data-theme]');
  if (th) {
    S.settings.theme = th.dataset.theme;
    ui.$$('[data-theme]', el).forEach(b => b.classList.toggle('on', b === th));
    return saveSettings({ theme: th.dataset.theme });
  }
  if (e.target.closest('[data-bookmarklet]')) { e.preventDefault(); ui.toast('Drag the button to your bookmarks bar, then use it on any website', { type: 'info' }); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  switch (a.dataset.act) {
    case 'copy-bm': return ui.copyText(bookmarklet(S.app.port), 'Bookmark code copied');
    case 'unlock': { const { unlock } = await import('./actions.js'); await unlock(); return renderSettings(document.getElementById('page')); }
    case 'lock-now': { const { lockNow } = await import('./actions.js'); await lockNow(); return renderSettings(document.getElementById('page')); }
    case 'rm-root': {
      const roots = [...S.settings.searchRoots];
      roots.splice(+a.dataset.i, 1);
      await saveSettings({ searchRoots: roots });
      return renderSettings(document.getElementById('page'));
    }
    case 'add-root': {
      const paths = await pickPaths('folder', true, 'Search these folders for moved items');
      if (!paths.length) return;
      await saveSettings({ searchRoots: [...S.settings.searchRoots, ...paths] });
      return renderSettings(document.getElementById('page'));
    }
    case 'reset-roots':
      await saveSettings({ reset: 'searchRoots' });
      return renderSettings(document.getElementById('page'));
    case 'copy-url': return ui.copyText(`http://127.0.0.1:${S.app.port}/`, 'Address copied');
    case 'open-data': return post('/api/open', { path: S.app.dataDir, how: 'folder' }).catch(err => ui.toast(err.message, { type: 'error' }));
    case 'stop':
      if (!await ui.confirm({ title: 'Stop Vault?', message: 'Tracking and automatic backups pause until you open Vault again.', confirmLabel: 'Stop' })) return;
      await post('/api/shutdown').catch(() => {});
      document.getElementById('page').innerHTML = `<div class="empty"><h2>Vault is stopped</h2><p>Open it again with the Vault shortcut (or run <span class="mono">node server.js</span>).</p></div>`;
  }
});

document.addEventListener('change', async e => {
  const el = onSettings();
  if (!el || !el.contains(e.target)) return;
  const t = e.target;
  if (t.dataset.shortcut) {
    try {
      const r = await post('/api/shortcut', { where: t.dataset.shortcut, enabled: t.checked });
      S.app.shortcuts[t.dataset.shortcut] = r.exists;
      ui.toast(t.dataset.shortcut === 'startup' ? (r.exists ? 'Vault will start with Windows' : 'Vault won\'t start with Windows') : (r.exists ? 'Shortcut added to your desktop' : 'Desktop shortcut removed'), { type: 'ok' });
    } catch (err) { t.checked = !t.checked; ui.toast(err.message, { type: 'error' }); }
    return;
  }
  if (t.dataset.aiset) {
    try { await post('/api/ai/settings', { [t.dataset.aiset]: t.checked }); refresh(); } catch (err) { ui.toast(err.message, { type: 'error' }); }
    return;
  }
  const k = t.dataset.set;
  if (!k) return;
  if (k === 'backupExcludes') return saveSettings({ backupExcludes: t.value.split(',') });
  if (k === 'searchOtherDrives') return saveSettings({ searchOtherDrives: t.checked });
  if (k === 'checkIntervalSec') return saveSettings({ checkIntervalSec: +t.value });
  if (k === 'lockMinutes') return saveSettings({ lockMinutes: +t.value });
});

// ---------- activity ----------
const EV = {
  moved: ['arrow-right', 'link'], found: ['check-circle', 'code'], missing: ['alert', 'pdf'], recycled: ['trash', 'archive'],
  offline: ['drive', 'file'], add: ['plus', 'md'], remove: ['x', 'file'], purge: ['trash', 'pdf'], backup: ['backup', 'video'],
  restore: ['history', 'video'], import: ['import', 'md'],
};

export async function renderActivity(page) {
  if (!page.querySelector('#activityPage')) page.innerHTML = `<div id="activityPage"><div class="page-head"><h1>Activity</h1><span class="sub">What Vault has noticed and done</span></div><div class="loading">${icon('loader', 'spin')}</div></div>`;
  let list;
  try { list = await get('/api/activity'); } catch (e) { return; }
  const host = page.querySelector('#activityPage');
  if (!host || parseHash().name !== 'activity') return;
  let day = '';
  const rows = list.map(ev => {
    const d = new Date(ev.at).toDateString();
    const head = d !== day ? `<div class="day">${esc(d === new Date().toDateString() ? 'Today' : ui.fmtDate(ev.at, false))}</div>` : '';
    day = d;
    const [ic, cat] = EV[ev.type] || ['info', 'file'];
    const linked = ev.itemId && itemById(ev.itemId);
    return head + `<div class="ev"><div class="tile c-${cat}">${icon(ic)}</div>
      <div class="msg">${linked ? `<a data-open="${esc(ev.itemId)}">${esc(ev.message)}</a>` : esc(ev.message)}</div>
      <time title="${esc(new Date(ev.at).toLocaleString())}">${esc(new Date(ev.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</time></div>`;
  }).join('');
  host.innerHTML = `<div class="page-head"><h1>Activity</h1><span class="sub">What Vault has noticed and done</span></div>
    ${list.length ? `<div class="timeline">${rows}</div>` : `<div class="empty"><h2>Nothing yet</h2><p>Moves, backups and clean-ups show up here.</p></div>`}`;
}

document.addEventListener('click', e => {
  const a = e.target.closest('#activityPage [data-open]');
  if (a) openItem(a.dataset.open);
});
