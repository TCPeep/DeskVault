// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
import { S, hooks, refresh, parseHash, go, openItem, closeViewer, itemById, collectionById, isUnavailable, save } from './state.js';
import { get, post, connectEvents } from './api.js';
import * as ui from './ui.js';
import * as A from './actions.js';
import { syncViewer, viewerOpen } from './viewer.js';
import { renderBackups, onJob, onBackupsChanged } from './backups.js';
import { renderSettings, renderActivity } from './settings.js';
import { renderStorage, onStorageEvent } from './storage.js';
import { renderReinstall } from './reinstall.js';
import { renderAi, onAiEvent } from './ai.js';
const { esc, icon } = ui;

const page = document.getElementById('page');
const sidebar = document.getElementById('sidebar');
const topbar = document.getElementById('topbar');
let lastPageKey = null;

// ---------- theme ----------
const mql = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const t = S.settings.theme || 'system';
  document.documentElement.dataset.theme = t === 'system' ? (mql.matches ? 'light' : 'dark') : t;
}
mql.addEventListener('change', applyTheme);

// ---------- views ----------
const VIEWS = {
  all: { title: 'All items', icon: 'layers', filter: () => true },
  pinned: { title: 'Pinned', icon: 'pin', filter: i => i.pinned },
  recent: { title: 'Recently opened', icon: 'clock', filter: i => i.lastOpened },
  attention: { title: 'Needs attention', icon: 'alert', filter: i => isUnavailable(i) },
};

