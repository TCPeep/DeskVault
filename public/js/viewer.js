// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// The in-app viewer: folder tree + code/text, Markdown, PDF, images, audio/video, HTML, notes.
import { S, itemById, closeViewer, openItem, isUnavailable, load, save, parseHash } from './state.js';
import { get, post } from './api.js';
import * as ui from './ui.js';
import * as A from './actions.js';
const { esc, icon } = ui;

const root = document.getElementById('viewer');
const V = {
  id: null, rel: null, statusKey: null, info: null, token: 0,
  tree: new Map(), open: new Set(),
  wrap: load('wrap', '0') === '1', mdMode: 'rendered', htmlMode: 'source', note: null,
};

export const viewerOpen = () => !root.hidden;

const statusKey = it => `${it.status}|${it.path}|${it.hidden ? 1 : 0}|${it.meta?.fetchedAt || ''}`;
const enc = s => encodeURIComponent(s);
const dirOf = rel => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';

export function syncViewer(r) {
  if (!r.view) return hide();
  if (!S.loaded) return;
  const item = itemById(r.view);
  if (!item) return hide();
  if (root.hidden || V.id !== item.id) show(item);
  const rel = item.kind === 'folder' ? (r.rel || '') : '';
  const key = statusKey(item);
  // Became available/unavailable or moved while open: rebuild (the tree pane comes and goes).
  if (V.statusKey && V.statusKey !== key) show(item);
  if (V.rel !== rel || V.statusKey !== key) {
    V.rel = rel;
    V.statusKey = key;
    renderContent(item, rel);
  }
  renderHead(item);
}

function show(item) {
  flushNote();
  V.id = item.id; V.rel = null; V.statusKey = null; V.info = null;
  V.tree.clear(); V.open.clear();
  V.mdMode = 'rendered'; V.htmlMode = 'source';
  root.hidden = false;
  root.innerHTML = `<div class="vpanel" role="dialog" aria-modal="true">
    <header class="vhead"></header>
    <div class="vbody ${item.kind === 'folder' && !isUnavailable(item) && !item.hidden ? '' : 'single'}">
      ${item.kind === 'folder' && !isUnavailable(item) && !item.hidden ? '<nav class="tree" aria-label="Files"></nav>' : ''}
      <section class="vcontent"></section>
    </div></div>`;
}

function hide() {
  if (root.hidden) return;
  flushNote();
  root.hidden = true;
  root.innerHTML = '';
  V.id = null; V.rel = null;
}

function flushNote() {
  if (V.note?.dirty) V.note.save.flush();
  V.note = null;
}

// ---------- header ----------
function badge(item) {
  const m = { missing: ['danger', 'alert', 'Missing'], recycled: ['warn', 'trash', 'In Recycle Bin'], offline: ['muted', 'drive', 'Drive offline'] }[item.status];
  return m ? `<span class="badge ${m[0]}">${icon(m[1])}${m[2]}</span>` : '';
}

