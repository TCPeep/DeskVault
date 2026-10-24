// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Storage page: what's taking space and hasn't been used in ages, duplicates, clean-up.
import { S, refresh, parseHash } from './state.js';
import { get, post } from './api.js';
import * as ui from './ui.js';
import { pickPaths } from './actions.js';
const { esc, icon } = ui;

const BUCKETS = [
  { label: 'Under 6 months', min: 0, max: 182 },
  { label: '6–12 months', min: 182, max: 365 },
  { label: '1–2 years', min: 365, max: 730 },
  { label: '2–3 years', min: 730, max: 1095 },
  { label: '3+ years', min: 1095, max: 0 },
];
const CATS = { all: 'All types', video: 'Videos', image: 'Images', audio: 'Audio', archive: 'Archives & disk images', installer: 'Installers', document: 'Documents', dev: 'Dev folders (node_modules…)', other: 'Other' };

const ST = {
  page: null, status: null, roots: null, tab: 'files',
  f: { basis: 'opened', minAge: 365, maxAge: 0, minSize: 0, cat: 'all', q: '', sort: 'size' },
  rows: [], total: 0, totalBytes: 0, loading: false, selected: new Map(), dupes: null, dupesBusy: null, drives: [],
};
const host = () => (parseHash().name === 'storage' ? ST.page?.querySelector('#stg') : null);
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

export async function renderStorage(page) {
  ST.page = page;
  page.innerHTML = `<div id="stg"><div class="page-head"><h1>Storage</h1></div><div class="loading">${icon('loader', 'spin')}</div></div>`;
  await loadStatus();
  if (!ST.roots) ST.roots = ST.status.summary?.roots || ST.status.suggested;
  if (ST.status.atimeOn === false) ST.f.basis = 'changed';
  draw();
  if (ST.status.summary) loadFiles();
}

async function loadStatus() {
  try { [ST.status, ST.drives] = await Promise.all([get('/api/storage'), get('/api/drives')]); }
  catch (e) { ST.status = { error: e.message }; }
}

// ---------- layout ----------
function draw() {
  const el = host();
  if (!el) return;
  const st = ST.status, sum = st.summary;
  const scanning = st.scan?.state === 'running';
  el.innerHTML = `
    <div class="page-head"><h1>Storage</h1><span class="sub">Find what you don't use any more, and clear it out safely</span></div>
    <section class="panel" id="scanPanel">${scanPanelHtml()}</section>
    ${!sum ? (scanning ? '' : `<div class="empty"><div class="tile xl c-folder">${icon('pie')}</div><h2>Pick where to look, then press Scan</h2>
      <p>Vault checks every file's size and when you last opened it, then shows you the big things you haven't touched in ages.</p></div>`) : `
    <div class="kpis" style="margin-top:16px">${kpisHtml()}</div>
    <section class="panel">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h2 style="flex:1;margin:0">${icon('clock')}How long since things were ${ST.f.basis === 'opened' ? 'opened' : 'changed'}</h2>
        ${st.summary.atimeOn ? `<div class="seg" id="basisSeg"><button data-basis="opened" class="${ST.f.basis === 'opened' ? 'on' : ''}">Last opened</button><button data-basis="changed" class="${ST.f.basis === 'changed' ? 'on' : ''}">Last changed</button></div>` : ''}
      </div>
      ${!st.summary.atimeOn ? `<p class="desc" style="margin-top:6px">Windows isn't recording when files are opened on this PC, so this uses when files were last changed.</p>` : ''}
      ${ageHtml()}
    </section>
    <div class="panels" style="margin-top:16px">
      <section class="panel"><h2>${icon('layers')}By type</h2><p class="desc">Click one to list those files.</p><div class="hbars">${typesHtml()}</div></section>
      <section class="panel"><h2>${icon('folder')}Biggest folders</h2><p class="desc">Up to two levels inside the places you scanned.</p><div class="folders">${foldersHtml()}</div></section>
    </div>
    <section class="panel" id="listPanel">${listPanelHtml()}</section>`}`;
}