function viewItems(r) {
  // Locked collections show a lock screen instead; their hidden items stay out of other views.
  let items = S.items.filter(i => !(i.hidden && collectionById(i.collection)?.locked));
  if (S.query) {
    items = items.filter(i => !i.hidden);
    const terms = S.query.toLowerCase().split(/\s+/).filter(Boolean);
    items = items.filter(i => {
      const hay = [i.name, i.path, i.url, i.description, (i.tags || []).join(' '), collectionById(i.collection)?.name, i.kind === 'note' ? i.body : ''].join(' ').toLowerCase();
      return terms.every(t => hay.includes(t.replace(/^#/, '')));
    });
  } else if (r.name === 'c') items = items.filter(i => r.arg === 'unsorted' ? !collectionById(i.collection) : i.collection === r.arg);
  else if (r.name === 'tag') items = items.filter(i => (i.tags || []).includes(r.arg));
  else if (VIEWS[r.name]) items = items.filter(VIEWS[r.name].filter);
  if (S.kind !== 'all') items = items.filter(i => i.kind === S.kind);
  const by = {
    added: (a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    opened: (a, b) => (b.lastOpened || '').localeCompare(a.lastOpened || ''),
    modified: (a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''),
    kind: (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  }[r.name === 'recent' ? 'opened' : S.sort] || (() => 0);
  return [...items].sort((a, b) => (r.name !== 'recent' && (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || by(a, b));
}

function statusOf(item) {
  if (item.hidden) return { cls: 'muted', icon: 'lock', label: 'Locked' };
  if (S.tracker.searching?.includes(item.id) && item.status === 'missing') return { cls: 'warn', icon: 'loader', label: 'Searching…', spin: true };
  if (item.status === 'missing') return { cls: 'danger', icon: 'alert', label: 'Missing' };
  if (item.status === 'recycled') return { cls: 'warn', icon: 'trash', label: 'In Recycle Bin' };
  if (item.status === 'offline') return { cls: 'muted', icon: 'drive', label: `Drive ${item.offlineDrive || '?'}: not connected` };
  if (item.moved) return { cls: 'info', icon: 'arrow-right', label: 'Moved', title: `Vault followed it from ${item.moved.from}` };
  return null;
}
const badge = s => s ? `<span class="badge ${s.cls}" title="${esc(s.title || '')}">${icon(s.icon, s.spin ? 'spin' : '')}${esc(s.label)}</span>` : '';

function subline(i) {
  if (i.hidden) return 'Unlock with Windows Hello to see it';
  if (i.kind === 'link') {
    const m = i.meta || {};
    const host = (() => { try { return new URL(i.url).hostname.replace(/^www\./, ''); } catch { return i.url; } })();
    if (!m.fetchedAt) return `<span>${esc(host)}</span> <span class="muted">· fetching preview…</span>`;
    return esc([m.siteName && m.siteName.toLowerCase() !== host ? m.siteName : host, i.description || m.description].filter(Boolean).join(' · '));
  }
  if (i.kind === 'note') return esc((i.body || '').replace(/[#*_>`\-\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Empty note');
  if (i.description) return esc(i.description);
  return `<span class="mono" title="${esc(i.path)}">${esc(ui.shortPath(i.path, 90))}</span>`;
}

function metaFor(i) {
  if (i.hidden) return '';
  if (i.kind === 'file') return `${ui.fmtBytes(i.fp?.size)}<br>${esc(ui.timeAgo(i.modifiedAt))}`;
  if (i.kind === 'folder') return `Folder<br>${esc(ui.timeAgo(i.modifiedAt))}`;
  if (i.kind === 'note') return `Note<br>${esc(ui.timeAgo(i.modifiedAt))}`;
  return `Link<br>${esc(ui.timeAgo(i.addedAt))}`;
}

function colChip(i) {
  const c = collectionById(i.collection);
  if (i.hidden && !c) return '';
  return c ? `<span class="chip" title="${esc(c.name)}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>` : '';
}
const tagChips = i => (i.tags || []).map(t => `<span class="chip tag" data-tag="${esc(t)}">${esc(t)}</span>`).join('');

function rowHtml(i) {
  const sel = S.selected.has(i.id);
  return `<div class="row ${sel ? 'selected' : ''} ${isUnavailable(i) ? 'unavailable' : ''}" data-id="${esc(i.id)}" draggable="true">
    <input type="checkbox" class="check" data-act="select" ${sel ? 'checked' : ''} aria-label="Select">
    ${ui.tile(i)}
    <div class="row-main">
      <div class="row-title">${i.pinned ? icon('pin', 'pin') : ''}<span class="name">${esc(i.name)}</span>${badge(statusOf(i))}</div>
      <div class="row-sub">${subline(i)}</div>
      ${i.tags?.length ? `<div class="row-tags">${tagChips(i)}</div>` : ''}
    </div>
    <div class="row-col">${colChip(i)}</div>
    <div class="row-meta">${metaFor(i)}</div>
    <div class="row-actions">
      ${(i.kind === 'file' || i.kind === 'folder') && !i.hidden ? `<button class="icon-btn" data-act="external" title="${i.kind === 'folder' ? 'Open in Explorer' : 'Open with default app'}">${icon('external')}</button>` : ''}
      <button class="icon-btn" data-act="menu" title="More">${icon('more')}</button>
    </div>
  </div>`;
}

function cardHtml(i) {
  const sel = S.selected.has(i.id);
  const cover = i.kind === 'link' && !i.hidden && i.meta?.image;
  return `<div class="card ${sel ? 'selected' : ''} ${isUnavailable(i) ? 'unavailable' : ''}" data-id="${esc(i.id)}" draggable="true">
    ${cover ? `<div class="card-cover"><img src="/thumbs/${encodeURIComponent(cover)}" alt="" loading="lazy"></div>` : ''}
    <div class="card-top">${ui.tile(i, 'lg')}<div class="grow"></div>
      <input type="checkbox" class="check" data-act="select" ${sel ? 'checked' : ''} aria-label="Select">
      <button class="icon-btn" data-act="menu" title="More">${icon('more')}</button></div>
    <div class="card-title">${i.pinned ? icon('pin', 'pin') + ' ' : ''}${esc(i.name)}</div>
    <div class="card-sub">${subline(i)}</div>
    <div class="card-foot">${badge(statusOf(i))}${colChip(i)}${tagChips(i)}</div>
  </div>`;
}

// ---------- sidebar ----------
function renderSidebar() {
  const r = parseHash();
  const count = f => S.items.filter(f).length;
  const att = count(isUnavailable);
  const nav = (name, arg, label, ic, n, extra = '') => {
    const active = !S.query && r.name === name && (r.arg || null) === (arg || null);
    return `<a class="nav ${active ? 'active' : ''}" href="#/${name}${arg ? '/' + encodeURIComponent(arg) : ''}" ${extra}>${ic}<span class="label">${esc(label)}</span>${n != null ? `<span class="count">${n}</span>` : ''}</a>`;
  };
  const tags = {};
  for (const i of S.items) for (const t of i.tags || []) tags[t] = (tags[t] || 0) + 1;
  const topTags = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 24);
  const job = S.jobs.find(j => j.state === 'running');
  sidebar.innerHTML = `
    <div class="brand"><img src="/favicon.svg" alt=""><div>DeskVault<small>${esc(S.app.computer || '')}</small></div></div>
    ${nav('all', null, 'All items', icon('layers'), S.items.length)}
    ${nav('pinned', null, 'Pinned', icon('pin'), count(i => i.pinned) || null, 'data-drop="pin"')}
    ${nav('recent', null, 'Recently opened', icon('clock'), null)}
    ${S.app.ai?.enabled !== false ? nav('ai', null, 'Ask AI', icon('sparkle'), null) : ''}
    ${att ? `<a class="nav ${r.name === 'attention' && !S.query ? 'active' : ''}" href="#/attention">${icon('alert')}<span class="label">Needs attention</span><span class="count alert">${att}</span></a>` : ''}
    <div class="side-head"><span>Collections</span><button class="icon-btn" data-act="new-collection" title="New collection">${icon('plus')}</button></div>
    ${S.collections.map(c => nav('c', c.id, c.name, `<span class="dot" style="background:${esc(c.color)}"></span>`, c.locked && !S.app.lock?.unlocked ? null : count(i => i.collection === c.id), `data-drop="${esc(c.id)}" data-col="${esc(c.id)}"`).replace('</a>', c.locked ? `${icon('lock', 'muted')}</a>` : '</a>')).join('')}
    ${nav('c', 'unsorted', 'Unsorted', icon('inbox'), count(i => !collectionById(i.collection)), 'data-drop=""')}
    ${topTags.length ? `<div class="side-head"><span>Tags</span></div><div class="tag-cloud">${topTags.map(([t]) => `<a class="chip tag" href="#/tag/${encodeURIComponent(t)}" style="${r.name === 'tag' && r.arg === t ? 'border-color:var(--accent);color:var(--text)' : ''}">${esc(t)}</a>`).join('')}</div>` : ''}
    <div class="side-spacer"></div>
    ${job ? `<div class="side-job" data-act="goto-backups"><div style="display:flex;gap:8px;align-items:center">${icon('loader', 'spin')}<span>${esc(job.kind === 'restore' ? 'Restoring' : 'Backing up')}… ${job.bytesTotal ? Math.floor(job.bytesDone / job.bytesTotal * 100) + '%' : ''}</span></div><div class="bar"><div style="width:${job.bytesTotal ? job.bytesDone / job.bytesTotal * 100 : 0}%"></div></div></div>` : ''}
    ${nav('storage', null, 'Storage', icon('pie'), null)}
    ${nav('reinstall', null, 'Reinstall', icon('lifebuoy'), null)}
    ${nav('backups', null, 'Backups', icon('backup'), null)}
    ${nav('activity', null, 'Activity', icon('activity'), null)}
    ${nav('settings', null, 'Settings', icon('settings'), null)}`;
}

sidebar.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a?.dataset.act === 'new-collection') { e.preventDefault(); A.editCollection().then(c => c && go('c', c.id)); return; }
  if (a?.dataset.act === 'goto-backups') { go('backups'); return; }
  if (e.target.closest('a')) {
    sidebar.classList.remove('open');
    if (S.query) {
      S.query = '';
      const si = document.getElementById('q');
      if (si) si.value = '';
      setTimeout(() => { renderSidebar(); renderPage(true); });
    }
  }
});
sidebar.addEventListener('contextmenu', e => {
  const n = e.target.closest('[data-col]');
  if (!n) return;
  e.preventDefault();
  const c = collectionById(n.dataset.col);
  ui.menu({ x: e.clientX, y: e.clientY }, [
    { label: 'Edit collection…', icon: 'edit', onClick: () => A.editCollection(c) },
    { label: 'Move up', icon: 'chevron-right', onClick: () => post('/api/collections', { action: 'move', id: c.id, dir: -1 }).then(refresh) },
    { label: 'Move down', icon: 'chevron-down', onClick: () => post('/api/collections', { action: 'move', id: c.id, dir: 1 }).then(refresh) },
    { label: 'Back up this collection…', icon: 'backup', onClick: () => { S.backupScope = { type: 'collection', id: c.id }; go('backups'); } },
  ]);
});

// drag rows onto collections / Pinned
let dragIds = null;
sidebar.addEventListener('dragover', e => {
  const t = e.target.closest('[data-drop]');
  if (!t || !dragIds) return;
  e.preventDefault();
  ui.$$('.drop-ok', sidebar).forEach(x => x !== t && x.classList.remove('drop-ok'));
  t.classList.add('drop-ok');
});
sidebar.addEventListener('dragleave', e => { e.target.closest('[data-drop]')?.classList.remove('drop-ok'); });
sidebar.addEventListener('drop', e => {
  const t = e.target.closest('[data-drop]');
  ui.$$('.drop-ok', sidebar).forEach(x => x.classList.remove('drop-ok'));
  if (!t || !dragIds) return;
  e.preventDefault();
  if (t.dataset.drop === 'pin') A.setPinned(dragIds, true);
  else A.moveTo(dragIds, t.dataset.drop || null);
});

// ---------- topbar ----------
function renderTopbar() {
  topbar.innerHTML = `
    <button class="icon-btn menu-toggle" data-act="sidebar" aria-label="Menu">${icon('menu')}</button>
    <div class="search">${icon('search')}<input id="q" class="input" placeholder="Search names, paths, tags, notes…" autocomplete="off" spellcheck="false" value="${esc(S.query)}"><kbd>/</kbd></div>
    <div style="flex:1"></div>
    <button class="icon-btn" id="lockBtn" data-act="lock" hidden></button>
    <button class="icon-btn" id="checkBtn" data-act="check" title="Check all locations now">${icon('refresh')}</button>
    <div class="seg" id="viewSeg">
      <button data-view="list" title="List">${icon('list')}</button>
      <button data-view="grid" title="Grid">${icon('grid')}</button>
    </div>
    <button class="btn primary" data-act="add">${icon('plus')}Add</button>`;
  const q = topbar.querySelector('#q');
  const onInput = ui.debounce(() => { S.query = q.value.trim(); S.selected.clear(); renderSidebar(); renderPage(true); }, 120);
  q.addEventListener('input', onInput);
  q.addEventListener('keydown', e => { if (e.key === 'Escape') { q.value = ''; onInput.flush(); q.blur(); } });
  updateTopbar();
}
function updateTopbar() {
  ui.$$('#viewSeg button', topbar).forEach(b => b.classList.toggle('on', b.dataset.view === (S.settings.view || 'list')));
  const lb = topbar.querySelector('#lockBtn');
  if (lb) {
    const L = S.app.lock || {};
    lb.hidden = !L.any;
    lb.classList.toggle('on', !!L.unlocked);
    lb.title = L.unlocked ? 'Unlocked. Click to lock now' : 'Unlock locked items (Windows Hello)';
    lb.innerHTML = icon(L.unlocked ? 'unlock' : 'lock');
  }
  const cb = topbar.querySelector('#checkBtn');
  if (cb) cb.innerHTML = icon('refresh', S.tracker.checking || S.tracker.searching?.length ? 'spin' : '');
}
topbar.addEventListener('click', async e => {
  const b = e.target.closest('[data-act], [data-view]');
  if (!b) return;
  if (b.dataset.view) {
    S.settings.view = b.dataset.view;
    updateTopbar(); renderPage(true);
    post('/api/settings', { patch: { view: b.dataset.view } }).catch(() => {});
    return;
  }
  const act = b.dataset.act;
  if (act === 'add') A.addMenu(b);
  if (act === 'sidebar') sidebar.classList.toggle('open');
  if (act === 'lock') S.app.lock?.unlocked ? A.lockNow() : A.unlock();
  if (act === 'check') {
    S.tracker.checking = true; updateTopbar();
    try { await post('/api/items/check', {}); ui.toast('All locations checked', { type: 'ok', timeout: 2000 }); }
    catch (err) { ui.toast(err.message, { type: 'error' }); }
    refresh();
  }
});

// ---------- pages ----------
function renderPage(force = false) {
  const r = parseHash();
  const key = pageKey(r);
  const keepScroll = key === lastPageKey ? page.scrollTop : 0;
  lastPageKey = key;
  if (!S.query && r.name === 'backups') return renderBackups(page);
  if (!S.query && r.name === 'settings') return renderSettings(page);
  if (!S.query && r.name === 'activity') return renderActivity(page);
  if (!S.query && r.name === 'storage') return renderStorage(page);
  if (!S.query && r.name === 'reinstall') return renderReinstall(page);
  if (!S.query && r.name === 'ai') return renderAi(page);
  if (!S.query && r.name === 'attention') renderAttention(r);
  else renderLibrary(r);
  page.scrollTop = keepScroll;
}

const pageKey = r => S.query ? 'search' : `${r.name}/${r.arg || ''}`;

function headFor(r) {
  if (S.query) return { title: `Search: “${S.query}”`, dot: null };
  if (r.name === 'c') {
    const c = collectionById(r.arg);
    return c ? { title: c.name, dot: c.color, col: c } : { title: 'Unsorted', icon: 'inbox' };
  }
  if (r.name === 'tag') return { title: '#' + r.arg, icon: 'tag' };
  return VIEWS[r.name] || VIEWS.all;
}

function renderLibrary(r) {
  if (!VIEWS[r.name] && !['c', 'tag'].includes(r.name) && !S.query) return go('all');
  const lockedCol = !S.query && r.name === 'c' && collectionById(r.arg)?.locked;
  if (lockedCol && !S.app.lock?.unlocked) {
    const c = collectionById(r.arg);
    page.innerHTML = `<div class="lockscreen"><div class="tile xl c-lock">${icon('lock')}</div><h2>${esc(c.name)} is locked</h2>
      <p>Unlock with your Windows PIN, fingerprint or face to see what's inside.${S.app.lock?.help ? `<br><b>${esc(S.app.lock.help)}</b>` : ''}</p>
      <button class="btn primary" data-act="unlock">${icon('unlock')}Unlock with Windows Hello</button></div>`;
    return;
  }
  const items = viewItems(r);
  const h = headFor(r);
  const view = S.settings.view || 'list';
  const moved = S.items.filter(i => i.moved && i.status === 'ok');
  const sel = [...S.selected].filter(id => itemById(id));
  const showWelcome = !S.items.length;
  page.innerHTML = showWelcome ? welcomeHtml() : `
    <div class="page-head">
      <h1>${h.dot ? `<span class="dot" style="background:${esc(h.dot)}"></span>` : ''}${esc(h.title)}</h1>
      <span class="sub">${items.length} item${items.length === 1 ? '' : 's'}</span>
      ${h.col ? `<button class="icon-btn" data-act="edit-col" title="Edit collection">${icon('edit')}</button>` : ''}
      <div class="grow"></div>
      <div class="seg" id="kindSeg">${['all', 'file', 'folder', 'link', 'note'].map(k => `<button data-kind="${k}" class="${S.kind === k ? 'on' : ''}">${{ all: 'All', file: 'Files', folder: 'Folders', link: 'Links', note: 'Notes' }[k]}</button>`).join('')}</div>
      ${r.name !== 'recent' ? `<select class="input" id="sortSel" style="width:auto;height:32px;font-size:13px;background:var(--panel)">
        ${[['added', 'Recently added'], ['name', 'Name'], ['opened', 'Recently opened'], ['modified', 'Last modified'], ['kind', 'Type']].map(([v, l]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>` : ''}
    </div>
    ${lockedCol ? `<div class="banner">${icon('unlock')}<div class="grow"><b>Unlocked.</b> This collection locks again after ${S.app.lock.minutes} idle minutes.</div><button class="btn sm" data-act="lock-now">${icon('lock')}Lock now</button></div>` : ''}
    ${sel.length ? bulkHtml(sel) : ''}
    ${moved.length && (r.name === 'all' || r.name === 'attention') && !S.query ? `<div class="banner">${icon('sparkle')}<div class="grow">
      <b>${moved.length === 1 ? 'Something moved' : `${moved.length} things moved`}, and Vault followed ${moved.length === 1 ? 'it' : 'them'}.</b>
      <ul>${moved.slice(0, 4).map(i => `<li>${esc(i.name)} <span class="muted">→</span> <span class="mono">${esc(ui.shortPath(i.path, 80))}</span></li>`).join('')}${moved.length > 4 ? `<li class="muted">…and ${moved.length - 4} more</li>` : ''}</ul>
      </div><button class="btn sm" data-act="dismiss-moves">Got it</button></div>` : ''}
    ${items.length ? (view === 'grid' ? `<div class="grid">${items.map(cardHtml).join('')}</div>` : `<div class="list">${items.map(rowHtml).join('')}</div>`) : emptyHtml(r)}`;
}

function bulkHtml(sel) {
  const disk = sel.map(itemById).filter(i => i && (i.kind === 'file' || i.kind === 'folder'));
  return `<div class="bulk"><span class="count">${sel.length} selected</span>
    <button class="btn sm" data-act="bulk-move">${icon('layers')}Move to…</button>
    <button class="btn sm" data-act="bulk-tag">${icon('tag')}Tag</button>
    <button class="btn sm" data-act="bulk-pin">${icon('pin')}Pin</button>
    ${disk.length ? `<button class="btn sm" data-act="bulk-backup">${icon('backup')}Back up</button>` : ''}
    <div class="grow"></div>
    <button class="btn sm" data-act="bulk-remove">${icon('x')}Remove from Vault</button>
    ${disk.length ? `<button class="btn sm" data-act="bulk-trash" style="color:var(--danger)">${icon('trash')}Delete files…</button>` : ''}
    <button class="icon-btn" data-act="bulk-clear" title="Clear selection">${icon('x')}</button></div>`;
}

function welcomeHtml() {
  return `<div class="empty hero">
    <div class="tile xl c-folder" style="background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff">${icon('shield')}</div>
    <h2>Welcome to your Vault</h2>
    <p>Keep everything that matters in one place: project folders, documents, links and notes. Your files stay where they are; Vault keeps track of them.</p>
    <div class="actions">
      <button class="btn primary" data-act="add-folder">${icon('folder-plus')}Add folders</button>
      <button class="btn" data-act="add-files">${icon('file-plus')}Add files</button>
      <button class="btn" data-act="add-paste">${icon('clipboard')}Paste a path</button>
    </div>
    <div class="feature-row">
      <div class="feature"><b>${icon('locate')}Follows your files</b>Move or rename something and Vault finds it again, even across drives.</div>
      <div class="feature"><b>${icon('eye')}Built-in viewer</b>Code, text, Markdown, PDFs, images and video open right here.</div>
      <div class="feature"><b>${icon('backup')}Back up anywhere</b>Copy everything to another drive in one click, as snapshots or a fast mirror.</div>
      <div class="feature"><b>${icon('trash')}Clean up safely</b>Remove from Vault, or send files to the Recycle Bin. Nothing is lost by accident.</div>
    </div>
  </div>`;
}

function emptyHtml(r) {
  if (S.query) return `<div class="empty">${ui.tile('x', 'xl')}<h2>No matches</h2><p>Nothing in your Vault matches “${esc(S.query)}”.</p></div>`;
  if (S.kind !== 'all') return `<div class="empty"><h2>No ${S.kind}s here</h2><p><button class="btn" data-kind-reset>Show everything</button></p></div>`;
  const msgs = {
    pinned: ['Nothing pinned yet', 'Pin the things you open all the time and they stay at the top. Use the ⋯ menu, or drag an item onto “Pinned”.'],
    recent: ['Nothing opened yet', 'Items you open from Vault show up here.'],
    attention: ['All good', 'Every file and folder is where Vault expects it.'],
    tag: ['No items with this tag', ''],
  };
  const [t, p] = msgs[r.name] || ['This collection is empty', 'Add files or folders while viewing it, or drag items onto it in the sidebar.'];
  return `<div class="empty"><div class="tile xl c-${r.name === 'attention' ? 'code' : 'folder'}">${icon(r.name === 'attention' ? 'check-circle' : r.name === 'pinned' ? 'pin' : 'inbox')}</div><h2>${esc(t)}</h2><p>${esc(p)}</p>
    ${r.name === 'c' ? `<div class="actions"><button class="btn primary" data-act="add-folder">${icon('folder-plus')}Add folders</button><button class="btn" data-act="add-files">${icon('file-plus')}Add files</button></div>` : ''}</div>`;
}

function renderAttention() {
  const items = S.items.filter(isUnavailable);
  if (!items.length) { page.innerHTML = `<div class="page-head"><h1>Needs attention</h1></div>${emptyHtml({ name: 'attention' })}`; return; }
  page.innerHTML = `<div class="page-head"><h1>Needs attention</h1><span class="sub">${items.length} item${items.length > 1 ? 's' : ''}</span><div class="grow"></div>
    <button class="btn" data-act="search-all">${icon('refresh')}Search again for all</button></div>
    <div class="att">${items.map(i => {
      const s = statusOf(i);
      const searching = S.tracker.searching?.includes(i.id);
      const why = {
        missing: `Vault last saw it at <span class="mono">${esc(i.path)}</span>${i.lastSeen ? ` ${esc(ui.timeAgo(i.lastSeen))}` : ''}. It wasn't moved to anywhere Vault can follow (it may have been deleted or copied somewhere new). ${searching ? 'Searching your drives now…' : i.lastSearched ? `Searched ${esc(ui.timeAgo(i.lastSearched))}.` : ''}`,
        recycled: `It's in the Recycle Bin. Restore it from there and Vault picks it straight back up.`,
        offline: `It lives on drive <b>${esc(i.offlineDrive)}:</b>, which isn't connected right now. Plug the drive back in and it shows up again, even if the drive gets a different letter. <span class="mono">${esc(i.path)}</span>`,
      }[i.status];
      return `<div class="att-card" data-id="${esc(i.id)}">${ui.tile(i, 'lg')}<div>
        <h3>${esc(i.name)} ${badge(s)}</h3><p>${why}</p>
        ${i.suggestions?.length ? `<div class="suggest"><div class="head">Possible matches (same name, but the contents changed):</div>${i.suggestions.map(p => `<div class="s"><span class="mono" title="${esc(p)}">${esc(p)}</span><button class="btn sm" data-act="use-suggestion" data-path="${esc(p)}">This is it</button></div>`).join('')}</div>` : ''}
        <div class="actions">
          ${i.status === 'missing' ? `<button class="btn sm" data-act="search-one">${icon('refresh')}Search again</button>` : ''}
          ${i.status === 'recycled' ? `<button class="btn sm" data-act="recycle-bin">${icon('bin')}Open Recycle Bin</button>` : ''}
          <button class="btn sm" data-act="relink">${icon('locate')}Locate it myself…</button>
          <button class="btn sm" data-act="restore">${icon('history')}Restore from backup…</button>
          <button class="btn sm ghost" data-act="remove-one">${icon('x')}Remove from Vault</button>
        </div></div></div>`;
    }).join('')}</div>`;
}

// ---------- page interactions ----------
page.addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('[data-kind]')) { S.kind = t.closest('[data-kind]').dataset.kind; renderPage(true); return; }
  if (t.closest('[data-kind-reset]')) { S.kind = 'all'; renderPage(true); return; }
  const tagEl = t.closest('[data-tag]');
  if (tagEl) {
    e.stopPropagation();
    if (S.query) { S.query = ''; document.getElementById('q').value = ''; }
    go('tag', tagEl.dataset.tag);
    return;
  }
  const actEl = t.closest('[data-act]');
  const holder = t.closest('[data-id]');
  const item = holder ? itemById(holder.dataset.id) : null;
  const act = actEl?.dataset.act;
  switch (act) {
    case 'add-folder': return A.addFlow('folder');
    case 'add-files': return A.addFlow('files');
    case 'add-paste': return A.addFlow('paste');
    case 'unlock': return A.unlock();
    case 'lock-now': return A.lockNow();
    case 'edit-col': return A.editCollection(collectionById(parseHash().arg));
    case 'dismiss-moves': {
      const moved = S.items.filter(i => i.moved);
      await Promise.all(moved.map(i => post('/api/items/update', { id: i.id, patch: { dismissMove: true } })));
      return refresh();
    }
    case 'search-all': return A.searchAgain(S.items.filter(isUnavailable).map(i => i.id));
    case 'bulk-move': return ui.menu(actEl, A.moveMenu([...S.selected]));
    case 'bulk-tag': return A.addTags([...S.selected]);
    case 'bulk-pin': return A.setPinned([...S.selected], true);
    case 'bulk-backup': S.backupScope = { type: 'items', ids: [...S.selected] }; return go('backups');
    case 'bulk-remove': return A.removeItems([...S.selected]);
    case 'bulk-trash': return A.trashItems([...S.selected]);
    case 'bulk-clear': S.selected.clear(); return renderPage();
  }
  if (!item) return;
  switch (act) {
    case 'select': {
      if (e.shiftKey && lastClicked) selectRange(lastClicked, item.id);
      else if (t.checked) S.selected.add(item.id); else S.selected.delete(item.id);
      lastClicked = item.id;
      return renderPage();
    }
    case 'menu': return ui.menu(actEl, A.itemMenu(item), { align: 'right' });
    case 'external': return A.openWith(item, 'default');
    case 'search-one': return A.searchAgain([item.id]);
    case 'relink': return A.relink(item);
    case 'restore': return A.restoreFromBackup(item);
    case 'remove-one': return A.removeItems([item.id]);
    case 'use-suggestion': return A.useSuggestion(item, actEl.dataset.path);
    case 'recycle-bin': return post('/api/open', { how: 'recyclebin' }).catch(err => ui.toast(err.message, { type: 'error' }));
  }
  if (holder.classList.contains('row') || holder.classList.contains('card')) {
    if (item.hidden && !act) return A.unlock();
    if (e.ctrlKey || e.metaKey) { S.selected.has(item.id) ? S.selected.delete(item.id) : S.selected.add(item.id); lastClicked = item.id; return renderPage(); }
    if (e.shiftKey && lastClicked) { selectRange(lastClicked, item.id); return renderPage(); }
    A.activate(item);
  }
});
let lastClicked = null;
function selectRange(a, b) {
  const ids = ui.$$('[data-id]', page).map(x => x.dataset.id);
  const [i, j] = [ids.indexOf(a), ids.indexOf(b)].sort((x, y) => x - y);
  if (i < 0) return;
  for (const id of ids.slice(i, j + 1)) S.selected.add(id);
}
page.addEventListener('change', e => {
  if (e.target.id === 'sortSel') { S.sort = e.target.value; save('sort', S.sort); renderPage(true); }
});
page.addEventListener('contextmenu', e => {
  const holder = e.target.closest('.row[data-id], .card[data-id]');
  if (!holder) return;
  e.preventDefault();
  ui.menu({ x: e.clientX, y: e.clientY }, A.itemMenu(itemById(holder.dataset.id)));
});
page.addEventListener('dblclick', e => {
  const holder = e.target.closest('.row[data-id], .card[data-id]');
  const item = holder && itemById(holder.dataset.id);
  if (item && (item.kind === 'file' || item.kind === 'folder') && !isUnavailable(item) && !e.target.closest('[data-act]')) { closeViewer(); A.openWith(item, 'default'); }
});
page.addEventListener('dragstart', e => {
  const holder = e.target.closest('[data-id][draggable]');
  if (!holder) return;
  const id = holder.dataset.id;
  dragIds = S.selected.has(id) ? [...S.selected] : [id];
  e.dataTransfer.setData('text/x-vault-ids', JSON.stringify(dragIds));
  e.dataTransfer.effectAllowed = 'move';
  holder.classList.add('dragging');
});
page.addEventListener('dragend', e => { e.target.closest?.('[data-id]')?.classList.remove('dragging'); dragIds = null; });

// ---------- global keys, paste, file drops ----------
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (e.key === '/' && !typing && !ui.isModalOpen()) { e.preventDefault(); const q = document.getElementById('q'); if (viewerOpen()) closeViewer(); q?.focus(); q?.select(); }
  if (e.key === 'Escape' && !typing && !ui.isModalOpen() && !viewerOpen() && S.selected.size) { S.selected.clear(); renderPage(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !typing && !viewerOpen() && !ui.isModalOpen()) {
    const ids = ui.$$('.row[data-id], .card[data-id]', page).map(x => x.dataset.id);
    if (ids.length) { e.preventDefault(); ids.forEach(id => S.selected.add(id)); renderPage(); }
  }
  if (e.key === 'Delete' && !typing && !viewerOpen() && !ui.isModalOpen() && S.selected.size) A.removeItems([...S.selected]);
});

document.addEventListener('paste', e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if (typing || ui.isModalOpen()) return;
  const text = e.clipboardData.getData('text');
  const paths = text.split(/\r?\n/).map(s => s.trim().replace(/^"|"$/g, '')).filter(s => /^([a-z]:\\|\\\\)/i.test(s));
  if (paths.length) { e.preventDefault(); A.addFlow('paste', paths); }
});

let dropEl = null;
document.addEventListener('dragover', e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  if (!dropEl) {
    dropEl = document.createElement('div');
    dropEl.className = 'dropzone';
    dropEl.innerHTML = `<div><b>Browsers keep file locations private</b>So Vault can't see where dropped files live. Use <b style="display:inline">Add ▸ Files / Folders</b>, or copy the path in Explorer (<kbd>Shift</kbd> + right-click ▸ <i>Copy as path</i>) and press <kbd>Ctrl</kbd>+<kbd>V</kbd> here.</div>`;
    document.body.appendChild(dropEl);
  }
  clearTimeout(dropEl._t);
  dropEl._t = setTimeout(() => { dropEl?.remove(); dropEl = null; }, 150);
});
document.addEventListener('drop', e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dropEl?.remove(); dropEl = null;
  ui.toast('Dropped files can\'t be added (browsers hide where they live). Use Add ▸ Files / Folders, or paste a copied path with Ctrl+V.', { type: 'info', timeout: 9000 });
});

// ---------- render loop ----------
hooks.render = () => {
  applyTheme();
  renderSidebar();
  updateTopbar();
  const r = parseHash();
  // Backups/Settings hold form state and update themselves; only build them on navigation.
  if (!['backups', 'settings', 'ai'].includes(r.name) || S.query || pageKey(r) !== lastPageKey) renderPage();
  syncViewer(r);
};

// Bookmark button ("Save to Vault"): #/save?u=<url>&t=<title>
function handleSaveRoute() {
  if (!location.hash.startsWith('#/save')) return false;
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  history.replaceState(null, '', '#/all');
  A.addLink({ url: q.get('u') || '', name: q.get('t') || '' });
  return true;
}

addEventListener('hashchange', () => {
  if (handleSaveRoute()) { renderSidebar(); renderPage(); return; }
  const r = parseHash();
  if (pageKey(r) !== lastPageKey) { renderSidebar(); renderPage(); }
  syncViewer(r);
});

// live updates from the server
connectEvents({
  items: () => refresh(),
  settings: () => refresh(),
  moved: d => {
    ui.toast(`${d.name} moved. Vault followed it to ${d.to}`, { type: 'info', timeout: 7000 });
  },
  search: d => { S.tracker.searching = d.ids || []; updateTopbar(); if (!d.active) refresh(); else { renderSidebar(); renderPage(); } },
  job: j => {
    const i = S.jobs.findIndex(x => x.id === j.id);
    if (i >= 0) S.jobs[i] = j; else S.jobs.unshift(j);
    renderSidebar();
    onJob(j);
    if (j.state !== 'running' && j.phase === 'done') {
      const what = j.kind === 'restore' ? `Restore of ${j.itemName}` : 'Backup';
      if (j.state === 'complete') ui.toast(`${what} finished`, { type: 'ok' });
      else if (j.state === 'errors') ui.toast(`${what} finished with ${j.errorCount} problem${j.errorCount > 1 ? 's' : ''}`, { type: 'warn', timeout: 8000, action: () => go('backups'), actionLabel: 'Details' });
      else if (j.state === 'failed') ui.toast(`${what} failed: ${j.message}`, { type: 'error', timeout: 10000 });
      else if (j.state === 'cancelled') ui.toast(`${what} cancelled`, { type: 'info' });
    }
  },
  backups: () => onBackupsChanged(),
  storage: d => onStorageEvent('progress', d),
  'storage-done': () => onStorageEvent('done'),
  ai: d => onAiEvent(d),
}, connected => {
  document.title = connected ? 'DeskVault' : 'DeskVault (offline)';
  if (connected && S.loaded) refresh();
});

// ---------- boot ----------
renderTopbar();
refresh().then(() => { if (handleSaveRoute()) renderPage(); }).catch(e => {
  page.innerHTML = `<div class="empty"><h2>Can't reach the Vault server</h2><p>${esc(e.message)}</p><p>Start it with <b>Vault.exe</b> or <span class="mono">node server.js</span>.</p></div>`;
});
setInterval(() => { if (S.loaded && !document.hidden) { renderSidebar(); } }, 60000);