function currentPath(item) {
  if (item.kind !== 'folder' || !V.rel) return item.path;
  return item.path + '\\' + V.rel.replace(/\//g, '\\');
}

function renderHead(item) {
  const head = root.querySelector('.vhead');
  if (!head) return;
  const disk = (item.kind === 'file' || item.kind === 'folder') && !item.hidden;
  const ok = !isUnavailable(item);
  let crumbs;
  if (item.hidden) crumbs = '<span>Locked</span>';
  else if (item.kind === 'folder' && V.rel) {
    const parts = V.rel.split('/');
    crumbs = `<button data-crumb="">${esc(item.name)}</button>` + parts.map((p, i) => `${icon('chevron-right')}<button data-crumb="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('');
  } else if (disk) crumbs = `<span class="path" data-act="copy-path" title="Click to copy">${esc(item.path)}</span>`;
  else if (item.kind === 'link') crumbs = `<span class="path">${esc(item.url)}</span>`;
  else crumbs = `<span>Note · edited ${esc(ui.timeAgo(item.modifiedAt))}</span>`;
  const texty = ['code', 'text', 'md'].includes(ui.categoryOf(item).cat);
  head.innerHTML = `${ui.tile(item)}
    <div class="titles"><div class="name"><span>${esc(item.name)}</span>${badge(item)}</div><div class="crumbs">${crumbs}</div></div>
    <div class="acts">
      ${disk && ok ? `<button class="btn sm" data-act="open-default" title="${item.kind === 'folder' ? 'Open in Explorer' : 'Open with its usual app'}">${icon('external')}${item.kind === 'folder' ? 'Explorer' : 'Open'}</button>` : ''}
      ${item.kind === 'link' ? `<button class="btn sm" data-act="open-link">${icon('external')}Open link</button>` : ''}
      ${disk && ok ? `<button class="icon-btn hide-sm" data-act="reveal" title="Show in folder">${icon('folder-open')}</button>` : ''}
      ${disk && ok && S.app.vscode && (item.kind === 'folder' || texty) ? `<button class="icon-btn hide-sm" data-act="vscode" title="Open in VS Code">${icon('code')}</button>` : ''}
      ${disk && ok && S.app.terminal && item.kind === 'folder' ? `<button class="icon-btn hide-sm" data-act="terminal" title="Open terminal here">${icon('terminal')}</button>` : ''}
      ${disk ? `<button class="icon-btn hide-sm" data-act="copy-path" title="Copy path">${icon('copy')}</button>` : ''}
      <button class="icon-btn" data-act="menu" title="More">${icon('more')}</button>
      <span class="sep"></span>
      <button class="icon-btn" data-act="close" title="Close (Esc)">${icon('x')}</button>
    </div>`;
}

// ---------- content ----------
const loadingHtml = `<div class="loading">${icon('loader', 'spin')}Loading…</div>`;

function fileUrl(item, rel) {
  const path = rel ? rel.split('/').filter(Boolean).map(enc).join('/') : enc(ui.basename(item.path));
  return `/f/${enc(item.id)}/${path}`;
}

async function renderContent(item, rel) {
  const box = root.querySelector('.vcontent');
  if (!box) return;
  const token = ++V.token;
  flushNote();
  if (item.hidden) return renderLocked(item, box);
  if (item.kind === 'note') return renderNote(item, box);
  if (item.kind === 'link') return renderLink(item, box);
  if (isUnavailable(item)) return renderUnavailable(item, box);
  box.innerHTML = loadingHtml;
  let info;
  try { info = await get(`/api/items/${enc(item.id)}/view?rel=${enc(rel)}`); }
  catch (e) {
    if (token !== V.token) return;
    box.innerHTML = `<div class="info-card">${ui.tile('x', 'xl')}<h3>Couldn't open this</h3><p>${esc(e.message)}</p>
      <div class="actions"><button class="btn" data-act="retry">${icon('refresh')}Try again</button></div></div>`;
    if (item.kind === 'folder') renderTree(item);
    return;
  }
  if (token !== V.token) return;
  V.info = info;
  if (item.kind === 'folder') renderTree(item);
  if (info.kind === 'folder') return renderFolder(item, rel, box, token);
  box.innerHTML = toolHtml(item, info) + '<div class="vdoc"></div>';
  renderDoc(item, rel, info);
}

function toolHtml(item, info) {
  const textLike = ['text', 'markdown', 'html'].includes(info.kind);
  const seg = (modes, cur) => `<div class="seg">${modes.map(([v, l, ic]) => `<button data-act="mode" data-mode="${v}" class="${cur === v ? 'on' : ''}">${ic ? icon(ic) : ''}${l}</button>`).join('')}</div>`;
  const modes = info.kind === 'markdown' ? seg([['rendered', 'Rendered', 'book'], ['source', 'Source', 'code']], V.mdMode)
    : info.kind === 'html' ? seg([['source', 'Source', 'code'], ['preview', 'Preview', 'eye']], V.htmlMode) : '';
  const inFolder = item.kind === 'folder';
  return `<div class="vtool">
    <div class="file">${ui.ficon(info.name)}<b>${esc(info.name)}</b><span class="meta">${ui.fmtBytes(info.size)} · ${esc(ui.fmtDate(info.mtime))}${info.encoding && info.encoding !== 'utf-8' ? ' · ' + esc(info.encoding) : ''}</span></div>
    <div class="acts">${modes}
      ${textLike && S.app.ai?.enabled !== false ? `<button class="btn sm ghost" data-act="ai-summarize" title="Uses the AI on this PC">${icon('sparkle')}${isCodeInfo(info) ? 'Explain' : 'Summarize'}</button>` : ''}
      ${textLike ? `<button class="icon-btn ${V.wrap ? 'on' : ''}" data-act="wrap" title="Wrap long lines">${icon('wrap')}</button>
        <button class="icon-btn" data-act="copy-text" title="Copy contents">${icon('copy')}</button>` : ''}
      ${inFolder ? `<span class="sep" style="width:1px;height:20px;background:var(--line);margin:0 4px"></span>
        ${S.app.vscode && textLike ? `<button class="icon-btn" data-act="file-vscode" title="Open this file in VS Code">${icon('code')}</button>` : ''}
        <button class="icon-btn" data-act="file-open" title="Open with its usual app">${icon('external')}</button>
        <button class="icon-btn" data-act="file-reveal" title="Show in folder">${icon('folder-open')}</button>` : ''}
    </div></div>`;
}

const isCodeInfo = info => info.kind === 'text' && info.lang && !['plaintext', 'markdown'].includes(info.lang);

function renderDoc(item, rel, info) {
  const doc = root.querySelector('.vdoc');
  if (!doc) return;
  const url = fileUrl(item, rel);
  const trunc = info.truncated ? `<div class="notice">This file is ${ui.fmtBytes(info.size)}. Showing the first part only. Open it in an editor to see everything.</div>` : '';
  doc.classList.remove('center');
  switch (info.kind) {
    case 'markdown':
      if (V.mdMode === 'source') { doc.innerHTML = trunc + codeHtml(info.text, 'markdown'); break; }
      doc.innerHTML = trunc + `<article class="md">${mdHtml(info.text)}</article>`;
      mountMd(doc.querySelector('.md'), item, rel);
      break;
    case 'text':
      doc.innerHTML = trunc + codeHtml(info.text, info.lang);
      break;
    case 'html':
      doc.innerHTML = V.htmlMode === 'preview'
        ? `<iframe class="html-frame" sandbox="allow-same-origin" src="${url}" title="${esc(info.name)}"></iframe>`
        : trunc + codeHtml(info.text, 'xml');
      break;
    case 'pdf':
      doc.innerHTML = `<iframe class="pdf-frame" src="${url}" title="${esc(info.name)}"></iframe>`;
      break;
    case 'image':
      doc.innerHTML = `<div class="img-stage"><img src="${url}" alt="${esc(info.name)}" title="Click to toggle actual size"></div>`;
      break;
    case 'audio':
      doc.innerHTML = `<div class="media-stage"><div style="text-align:center">${ui.tile(info.name, 'xl')}<h3>${esc(info.name)}</h3><audio controls preload="metadata" src="${url}"></audio></div></div>`;
      break;
    case 'video':
      doc.innerHTML = `<div class="media-stage"><video controls preload="metadata" src="${url}"></video></div>`;
      break;
    default:
      doc.innerHTML = `<div class="info-card">${ui.tile(info.name, 'xl')}<h3>${esc(info.name)}</h3>
        <p>Vault can't preview this kind of file, but you can open it in its usual app.</p>
        <dl><dt>Size</dt><dd>${ui.fmtBytes(info.size)}</dd><dt>Modified</dt><dd>${esc(ui.fmtDate(info.mtime))}</dd>
          ${info.ctime ? `<dt>Created</dt><dd>${esc(ui.fmtDate(info.ctime))}</dd>` : ''}<dt>Location</dt><dd class="mono">${esc(info.path)}</dd></dl>
        <div class="actions"><button class="btn primary" data-act="file-open">${icon('external')}Open</button><button class="btn" data-act="file-reveal">${icon('folder-open')}Show in folder</button></div></div>`;
  }
}

function codeHtml(text, lang) {
  let body = null;
  const hljs = window.hljs;
  if (hljs && lang && lang !== 'plaintext' && text.length < 600000 && hljs.getLanguage(lang)) {
    try { body = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch {}
  }
  body ??= esc(text);
  let lines = text.split('\n').length;
  if (text.endsWith('\n')) lines--;
  const gutter = Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n');
  return `<div class="code ${V.wrap ? 'wrap' : ''}"><pre class="gutter" aria-hidden="true">${gutter}</pre><pre class="src"><code>${body}</code></pre></div>`;
}

// ---------- markdown ----------
function mdHtml(text) {
  if (!window.marked || !window.DOMPurify) return `<pre>${esc(text)}</pre>`;
  return window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true }), { ADD_ATTR: ['target'] });
}

function resolveRel(base, href) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('\\')) return null;
  let decoded = href;
  try { decoded = decodeURI(href); } catch {}
  const parts = base ? base.split('/') : [];
  for (const seg of decoded.split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}

function mountMd(el, item, mdRel) {
  const base = item.kind === 'folder' ? dirOf(mdRel) : '';
  const canAssets = item.kind === 'folder' || item.kind === 'file';
  for (const img of el.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (!src || /^(https?:|data:)/i.test(src)) continue;
    const rel = canAssets ? resolveRel(base, src) : null;
    if (rel != null) img.src = fileUrl(item, rel); else img.removeAttribute('src');
  }
  for (const a of el.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; continue; }
    if (href.startsWith('#')) { a.dataset.anchor = href.slice(1); continue; }
    const rel = item.kind === 'folder' ? resolveRel(base, href.split('#')[0]) : null;
    if (rel != null) a.dataset.rel = rel;
    else a.removeAttribute('href');
  }
  const used = new Set();
  for (const h of el.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    let slug = h.textContent.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
    while (used.has(slug)) slug += '-1';
    used.add(slug);
    h.id = slug;
  }
  if (window.hljs) for (const code of el.querySelectorAll('pre code[class*="language-"]')) {
    const lang = /language-([\w+-]+)/.exec(code.className)?.[1];
    if (lang && window.hljs.getLanguage(lang)) { try { window.hljs.highlightElement(code); } catch {} }
  }
}

// ---------- folders ----------
async function loadDir(item, rel) {
  if (!V.tree.has(rel)) V.tree.set(rel, await get(`/api/items/${enc(item.id)}/list?rel=${enc(rel)}`));
  return V.tree.get(rel);
}

async function renderFolder(item, rel, box, token) {
  let list;
  try { list = await loadDir(item, rel); } catch (e) { box.innerHTML = `<div class="info-card"><h3>Couldn't read this folder</h3><p>${esc(e.message)}</p></div>`; return; }
  if (token !== V.token) return;
  const files = list.entries.filter(e => !e.dir).length, dirs = list.entries.length - files;
  const readme = list.entries.find(e => !e.dir && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
  const child = n => (rel ? rel + '/' : '') + n;
  box.innerHTML = `<div class="vtool"><div class="file">${icon('folder-open')}<b>${esc(rel ? ui.basename(rel) : item.name)}</b>
      <span class="meta">${dirs} folder${dirs === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}${!rel && item.folderStats ? ` · ${ui.fmtBytes(item.folderStats.bytes)} total` : ''}</span></div>
      <div class="acts">
        ${!rel ? `<button class="btn sm ghost" data-act="folder-size">${icon('drive')}${item.folderStats ? 'Recount size' : 'Total size'}</button>` : ''}
        ${S.app.terminal ? `<button class="icon-btn" data-act="dir-terminal" title="Open terminal here">${icon('terminal')}</button>` : ''}
        <button class="icon-btn" data-act="file-open" title="Open in Explorer">${icon('external')}</button>
      </div></div>
    <div class="vdoc">
      ${list.entries.length ? `<table class="ftable"><tbody>
        ${rel ? `<tr data-rel="${esc(dirOf(rel))}"><td><div class="nm">${icon('chevron-right', 'ficon')}<span class="muted">..</span></div></td><td class="sz"></td><td class="dt"></td></tr>` : ''}
        ${list.entries.map(e => `<tr data-rel="${esc(child(e.name))}"><td><div class="nm">${ui.ficon(e.name, e.dir)}${esc(e.name)}</div></td>
          <td class="sz">${e.dir ? '' : ui.fmtBytes(e.size)}</td><td class="dt">${e.mtime ? esc(ui.fmtDate(e.mtime)) : ''}</td></tr>`).join('')}
      </tbody></table>${list.truncated ? '<div class="notice">Only the first 5000 entries are shown.</div>' : ''}`
      : `<div class="info-card"><p>This folder is empty.</p></div>`}
      ${readme ? `<div class="readme"><div class="readme-head">${icon('book')}${esc(readme.name)}</div><div class="readme-body">${loadingHtml}</div></div>` : ''}
    </div>`;
  if (readme) {
    try {
      const r = await get(`/api/items/${enc(item.id)}/view?rel=${enc(child(readme.name))}`);
      if (token !== V.token) return;
      const body = box.querySelector('.readme-body');
      if (r.kind === 'markdown') { body.innerHTML = `<article class="md">${mdHtml(r.text)}</article>`; mountMd(body.firstChild, item, child(readme.name)); }
      else body.innerHTML = codeHtml(r.text, 'plaintext');
    } catch { box.querySelector('.readme')?.remove(); }
  }
}

async function renderTree(item) {
  const nav = root.querySelector('.tree');
  if (!nav || V.id !== item.id) return;
  const parts = (V.rel || '').split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    if (i < parts.length || V.info?.kind === 'folder') V.open.add(p);
  }
  const out = [`<div class="tn root ${!V.rel ? 'sel' : ''}" data-rel="" data-dir="1">${icon('folder', 'tw')}<span class="tn-name">${esc(item.name)}</span></div>`];
  const build = async (rel, depth) => {
    let d;
    try { d = await loadDir(item, rel); } catch { return; }
    for (const e of d.entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      const open = e.dir && V.open.has(r);
      const dim = e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__';
      out.push(`<div class="tn ${V.rel === r ? 'sel' : ''} ${dim ? 'dim' : ''}" data-rel="${esc(r)}" data-dir="${e.dir ? 1 : 0}" style="--d:${depth}" title="${esc(e.name)}">${e.dir ? icon(open ? 'chevron-down' : 'chevron-right', 'tw toggle') : '<span class="tw"></span>'}${ui.ficon(e.name, e.dir)}<span class="tn-name">${esc(e.name)}</span></div>`);
      if (open) await build(r, depth + 1);
    }
  };
  await build('', 1);
  if (V.id !== item.id) return;
  const scroll = nav.scrollTop;
  nav.innerHTML = out.join('');
  nav.scrollTop = scroll;
  const sel = nav.querySelector('.tn.sel');
  if (sel) {
    const nr = nav.getBoundingClientRect(), sr = sel.getBoundingClientRect();
    if (sr.top < nr.top || sr.bottom > nr.bottom) sel.scrollIntoView({ block: 'center' });
  }
}

// ---------- notes / links / unavailable ----------
function renderNote(item, box) {
  const mode = load('noteMode', 'split');
  box.innerHTML = `<div class="note-ed">
    <div class="note-bar"><input class="note-title" value="${esc(item.name)}" placeholder="Title" aria-label="Title">
      <div class="seg">${[['edit', 'Write'], ['split', 'Split'], ['preview', 'Preview']].map(([m, l]) => `<button data-act="note-mode" data-mode="${m}" class="${mode === m ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="saved">Saved</span></div>
    <div class="note-panes ${mode}"><textarea class="note-text" placeholder="Write anything. Markdown works: # headings, **bold**, - lists, \`code\`, [links](https://…)">${esc(item.body || '')}</textarea>
      <div class="note-preview"><article class="md"></article></div></div></div>`;
  const ta = box.querySelector('.note-text'), title = box.querySelector('.note-title');
  const saved = box.querySelector('.saved'), prev = box.querySelector('.note-preview .md');
  const paint = () => { prev.innerHTML = mdHtml(ta.value || '*Nothing here yet.*'); mountMd(prev, item, ''); };
  const repaint = ui.debounce(paint, 150);
  paint();
  const note = { dirty: false };
  note.save = ui.debounce(async () => {
    note.dirty = false;
    try { await post('/api/items/update', { id: item.id, patch: { body: ta.value, name: title.value.trim() || 'Untitled note' } }); if (V.note === note) saved.textContent = 'Saved'; }
    catch { saved.textContent = 'Not saved!'; note.dirty = true; }
  }, 600);
  V.note = note;
  const changed = () => { note.dirty = true; saved.textContent = 'Editing…'; note.save(); };
  ta.addEventListener('input', () => { changed(); repaint(); });
  title.addEventListener('input', changed);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  if (!item.body && item.name === 'Untitled note') { title.focus(); title.select(); } else if (!item.body) ta.focus();
}

function renderLink(item, box) {
  const m = item.meta || {};
  const web = /^https?:/i.test(item.url);
  const thumb = f => `/thumbs/${enc(f)}`;
  box.innerHTML = `<div class="vdoc"><div class="link-card">
    ${m.image ? `<div class="cover"><img src="${thumb(m.image)}" alt=""></div>` : ''}
    <div class="body">
      <div class="site">${m.icon ? `<img src="${thumb(m.icon)}" alt="">` : icon('globe')}<span>${esc(m.siteName || (() => { try { return new URL(item.url).hostname; } catch { return ''; } })())}</span></div>
      <h3>${esc(item.name)}</h3>
      ${item.description || m.description ? `<p>${esc(item.description || m.description)}</p>` : ''}
      <div class="url">${esc(item.url)}</div>
      ${web && !m.fetchedAt ? `<p class="muted">${icon('loader', 'spin')} Fetching the preview…</p>` : ''}
      ${m.error ? `<p class="muted" style="font-size:12.5px">${icon('info')} ${esc(m.error)}</p>` : ''}
      <div class="actions"><button class="btn primary" data-act="open-link">${icon('external')}Open site</button>
        <button class="btn" data-act="copy-link">${icon('copy')}Copy link</button><button class="btn" data-act="edit">${icon('edit')}Edit</button>
        ${web ? `<button class="btn ghost" data-act="refresh-preview">${icon('refresh')}Refresh preview</button>` : ''}</div>
    </div></div></div>`;
}

function renderLocked(item, box) {
  box.innerHTML = `<div class="vdoc"><div class="lockscreen"><div class="tile xl c-lock">${icon('lock')}</div><h2>This is locked</h2>
    <p>Unlock with your Windows PIN, fingerprint or face to see it.</p>
    <button class="btn primary" data-act="unlock">${icon('unlock')}Unlock with Windows Hello</button></div></div>`;
}

function renderUnavailable(item, box) {
  const msg = {
    missing: `Vault can't find this at <span class="mono">${esc(item.path)}</span> and couldn't follow it anywhere. If you moved it, point Vault to the new spot. If it was deleted, you can bring it back from a backup.`,
    recycled: 'This is in the Recycle Bin. Restore it from there and it comes straight back here.',
    offline: `This is on drive <b>${esc(item.offlineDrive)}:</b>, which isn't connected. Plug it in and it shows up again.`,
  }[item.status] || '';
  box.innerHTML = `<div class="vdoc"><div class="info-card">${ui.tile(item, 'xl')}<h3>${esc(item.name)}</h3><p>${msg}</p>
    <div class="actions">
      ${item.status === 'missing' ? `<button class="btn" data-act="search-one">${icon('refresh')}Search again</button>` : ''}
      ${item.status === 'recycled' ? `<button class="btn" data-act="recycle-bin">${icon('bin')}Open Recycle Bin</button>` : ''}
      <button class="btn" data-act="relink">${icon('locate')}Locate it myself…</button>
      <button class="btn" data-act="restore">${icon('history')}Restore from backup…</button>
    </div></div></div>`;
}

// ---------- interactions ----------
root.addEventListener('click', async e => {
  if (e.target === root) return closeViewer();
  const item = itemById(V.id);
  if (!item) return;
  const tn = e.target.closest('.tn');
  if (tn) {
    const r = tn.dataset.rel;
    if (tn.dataset.dir === '1' && r && e.target.closest('.toggle')) {
      V.open.has(r) ? V.open.delete(r) : V.open.add(r);
      return renderTree(item);
    }
    if (tn.dataset.dir === '1' && r) V.open.add(r);
    return openItem(item.id, r);
  }
  const row = e.target.closest('tr[data-rel]');
  if (row) return openItem(item.id, row.dataset.rel);
  const crumb = e.target.closest('[data-crumb]');
  if (crumb) return openItem(item.id, crumb.dataset.crumb);
  const link = e.target.closest('.md a');
  if (link) {
    if (link.dataset.rel != null) { e.preventDefault(); return openItem(item.id, link.dataset.rel); }
    if (link.dataset.anchor) { e.preventDefault(); root.querySelector('#' + CSS.escape(link.dataset.anchor))?.scrollIntoView({ behavior: 'smooth' }); }
    return;
  }
  if (e.target.matches('.img-stage img')) { e.target.parentElement.classList.toggle('actual'); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  switch (a.dataset.act) {
    case 'close': return closeViewer();
    case 'retry': V.rel = null; return syncViewer(parseHash());
    case 'open-default': return A.openWith(item, 'default');
    case 'open-link': return A.activate(item);
    case 'copy-link': return ui.copyText(item.url, 'Link copied');
    case 'refresh-preview': return A.refreshPreview(item);
    case 'ai-summarize': { const { summarize } = await import('./ai.js'); return summarize(item, V.rel, V.info?.name || item.name, isCodeInfo(V.info || {})); }
    case 'unlock': return A.unlock();
    case 'edit': return A.editItem(item);
    case 'reveal': return A.openWith(item, 'reveal');
    case 'vscode': return A.openWith(item, 'vscode');
    case 'terminal': return A.openWith(item, 'terminal');
    case 'copy-path': return ui.copyText(currentPath(item), 'Path copied');
    case 'menu': return ui.menu(a, A.itemMenu(item, { inViewer: true }), { align: 'right' });
    case 'file-open': return A.openWith(item, 'default', V.rel);
    case 'file-reveal': return A.openWith(item, 'reveal', V.rel);
    case 'file-vscode': return A.openWith(item, 'vscode', V.rel);
    case 'dir-terminal': return A.openWith(item, 'terminal', V.rel);
    case 'copy-text': return ui.copyText(V.info?.text || '', 'Contents copied');
    case 'wrap':
      V.wrap = !V.wrap;
      save('wrap', V.wrap ? '1' : '0');
      a.classList.toggle('on', V.wrap);
      root.querySelectorAll('.code').forEach(c => c.classList.toggle('wrap', V.wrap));
      return;
    case 'mode':
      if (V.info?.kind === 'markdown') V.mdMode = a.dataset.mode; else V.htmlMode = a.dataset.mode;
      a.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === a));
      return renderDoc(item, V.rel, V.info);
    case 'note-mode': {
      const panes = root.querySelector('.note-panes');
      panes.className = 'note-panes ' + a.dataset.mode;
      save('noteMode', a.dataset.mode);
      a.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === a));
      return;
    }
    case 'folder-size': {
      a.disabled = true;
      a.innerHTML = `${icon('loader', 'spin')}Counting…`;
      try {
        const s = await post(`/api/items/${enc(item.id)}/folder-size`);
        item.folderStats = s;
        ui.toast(`${item.name}: ${s.files.toLocaleString()} files, ${ui.fmtBytes(s.bytes)}`, { type: 'ok' });
        V.rel = null; syncViewer(parseHash());
      } catch (err) { ui.toast(err.message, { type: 'error' }); a.disabled = false; }
      return;
    }
    case 'search-one': return A.searchAgain([item.id]);
    case 'relink': return A.relink(item);
    case 'restore': return A.restoreFromBackup(item);
    case 'recycle-bin': return post('/api/open', { how: 'recyclebin' }).catch(err => ui.toast(err.message, { type: 'error' }));
  }
});

document.addEventListener('keydown', e => {
  if (root.hidden || e.key !== 'Escape' || ui.isModalOpen() || document.querySelector('.menu')) return;
  e.preventDefault();
  closeViewer();
});