function scanPanelHtml() {
  const st = ST.status;
  const scan = st.scan, running = scan?.state === 'running';
  const sys = (S.app.home || 'C')[0].toUpperCase();
  const quick = [...(st.suggested || []), ...ST.drives.map(d => d.root)].filter(p => !ST.roots.some(r => r.toLowerCase() === p.toLowerCase()));
  return `<div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap">
      <div style="flex:1;min-width:280px">
        <span class="field-label">Places to scan</span>
        <div class="scan-roots">${ST.roots.map((r, i) => `<span class="chip" title="${esc(r)}">${icon(/^[a-z]:\\?$/i.test(r) ? 'drive' : 'folder')}${esc(r.length <= 3 ? r : ui.basename(r))}<button data-act="rm-root" data-i="${i}" aria-label="Remove">${icon('x')}</button></span>`).join('') || '<span class="muted">Nothing picked</span>'}
          <button class="btn sm" data-act="add-root">${icon('folder-plus')}Add folder…</button></div>
        ${quick.length ? `<div class="quick-add">${quick.map(p => `<button class="btn ghost" data-act="quick-root" data-path="${esc(p)}">${icon('plus')}${esc(p.length <= 3 ? p + (p[0].toUpperCase() === sys ? ' (whole Windows drive)' : ' (whole drive)') : ui.basename(p))}</button>`).join('')}</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        ${running ? `<button class="btn" data-act="cancel-scan">${icon('x')}Stop</button>` : `<button class="btn primary" data-act="scan" ${ST.roots.length ? '' : 'disabled'}>${icon('search')}${st.summary ? 'Scan again' : 'Scan'}</button>`}
        ${st.summary && !running ? `<span class="muted" style="font-size:12px">Last scan ${esc(ui.timeAgo(st.summary.at))}${st.summary.cancelled ? ' (stopped early)' : ''}</span>` : ''}
      </div>
    </div>
    ${running ? `<div class="job" style="margin-top:14px"><div class="stats"><span>${icon('loader', 'spin')} Scanning… ${scan.files.toLocaleString()} files, ${ui.fmtBytes(scan.bytes)}</span><span>${scan.dirs.toLocaleString()} folders</span></div>
      <div class="cur">${esc(scan.current || '')}</div></div>` : ''}
    ${st.job?.state === 'running' ? `<div class="job" style="margin-top:14px"><div class="stats"><span>${icon('loader', 'spin')} Moving ${st.job.done} of ${st.job.total}…</span><span>${ui.fmtBytes(st.job.bytes)} moved</span></div>
      <div class="bar"><div style="width:${pct(st.job.done, st.job.total)}%"></div></div><div class="cur">${esc(st.job.current || '')}</div></div>` : ''}`;
}

function kpisHtml() {
  const st = ST.status, sum = st.summary;
  const age = sum[ST.f.basis === 'changed' ? 'changed' : 'opened'];
  const old = age.slice(2).reduce((a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files }), { bytes: 0, files: 0 });
  const bin = st.bin;
  return `
    <div class="kpi"><span class="k">${icon('drive')}Scanned</span><span class="v">${ui.fmtBytes(sum.bytes)}</span>
      <span class="s">${sum.files.toLocaleString()} files in ${sum.roots.length} place${sum.roots.length > 1 ? 's' : ''}${sum.freed ? ` · ${ui.fmtBytes(sum.freed)} cleared since` : ''}</span></div>
    <button class="kpi click" data-act="kpi-old"><span class="k">${icon('clock')}Not ${ST.f.basis === 'changed' ? 'changed' : 'opened'} in over a year</span><span class="v">${ui.fmtBytes(old.bytes)}</span>
      <span class="s">${old.files.toLocaleString()} files · ${pct(old.bytes, sum.bytes)}% of what was scanned</span></button>
    <div class="kpi"><span class="k">${icon('copy')}Duplicates</span>
      ${ST.dupes ? `<span class="v">${ui.fmtBytes(ST.dupes.wasted)}</span><span class="s">wasted on extra copies in ${ST.dupes.groups.length} group${ST.dupes.groups.length === 1 ? '' : 's'}</span><button class="btn sm" data-act="tab-dupes">Review</button>`
        : ST.dupesBusy ? `<span class="v">…</span><span class="s">${esc(ST.dupesBusy)}</span>`
        : `<span class="s">Same file stored more than once</span><button class="btn sm" data-act="find-dupes">${icon('search')}Find duplicates</button>`}</div>
    <div class="kpi"><span class="k">${icon('bin')}Recycle Bin</span><span class="v">${bin ? ui.fmtBytes(bin.bytes) : '?'}</span>
      <span class="s">${bin ? `${bin.items.toLocaleString()} item${bin.items === 1 ? '' : 's'} still taking space` : ''}</span>
      ${bin?.items ? `<button class="btn sm" data-act="empty-bin">${icon('trash')}Empty it</button>` : ''}</div>`;
}

function ageHtml() {
  const sum = ST.status.summary;
  const age = sum[ST.f.basis === 'changed' ? 'changed' : 'opened'];
  const total = age.reduce((s, b) => s + b.bytes, 0) || 1;
  const on = i => ST.f.minAge === BUCKETS[i].min && ST.f.maxAge === BUCKETS[i].max;
  return `<div class="agebar" role="img" aria-label="Space by time since last use">
      ${age.map((b, i) => b.bytes ? `<div class="seg-a ${on(i) ? 'on' : ''}" data-bucket="${i}" style="flex:${b.bytes / total};background:var(--age-${i})"></div>` : '').join('')}
    </div>
    <div class="legend">${age.map((b, i) => `<button data-bucket="${i}" class="${on(i) ? 'on' : ''}"><span class="sw" style="background:var(--age-${i})"></span><span>${BUCKETS[i].label}</span><b style="margin-left:auto">${ui.fmtBytes(b.bytes)}</b><span class="muted">${pct(b.bytes, total)}%</span></button>`).join('')}</div>`;
}

function typesHtml() {
  const cats = ST.status.summary.cats || {};
  const list = Object.entries(cats).sort((a, b) => b[1].bytes - a[1].bytes);
  const max = list[0]?.[1].bytes || 1;
  return list.map(([k, v]) => `<button class="hbar ${ST.f.cat === k ? 'on' : ''}" data-cat="${esc(k)}" title="${v.files.toLocaleString()} files"><span>${esc(CATS[k] || k)}</span><span class="track"><div style="width:${(v.bytes / max * 100).toFixed(1)}%"></div></span><span class="num">${ui.fmtBytes(v.bytes)}</span></button>`).join('');
}

function foldersHtml() {
  const f = ST.status.summary.folders || [];
  if (!f.length) return '<p class="muted">No sub-folders.</p>';
  const used = a => (ST.f.basis === 'changed' || !ST.status.summary.atimeOn ? a.changed : a.used);
  return f.slice(0, 14).map(a => `<div class="folder-row"><span class="p" title="${esc(a.path)}" style="font-family:var(--sans);font-size:13px"><b>${esc(ui.basename(a.path))}</b> <span class="muted mono" style="font-size:11.5px">${esc(ui.shortPath(a.path.slice(0, a.path.length - ui.basename(a.path).length - 1), 46))}</span></span><span class="n">${ui.fmtBytes(a.bytes)}</span>
    <span class="d" title="Most recent use of anything inside">${used(a) ? esc(ui.timeAgo(used(a))) : ''}</span>
    <button class="icon-btn" data-act="reveal" data-path="${esc(a.path)}" title="Open in Explorer">${icon('folder-open')}</button></div>`).join('');
}

function listPanelHtml() {
  const tabs = `<div class="seg"><button data-tab="files" class="${ST.tab === 'files' ? 'on' : ''}">Files</button><button data-tab="dupes" class="${ST.tab === 'dupes' ? 'on' : ''}">Duplicates${ST.dupes ? ` (${ST.dupes.groups.length})` : ''}</button></div>`;
  const selBytes = [...ST.selected.values()].reduce((s, v) => s + v, 0);
  const bulk = ST.selected.size ? `<div class="bulk" style="margin:12px 0"><span class="count">${ST.selected.size} selected · ${ui.fmtBytes(selBytes)}</span>
      <button class="btn sm" data-act="move">${icon('move-to')}Move to another drive…</button>
      <button class="btn sm" data-act="add-vault">${icon('plus')}Add to Vault</button>
      <div class="grow"></div>
      <button class="btn sm" data-act="recycle" style="color:var(--danger)">${icon('trash')}Delete…</button>
      <button class="icon-btn" data-act="clear-sel" title="Clear selection">${icon('x')}</button></div>` : '';
  if (ST.tab === 'dupes') return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">${tabs}<div class="grow" style="flex:1"></div>
      ${ST.dupes?.groups.length ? `<button class="btn sm" data-act="select-extras">${icon('check')}Select the extra copies</button>` : ''}</div>${bulk}${dupesHtml()}`;
  const f = ST.f;
  return `<div class="filters">${tabs}
      <select class="input" data-f="minAge" title="How long since last use">
        ${[[0, 'Any time'], [182, `Not ${f.basis} in 6+ months`], [365, `Not ${f.basis} in 1+ year`], [730, `Not ${f.basis} in 2+ years`], [1095, `Not ${f.basis} in 3+ years`]].map(([v, l]) => `<option value="${v}" ${f.minAge === v && !f.maxAge ? 'selected' : ''}>${l}</option>`).join('')}
        ${f.maxAge ? `<option selected>${esc(BUCKETS.find(b => b.max === f.maxAge)?.label || 'Custom')}</option>` : ''}
      </select>
      <select class="input" data-f="minSize">${[[0, 'Any size'], [1048576, '1 MB+'], [10485760, '10 MB+'], [104857600, '100 MB+'], [1073741824, '1 GB+']].map(([v, l]) => `<option value="${v}" ${f.minSize === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input" data-f="cat">${Object.entries(CATS).map(([k, l]) => `<option value="${k}" ${f.cat === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input" data-f="sort">${[['size', 'Biggest first'], ['age', 'Longest unused first'], ['name', 'Name']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input class="input" data-f="q" placeholder="Filter by name or folder" value="${esc(f.q)}" style="width:200px;height:32px">
      <div class="grow"></div>
      <span class="muted" style="font-size:12.5px">${ST.total.toLocaleString()} match${ST.total === 1 ? '' : 'es'} · ${ui.fmtBytes(ST.totalBytes)}</span>
    </div>
    ${bulk}
    ${ST.rows.length ? `<div style="overflow-x:auto"><table class="ftbl"><thead><tr>
      <th style="width:28px"><input type="checkbox" class="check" data-act="sel-page" ${ST.rows.every(r => ST.selected.has(r.path)) ? 'checked' : ''} aria-label="Select all shown"></th>
      <th>Name</th><th class="num">Size</th>${ST.status.summary.atimeOn ? '<th>Last opened</th>' : ''}<th>Last changed</th><th></th></tr></thead><tbody>
      ${ST.rows.map(rowHtml).join('')}</tbody></table></div>
      ${ST.rows.length < ST.total ? `<div style="text-align:center;margin-top:12px"><button class="btn" data-act="more">Show more</button></div>` : ''}`
      : `<div class="empty" style="padding:40px">${ST.loading ? icon('loader', 'spin') : '<h2>Nothing matches</h2><p>Try a shorter time or a smaller size.</p>'}</div>`}
    <p class="muted" style="font-size:12px;margin:12px 0 0">${icon('info')} Only files over 50 KB are listed one by one (smaller ones still count in the totals). Antivirus scans and some backup tools can count as "opening" a file.</p>`;
}

function rowHtml(r) {
  const sel = ST.selected.has(r.path);
  return `<tr class="${sel ? 'sel' : ''}" data-path="${esc(r.path)}" data-size="${r.size}">
    <td><input type="checkbox" class="check" data-act="sel" ${sel ? 'checked' : ''} aria-label="Select"></td>
    <td><div class="nm">${ui.ficon(r.name, r.bundle)}<div><div class="t">${esc(r.name)} ${r.bundle ? '<span class="badge muted">dev folder</span>' : ''} ${r.inVault ? '<span class="badge info">In Vault</span>' : ''}</div><div class="p" title="${esc(r.dir)}">${esc(r.dir)}</div></div></div></td>
    <td class="num">${ui.fmtBytes(r.size)}</td>
    ${ST.status.summary.atimeOn ? `<td class="dt" title="${esc(new Date(r.opened).toLocaleString())}">${esc(ui.timeAgo(r.opened))}</td>` : ''}
    <td class="dt" title="${esc(new Date(r.changed).toLocaleString())}">${esc(ui.timeAgo(r.changed))}</td>
    <td><div class="acts"><button class="icon-btn" data-act="reveal" data-path="${esc(r.path)}" title="Show in Explorer">${icon('folder-open')}</button></div></td></tr>`;
}

function dupesHtml() {
  if (ST.dupesBusy) return `<div class="loading">${icon('loader', 'spin')}${esc(ST.dupesBusy)}</div>`;
  if (!ST.dupes) return `<div class="empty" style="padding:40px"><h2>Look for duplicates?</h2><p>Vault compares files of the same size by their contents. Only files over 1 MB are checked.</p><button class="btn primary" data-act="find-dupes">${icon('search')}Find duplicates</button></div>`;
  if (!ST.dupes.groups.length) return `<div class="empty" style="padding:40px"><h2>No duplicates found</h2><p>Nothing over 1 MB is stored twice in the places you scanned.</p></div>`;
  return ST.dupes.groups.slice(0, 100).map((g, gi) => `<div class="dupe"><div class="dupe-head">${ui.ficon(g.files[0].name)}<b title="${esc(g.files[0].name)}">${esc(g.files[0].name)}</b>
      <span class="muted">${g.files.length} copies × ${ui.fmtBytes(g.size)}</span><span class="badge warn">${ui.fmtBytes(g.wasted)} extra</span></div>
    <table class="ftbl"><tbody>${g.files.map(f => { const sel = ST.selected.has(f.path); return `<tr class="${sel ? 'sel' : ''}" data-path="${esc(f.path)}" data-size="${g.size}">
      <td style="width:28px"><input type="checkbox" class="check" data-act="sel" ${sel ? 'checked' : ''} aria-label="Select"></td>
      <td><div class="nm"><div><div class="t">${esc(f.name)}</div><div class="p" style="max-width:none" title="${esc(f.path)}">${esc(f.dir)}</div></div></div></td>
      <td class="dt">${f.inVault ? '<span class="badge info">In Vault</span> ' : ''}${f.opened ? `opened ${esc(ui.timeAgo(f.opened))}` : `changed ${esc(ui.timeAgo(f.changed))}`}</td>
      <td><div class="acts"><button class="icon-btn" data-act="reveal" data-path="${esc(f.path)}" title="Show in Explorer">${icon('folder-open')}</button></div></td></tr>`; }).join('')}</tbody></table></div>`).join('')
    + (ST.dupes.groups.length > 100 ? `<p class="muted">Showing the 100 biggest of ${ST.dupes.groups.length} groups.</p>` : '');
}

// ---------- data ----------
async function loadFiles(append = false) {
  const f = ST.f;
  ST.loading = true;
  const qs = new URLSearchParams({ basis: f.basis, minAge: f.minAge, maxAge: f.maxAge, minSize: f.minSize, cat: f.cat, q: f.q, sort: f.sort, offset: append ? ST.rows.length : 0, limit: 200 });
  try {
    const r = await get('/api/storage/files?' + qs);
    ST.rows = append ? [...ST.rows, ...r.rows] : r.rows;
    ST.total = r.total;
    ST.totalBytes = r.totalBytes;
  } catch (e) { ui.toast(e.message, { type: 'error' }); }
  ST.loading = false;
  redrawList();
}

function redrawList() {
  const p = host()?.querySelector('#listPanel');
  if (!p) return;
  const typing = document.activeElement?.dataset?.f === 'q' ? document.activeElement.selectionStart : null;
  p.innerHTML = listPanelHtml();
  if (typing != null) { const i = p.querySelector('[data-f=q]'); i.focus(); i.setSelectionRange(typing, typing); }
}
function redrawScan() {
  const p = host()?.querySelector('#scanPanel');
  if (p) p.innerHTML = scanPanelHtml();
}

async function findDupes() {
  ST.dupesBusy = 'Comparing files…';
  ST.tab = 'dupes';
  draw();
  try { ST.dupes = await post('/api/storage/duplicates'); } catch (e) { ui.toast(e.message, { type: 'error' }); }
  ST.dupesBusy = null;
  draw();
}

export function onStorageEvent(kind, d) {
  if (!host()) return;
  if (kind === 'done') { loadStatus().then(() => { draw(); if (ST.status.summary) loadFiles(); }); return; }
  if (d?.scan) { ST.status.scan = d.scan; }
  if (d?.job) {
    const was = ST.status.job?.state;
    ST.status.job = d.job;
    if (d.job.state !== 'running' && was === 'running') afterMove(d.job);
  }
  if (d?.dupes && ST.dupesBusy) {
    ST.dupesBusy = `Comparing files… ${d.dupes.done.toLocaleString()} of ${d.dupes.total.toLocaleString()}`;
    const k = host().querySelector('.kpis');
    if (k) k.innerHTML = kpisHtml();
    return;
  }
  if (!ST.status.summary && d?.scan?.state === 'running') return draw();
  redrawScan();
}

async function afterMove(job) {
  if (job.state === 'complete') ui.toast(`Moved ${job.done} item${job.done === 1 ? '' : 's'} (${ui.fmtBytes(job.bytes)})${job.freed ? `. Freed ${ui.fmtBytes(job.freed)} here` : ''}`, { type: 'ok', timeout: 7000 });
  else if (job.errors.length) ui.toast(`${job.errors.length} couldn't be moved: ${job.errors[0].message}`, { type: 'warn', timeout: 9000 });
  ST.selected.clear();
  await loadStatus();
  draw();
  loadFiles();
  refresh();
}

// ---------- actions ----------
async function doRecycle() {
  const paths = [...ST.selected.keys()];
  const bytes = [...ST.selected.values()].reduce((s, v) => s + v, 0);
  const ok = await ui.confirm({
    title: `Delete ${paths.length} item${paths.length > 1 ? 's' : ''} (${ui.fmtBytes(bytes)})?`,
    html: `<p>They go to the <b>Recycle Bin</b>, so you can still get them back. The space is only freed once you empty the Recycle Bin (there's a button for that at the top of this page).</p>
      <div class="list-plain" style="max-height:220px;overflow:auto">${paths.slice(0, 50).map(p => `<div class="li">${ui.ficon(p)}<span class="mono" title="${esc(p)}">${esc(p)}</span></div>`).join('')}${paths.length > 50 ? `<div class="muted">…and ${paths.length - 50} more</div>` : ''}</div>`,
    confirmLabel: 'Move to Recycle Bin', danger: true,
  });
  if (!ok) return;
  const busy = ui.toast('Deleting…', { type: 'busy', sticky: true });
  let r;
  try { r = await post('/api/storage/recycle', { paths }); } catch (e) { busy.close(); return ui.toast(e.message, { type: 'error' }); }
  busy.close();
  const done = r.results.filter(x => x.ok), failed = r.results.filter(x => !x.ok);
  if (done.length) ui.toast(`Moved ${done.length} item${done.length > 1 ? 's' : ''} (${ui.fmtBytes(done.reduce((s, x) => s + x.size, 0))}) to the Recycle Bin`, { type: 'ok' });
  if (failed.length) ui.toast(`${failed.length} not deleted: ${failed[0].message}`, { type: 'warn', timeout: 9000 });
  for (const x of done) ST.selected.delete(x.path);
  if (ST.dupes) for (const g of ST.dupes.groups) g.files = g.files.filter(f => !done.some(x => x.path === f.path));
  if (ST.dupes) ST.dupes.groups = ST.dupes.groups.filter(g => g.files.length > 1);
  await loadStatus();
  draw();
  loadFiles();
}

async function doMove() {
  const paths = [...ST.selected.keys()];
  const bytes = [...ST.selected.values()].reduce((s, v) => s + v, 0);
  const srcDrives = new Set(paths.map(p => p.slice(0, 2).toUpperCase()));
  const options = ST.drives.filter(d => !srcDrives.has(d.root.slice(0, 2).toUpperCase())).sort((a, b) => b.free - a.free);
  let dest = options[0]?.root || null;
  const r = await ui.modal({
    title: `Move ${paths.length} item${paths.length > 1 ? 's' : ''} to another drive`,
    body: `<p>Frees ${ui.fmtBytes(bytes)} here. Each item is copied, checked, and only then removed from its old spot. They keep their folder layout inside <span class="mono">Vault Archive</span> on the drive you pick.</p>
      <div class="drives" id="mvDrives">${options.map(d => `<button class="drive ${d.root === dest ? 'on' : ''}" data-dest="${esc(d.root)}"><div class="top">${icon('drive')}<span class="letter">${esc(d.root.slice(0, 2))}</span><span class="lbl">${esc(d.label || 'Local disk')}</span></div><div class="free">${ui.fmtBytes(d.free)} free</div></button>`).join('') || '<p class="muted">No other drive found. Plug one in or pick a folder.</p>'}</div>
      <div style="margin-top:10px"><button class="btn sm" data-pick>${icon('folder-open')}Choose a folder…</button> <span class="mono muted" id="mvDest" style="font-size:12px"></span></div>
      <label class="row-field" style="margin-top:12px"><div class="grow"><div class="t">Keep them findable in Vault</div><div class="d">Adds the Vault Archive folder to Vault (once), so everything you move stays one click away.</div></div><input type="checkbox" class="switch" name="track" checked></label>`,
    onOpen: m => m.addEventListener('click', async e => {
      const b = e.target.closest('[data-dest]');
      if (b) { dest = b.dataset.dest; ui.$$('#mvDrives .drive', m).forEach(x => x.classList.toggle('on', x === b)); m.querySelector('#mvDest').textContent = ''; }
      if (e.target.closest('[data-pick]')) {
        const [p] = await pickPaths('folder', false, 'Move them into which folder?');
        if (p) { dest = p; ui.$$('#mvDrives .drive', m).forEach(x => x.classList.remove('on')); m.querySelector('#mvDest').textContent = p; }
      }
    }),
    actions: [{ label: 'Cancel', value: null }, { label: 'Move', kind: 'primary', icon: 'move-to', onClick: async m => {
      if (!dest) throw new Error('Pick where to move them');
      await post('/api/storage/move', { paths, dest, track: m.querySelector('[name=track]').checked });
      return 'started';
    } }],
  });
  if (r === 'started') { await loadStatus(); redrawScan(); }
}

async function doAddVault() {
  const paths = [...ST.selected.keys()];
  try {
    const r = await post('/api/storage/add', { paths });
    ui.toast(`Added ${r.added.length} to Vault${r.skipped.length ? ` (${r.skipped.length} were already there)` : ''}`, { type: 'ok' });
    ST.selected.clear();
    refresh();
    loadFiles();
  } catch (e) { ui.toast(e.message, { type: 'error' }); }
}

async function emptyBin() {
  const b = ST.status.bin;
  const ok = await ui.confirm({ title: 'Empty the Recycle Bin?', message: `Permanently deletes ${b.items.toLocaleString()} item${b.items === 1 ? '' : 's'} (${ui.fmtBytes(b.bytes)}) from the Recycle Bin on all drives. This can't be undone.`, confirmLabel: 'Empty Recycle Bin', danger: true });
  if (!ok) return;
  try {
    const r = await post('/api/storage/empty-bin');
    ui.toast(r.hr === 0 ? `Recycle Bin emptied. ${ui.fmtBytes(b.bytes)} freed` : 'Windows couldn\'t empty the Recycle Bin', { type: r.hr === 0 ? 'ok' : 'warn' });
  } catch (e) { ui.toast(e.message, { type: 'error' }); }
  await loadStatus();
  draw();
}

function selectExtras() {
  // Keep one copy per group: the one in Vault, otherwise the most recently used; select the rest.
  for (const g of ST.dupes.groups) {
    const keep = [...g.files].sort((a, b) => (b.inVault - a.inVault) || ((b.opened || b.changed) - (a.opened || a.changed)))[0];
    for (const f of g.files) if (f !== keep) ST.selected.set(f.path, g.size);
  }
  redrawList();
}

let tip = null;
function showTip(e, html) {
  if (!tip) { tip = document.createElement('div'); tip.className = 'vtip'; document.body.appendChild(tip); }
  tip.innerHTML = html;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
}
function hideTip() { tip?.remove(); tip = null; }

document.addEventListener('mousemove', e => {
  const seg = e.target.closest?.('#stg .seg-a');
  if (!seg) return hideTip();
  const i = +seg.dataset.bucket;
  const b = ST.status.summary[ST.f.basis === 'changed' ? 'changed' : 'opened'][i];
  showTip(e, `<b>${BUCKETS[i].label} since last ${ST.f.basis === 'changed' ? 'change' : 'open'}</b>${ui.fmtBytes(b.bytes)} · ${b.files.toLocaleString()} files`);
});

document.addEventListener('click', async e => {
  const el = host();
  if (!el || !el.contains(e.target)) return;
  const t = e.target;
  const bucket = t.closest('[data-bucket]');
  if (bucket) {
    const b = BUCKETS[+bucket.dataset.bucket];
    Object.assign(ST.f, { minAge: b.min, maxAge: b.max });
    ST.tab = 'files';
    draw();
    return loadFiles();
  }
  const basis = t.closest('[data-basis]');
  if (basis) { ST.f.basis = basis.dataset.basis; draw(); return loadFiles(); }
  const cat = t.closest('[data-cat]');
  if (cat) { ST.f.cat = ST.f.cat === cat.dataset.cat ? 'all' : cat.dataset.cat; ST.tab = 'files'; draw(); loadFiles(); return host()?.querySelector('#listPanel')?.scrollIntoView({ behavior: 'smooth' }); }
  const tab = t.closest('[data-tab]');
  if (tab) { ST.tab = tab.dataset.tab; return redrawList(); }
  const a = t.closest('[data-act]');
  if (!a) return;
  const row = t.closest('tr[data-path]');
  switch (a.dataset.act) {
    case 'rm-root': ST.roots.splice(+a.dataset.i, 1); return redrawScan();
    case 'quick-root': ST.roots.push(a.dataset.path); return redrawScan();
    case 'add-root': { const ps = await pickPaths('folder', true, 'Scan which folders?'); ST.roots.push(...ps.filter(p => !ST.roots.includes(p))); return redrawScan(); }
    case 'scan':
      try { ST.status.scan = await post('/api/storage/scan', { roots: ST.roots }); ST.selected.clear(); ST.dupes = null; draw(); }
      catch (err) { ui.toast(err.message, { type: 'error' }); }
      return;
    case 'cancel-scan': return post('/api/storage/cancel').catch(() => {});
    case 'kpi-old': Object.assign(ST.f, { minAge: 365, maxAge: 0 }); ST.tab = 'files'; draw(); loadFiles(); return host()?.querySelector('#listPanel')?.scrollIntoView({ behavior: 'smooth' });
    case 'find-dupes': return findDupes();
    case 'tab-dupes': ST.tab = 'dupes'; redrawList(); return host()?.querySelector('#listPanel')?.scrollIntoView({ behavior: 'smooth' });
    case 'select-extras': return selectExtras();
    case 'empty-bin': return emptyBin();
    case 'reveal': return post('/api/open', { path: a.dataset.path, how: 'reveal' }).catch(err => ui.toast(err.message, { type: 'error' }));
    case 'sel':
      if (!row) return;
      if (t.checked) ST.selected.set(row.dataset.path, +row.dataset.size); else ST.selected.delete(row.dataset.path);
      return redrawList();
    case 'sel-page':
      for (const r of ST.rows) { if (t.checked) ST.selected.set(r.path, r.size); else ST.selected.delete(r.path); }
      return redrawList();
    case 'clear-sel': ST.selected.clear(); return redrawList();
    case 'more': return loadFiles(true);
    case 'recycle': return doRecycle();
    case 'move': return doMove();
    case 'add-vault': return doAddVault();
  }
});

const onFilter = ui.debounce(() => loadFiles(), 250);
document.addEventListener('change', e => {
  const el = host();
  const k = e.target.dataset?.f;
  if (!el || !el.contains(e.target) || !k || k === 'q') return;
  if (k === 'minAge') { ST.f.minAge = +e.target.value || 0; ST.f.maxAge = 0; }
  else if (k === 'minSize') ST.f.minSize = +e.target.value || 0;
  else ST.f[k] = e.target.value;
  loadFiles();
});
document.addEventListener('input', e => {
  const el = host();
  if (!el || !el.contains(e.target) || e.target.dataset?.f !== 'q') return;
  ST.f.q = e.target.value;
  onFilter();
});
