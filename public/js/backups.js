// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Backups page: back up now, progress, automatic backups, history (restore / purge).
import { S, refresh, parseHash, collectionById, itemById } from './state.js';
import { get, post } from './api.js';
import * as ui from './ui.js';
import { pickPaths } from './actions.js';
const { esc, icon } = ui;

const BK = { page: null, dest: null, mode: 'snapshot', scope: { type: 'all' }, est: null, estimating: false, tok: 0, drives: [], list: [] };
const onPage = () => parseHash().name === 'backups' && BK.page?.querySelector('#bk');

export async function renderBackups(page) {
  BK.page = page;
  if (S.backupScope) { BK.scope = S.backupScope; S.backupScope = null; }
  page.innerHTML = `<div class="page-head"><h1>Backups</h1><span class="sub">Copy your important things to another drive, any time</span></div><div id="bk"><div class="loading">${icon('loader', 'spin')}Looking at your drives…</div></div>`;
  try {
    [BK.drives, BK.list] = await Promise.all([get('/api/drives'), get('/api/backups')]);
  } catch (e) { page.querySelector('#bk').innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  if (!BK.dest || !driveFor(BK.dest) && !BK.customDest) {
    const sys = (S.app.home || 'C')[0].toUpperCase();
    const other = BK.drives.filter(d => d.root[0].toUpperCase() !== sys).sort((a, b) => b.free - a.free)[0];
    BK.dest = other?.root || null;
  }
  draw();
  estimate();
}

const driveFor = p => BK.drives.find(d => p && p.slice(0, 2).toUpperCase() === d.root.slice(0, 2).toUpperCase());

function draw() {
  const el = onPage();
  if (!el) return;
  el.innerHTML = `
    <div class="panels">
      <section class="panel">
        <h2>${icon('backup')}Back up now</h2>
        <p class="desc">Copies your tracked files and folders, plus Vault's own list of links, notes, tags and collections, so you can restore everything later.</p>
        <div class="field"><span class="field-label">Where to</span>
          <div class="drives">${drivesHtml()}</div>
          <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn sm" data-act="pick-dest">${icon('folder-open')}Choose a folder…</button>
            ${BK.customDest ? `<span class="chip" title="${esc(BK.dest)}">${icon('folder')}${esc(BK.dest)}</span>` : ''}
          </div>
        </div>
        <div class="field"><span class="field-label">What</span>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <div class="seg" id="scopeSeg">
              <button data-scope="all" class="${BK.scope.type === 'all' ? 'on' : ''}">Everything</button>
              <button data-scope="collection" class="${BK.scope.type === 'collection' ? 'on' : ''}">A collection</button>
              ${BK.scope.type === 'items' ? `<button data-scope="items" class="on">${BK.scope.ids.length} picked item${BK.scope.ids.length > 1 ? 's' : ''}</button>` : ''}
            </div>
            ${BK.scope.type === 'collection' ? `<select class="input" id="scopeCol" style="width:auto">${S.collections.map(c => `<option value="${esc(c.id)}" ${c.id === BK.scope.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="" ${!BK.scope.id ? 'selected' : ''}>Unsorted</option></select>` : ''}
          </div>
          ${BK.scope.type === 'items' ? `<div class="hint">${BK.scope.ids.map(id => esc(itemById(id)?.name || '?')).slice(0, 6).join(', ')}${BK.scope.ids.length > 6 ? '…' : ''}</div>` : ''}
        </div>
        <div class="field"><span class="field-label">How</span>
          <div class="choice-cards">
            <button class="choice ${BK.mode === 'snapshot' ? 'on' : ''}" data-mode="snapshot">${icon('history')}<div><b>Snapshot</b><span>A complete, dated copy every time. Keeps history; uses more space.</span></div></button>
            <button class="choice ${BK.mode === 'mirror' ? 'on' : ''}" data-mode="mirror">${icon('refresh')}<div><b>Mirror</b><span>One copy kept up to date. Only changed files get copied, so it's fast.</span></div></button>
          </div>
        </div>
        <div id="est">${estimateHtml()}</div>
        <div style="margin-top:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="btn primary" data-act="start" ${canStart() ? '' : 'disabled'}>${icon('backup')}Start backup</button>
          <span class="muted" style="font-size:12.5px">Skipped inside folders: ${esc((S.settings.backupExcludes || []).join(', ') || 'nothing')} <a href="#/settings">change</a></span>
        </div>
      </section>
      <div>
        <section class="panel" id="jobPanel">${jobHtml()}</section>
        <section class="panel" id="autoPanel">${autoHtml()}</section>
      </div>
    </div>
    <section class="panel" id="histPanel">${historyHtml()}</section>`;
}

function drivesHtml() {
  if (!BK.drives.length) return '<p class="muted">No drives found.</p>';
  const sys = (S.app.home || 'C')[0].toUpperCase();
  return BK.drives.map(d => {
    const pct = d.total ? (d.total - d.free) / d.total * 100 : 0;
    const on = !BK.customDest && BK.dest && BK.dest.toUpperCase() === d.root.toUpperCase();
    return `<button class="drive ${on ? 'on' : ''} ${d.free < 10e9 ? 'low' : ''}" data-dest="${esc(d.root)}">
      <div class="top">${icon(d.type === 'Removable' ? 'usb' : 'drive')}<span class="letter">${esc(d.root.slice(0, 2))}</span><span class="lbl">${esc(d.label || (d.type === 'Removable' ? 'USB drive' : 'Local disk'))}</span></div>
      <div class="bar"><div style="width:${pct.toFixed(1)}%"></div></div>
      <div class="free">${ui.fmtBytes(d.free)} free of ${ui.fmtBytes(d.total)}${d.root[0].toUpperCase() === sys ? ' · Windows drive' : ''}</div></button>`;
  }).join('');
}

function scopeObj() { return BK.scope; }
function canStart() {
  return BK.dest && !S.jobs.some(j => j.state === 'running') && BK.est && !BK.est.error && BK.est.files > 0 &&
    !(BK.mode === 'snapshot' && BK.est.free != null && BK.est.bytes > BK.est.free);
}

function estimateHtml() {
  if (!BK.dest) return `<div class="estimate warn">${icon('alert')}<div>Pick a drive or folder to back up to.</div></div>`;
  if (BK.estimating) return `<div class="estimate">${icon('loader', 'spin')}<div>Measuring what needs copying…</div></div>`;
  const e = BK.est;
  if (!e) return '';
  if (e.error) return `<div class="estimate bad">${icon('alert')}<div>${esc(e.error)}</div></div>`;
  const notes = [];
  let cls = '', ic = 'info';
  if (BK.mode === 'snapshot' && e.free != null && e.bytes > e.free) { cls = 'bad'; ic = 'alert'; notes.push(`<b>Not enough space.</b> Needs ${ui.fmtBytes(e.bytes)} but only ${ui.fmtBytes(e.free)} is free. Try Mirror, another drive, or fewer items.`); }
  if (e.sameDrive) { cls ||= 'warn'; ic = 'alert'; notes.push(`${e.sameDrive} item${e.sameDrive > 1 ? 's are' : ' is'} on this same drive. A copy on a <b>different</b> drive is what protects you if a drive dies.`); }
  if (e.skipped?.length) notes.push(`${e.skipped.length} item${e.skipped.length > 1 ? 's' : ''} can't be reached right now and will be skipped: ${e.skipped.slice(0, 4).map(s => esc(s.name)).join(', ')}${e.skipped.length > 4 ? '…' : ''}`);
  return `<div class="estimate ${cls}">${icon(ic)}<div><b>${e.files.toLocaleString()} files · ${ui.fmtBytes(e.bytes)}</b> from ${e.items} item${e.items === 1 ? '' : 's'}${e.free != null ? ` · ${ui.fmtBytes(e.free)} free there` : ''}${BK.mode === 'mirror' ? '<br><span class="muted">Mirror only copies what changed since last time, so it usually needs far less.</span>' : ''}
    ${notes.map(n => `<div style="margin-top:6px">${n}</div>`).join('')}</div></div>`;
}

async function estimate() {
  const tok = ++BK.tok;
  if (!BK.dest) { BK.est = null; return updateEst(); }
  BK.estimating = true; updateEst();
  try {
    const r = await post('/api/backup/estimate', { scope: scopeObj(), dest: BK.dest });
    if (tok === BK.tok) BK.est = r;
  } catch (e) { if (tok === BK.tok) BK.est = { error: e.message }; }
  if (tok !== BK.tok) return;
  BK.estimating = false;
  updateEst();
}
function updateEst() {
  const el = onPage();
  if (!el) return;
  const est = el.querySelector('#est');
  if (est) est.innerHTML = estimateHtml();
  const btn = el.querySelector('[data-act=start]');
  if (btn) btn.disabled = !canStart();
}

// ---------- progress ----------
function jobHtml() {
  const j = S.jobs.find(x => x.state === 'running') || S.jobs[0];
  if (!j) return `<h2>${icon('activity')}Progress</h2><p class="desc" style="margin:0">Nothing running. Start a backup and you'll see it here.</p>`;
  const pct = j.bytesTotal ? j.bytesDone / j.bytesTotal : j.filesTotal ? j.filesDone / j.filesTotal : 0;
  const secs = Math.max(1, (Date.now() - Date.parse(j.startedAt)) / 1000);
  const speed = j.bytesDone / secs;
  const eta = speed > 0 && j.bytesTotal ? (j.bytesTotal - j.bytesDone) / speed : null;
  const label = j.kind === 'restore' ? `Restoring ${j.itemName}` : (j.mode === 'mirror' ? 'Mirror' : 'Snapshot') + ' to ' + j.dest;
  const stateBadge = { running: ['info', 'loader', j.phase === 'scanning' ? 'Scanning' : j.phase === 'cancelling' ? 'Stopping' : 'Copying'], complete: ['ok', 'check', 'Done'], errors: ['warn', 'alert', 'Done with problems'], failed: ['danger', 'alert', 'Failed'], cancelled: ['muted', 'x', 'Cancelled'] }[j.state];
  return `<h2>${icon('activity')}Progress</h2>
    <div class="job">
      <div class="head"><b title="${esc(label)}">${esc(label)}</b><span class="badge ${stateBadge[0]}">${icon(stateBadge[1], j.state === 'running' ? 'spin' : '')}${stateBadge[2]}</span></div>
      <div class="bar big"><div style="width:${(pct * 100).toFixed(1)}%"></div></div>
      <div class="stats"><span>${j.filesDone.toLocaleString()} / ${j.filesTotal.toLocaleString()} files</span><span>${ui.fmtBytes(j.bytesDone)} / ${ui.fmtBytes(j.bytesTotal)}</span>
        ${j.state === 'running' && j.phase === 'copying' ? `<span>${ui.fmtBytes(speed)}/s${eta != null ? ` · ${fmtDur(eta)} left` : ''}</span>` : `<span>${j.finishedAt ? esc(ui.timeAgo(j.finishedAt)) : ''}</span>`}</div>
      ${j.state === 'running' ? `<div class="cur" title="${esc(j.current)}">${esc(j.current || ' ')}</div>` : ''}
      ${j.state !== 'running' && j.kind === 'backup' && j.state !== 'failed' ? `<div style="font-size:13px;color:var(--text2)">${j.copied.toLocaleString()} copied${j.mode === 'mirror' ? `, ${j.unchanged.toLocaleString()} already up to date` : ''}${j.skipped?.length ? `, ${j.skipped.length} item${j.skipped.length > 1 ? 's' : ''} skipped (not reachable)` : ''}.</div>` : ''}
      ${j.state === 'failed' ? `<div style="color:var(--danger);font-size:13px">${esc(j.message)}</div>` : ''}
      ${j.errorCount ? `<details><summary style="cursor:pointer;font-size:13px">${j.errorCount} file${j.errorCount > 1 ? 's' : ''} couldn't be copied</summary><div class="errors" style="margin-top:8px">${j.errors.map(e => `<div><span class="mono">${esc(e.path)}</span><br><span class="muted">${esc(e.message)}</span></div>`).join('')}${j.errorCount > j.errors.length ? `<div class="muted">…and ${j.errorCount - j.errors.length} more</div>` : ''}</div></details>` : ''}
      <div style="display:flex;gap:8px">
        ${j.state === 'running' ? `<button class="btn sm" data-act="cancel" data-id="${esc(j.id)}" ${j.phase === 'cancelling' ? 'disabled' : ''}>${icon('x')}Cancel</button>` : ''}
        ${j.folder && j.state !== 'running' && j.state !== 'failed' ? `<button class="btn sm" data-act="open-folder" data-folder="${esc(j.kind === 'restore' ? j.target : j.folder)}">${icon('folder-open')}Open ${j.kind === 'restore' ? 'restored copy' : 'backup folder'}</button>` : ''}
      </div>
    </div>`;
}
const fmtDur = s => s < 60 ? `${Math.ceil(s)} s` : s < 3600 ? `${Math.ceil(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

let lastHistReload = 0;
export function onJob(j) {
  const el = onPage();
  if (!el) return;
  const p = el.querySelector('#jobPanel');
  if (p && !p.querySelector('details[open]')) p.innerHTML = jobHtml();
  const btn = el.querySelector('[data-act=start]');
  if (btn) btn.disabled = !canStart();
  if (j.state !== 'running' && Date.now() - lastHistReload > 1000) { lastHistReload = Date.now(); reloadList(); estimate(); }
}

export async function onBackupsChanged() { if (onPage()) reloadList(); }

async function reloadList() {
  try { BK.list = await get('/api/backups'); } catch { return; }
  const h = onPage()?.querySelector('#histPanel');
  if (h) h.innerHTML = historyHtml();
}

// ---------- automatic ----------
function autoHtml() {
  const a = S.settings.autoBackup || {};
  return `<h2>${icon('clock')}Automatic backups</h2>
    <p class="desc">Vault backs everything up on a schedule while it's running. If the drive isn't plugged in, it waits and tries again later.${S.app.shortcuts?.startup ? '' : ` Turn on <a href="#/settings">Start with Windows</a> so it's always running.`}</p>
    <div class="row-field"><div class="grow"><div class="t">Back up automatically</div><div class="d">${a.lastRun ? `Last ran ${esc(ui.timeAgo(a.lastRun))}${a.lastResult ? ` (${esc(a.lastResult)})` : ''}` : 'Hasn\'t run yet'}</div></div>
      <input type="checkbox" class="switch" data-auto="enabled" ${a.enabled ? 'checked' : ''} ${a.dest ? '' : 'disabled title="Choose where first"'}></div>
    <div class="row-field"><div class="grow"><div class="t">Where</div><div class="d mono" title="${esc(a.dest || '')}">${esc(a.dest || 'Not chosen yet')}</div></div>
      ${BK.dest && BK.dest !== a.dest ? `<button class="btn sm" data-act="auto-dest-current">Use ${esc(BK.customDest ? 'that folder' : BK.dest.slice(0, 2))}</button>` : ''}</div>
    <div class="row-field"><div class="grow"><div class="t">How often</div></div>
      <select class="input" data-auto="every">${[['hourly', 'Every hour'], ['daily', 'Every day'], ['weekly', 'Every week']].map(([v, l]) => `<option value="${v}" ${a.every === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="row-field"><div class="grow"><div class="t">Type</div><div class="d">${a.mode === 'snapshot' ? `Keeps the newest ${a.keep} automatic snapshots, deletes older ones.` : 'One mirror, refreshed each time.'}</div></div>
      <select class="input" data-auto="mode"><option value="mirror" ${a.mode !== 'snapshot' ? 'selected' : ''}>Mirror</option><option value="snapshot" ${a.mode === 'snapshot' ? 'selected' : ''}>Snapshots</option></select>
      ${a.mode === 'snapshot' ? `<input type="number" class="input" data-auto="keep" value="${a.keep}" min="1" max="100" style="width:72px" title="How many to keep">` : ''}</div>`;
}

async function saveAuto(patch) {
  try {
    S.settings = await post('/api/settings', { patch: { autoBackup: patch } });
    const p = onPage()?.querySelector('#autoPanel');
    if (p) p.innerHTML = autoHtml();
  } catch (e) { ui.toast(e.message, { type: 'error' }); }
}

// ---------- history ----------
function historyHtml() {
  const list = BK.list || [];
  const snaps = list.filter(b => b.mode === 'snapshot' && b.exists && b.status !== 'running');
  return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap"><h2 style="margin:0;flex:1">${icon('archive')}Your backups</h2>
      ${snaps.length > 1 ? `<button class="btn sm" data-act="purge-old">${icon('trash')}Clean up old snapshots…</button>` : ''}
      <button class="btn sm" data-act="refresh-list">${icon('refresh')}Refresh</button></div>
    ${!list.length ? '<p class="desc" style="margin:0">No backups yet. They show up here (along with any Vault backups found on connected drives).</p>' : `
    <div style="overflow-x:auto"><table class="tbl"><thead><tr><th>When</th><th>Where</th><th>Type</th><th>Size</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(b => `<tr class="${b.exists ? '' : 'gone'}" data-folder="${esc(b.folder)}">
      <td style="white-space:nowrap">${esc(ui.fmtDate(b.at))}<div class="muted" style="font-size:12px">${esc(ui.timeAgo(b.at))}</div></td>
      <td><div class="where" title="${esc(b.folder)}">${esc(b.folder)}</div>${b.computer && b.computer !== S.app.computer ? `<div class="muted" style="font-size:12px">from ${esc(b.computer)}</div>` : ''}</td>
      <td style="white-space:nowrap">${b.mode === 'mirror' ? 'Mirror' : 'Snapshot'}${b.auto ? ' <span class="badge muted">auto</span>' : ''}</td>
      <td style="white-space:nowrap">${b.items} item${b.items === 1 ? '' : 's'}<div class="muted" style="font-size:12px">${b.bytes != null ? ui.fmtBytes(b.bytes) : ''}</div></td>
      <td>${histBadge(b)}</td>
      <td><div class="acts">${b.exists ? `<button class="btn sm" data-act="browse">${icon('history')}Restore…</button>
        <button class="icon-btn" data-act="open-folder" title="Open in Explorer">${icon('folder-open')}</button>
        <button class="icon-btn" data-act="delete-backup" title="Delete this backup">${icon('trash')}</button>` : '<span class="muted" style="font-size:12px;white-space:nowrap">Drive not connected</span>'}</div></td></tr>`).join('')}
    </tbody></table></div>`}`;
}
function histBadge(b) {
  const m = { complete: ['ok', 'Complete'], errors: ['warn', `${b.errors || ''} errors`], cancelled: ['muted', 'Cancelled'], running: ['info', 'In progress'], failed: ['danger', 'Failed'] }[b.status] || ['muted', b.status || '?'];
  return `<span class="badge ${m[0]}">${esc(m[1])}</span>`;
}

async function browse(folder) {
  let c;
  try { c = await post('/api/backups/contents', { folder }); } catch (e) { return ui.toast(e.message, { type: 'error' }); }
  await ui.modal({
    title: `Backup from ${ui.fmtDate(c.at)}`,
    wide: true,
    body: `<p><span class="mono" style="font-size:12px">${esc(folder)}</span></p>
      <p style="font-size:13px">${icon('shield')} Restoring puts things back where they were. If something's already there, the restored copy goes right next to it instead. Nothing gets overwritten.</p>
      <div class="list-plain" style="max-height:50vh;overflow:auto">${c.items.map(i => `<div class="li">${ui.tile({ kind: i.kind, path: i.originalPath, name: i.name })}
        <div style="flex:1;min-width:0"><div style="display:flex;gap:6px;align-items:center">${esc(i.name)}${!i.inVault ? '<span class="badge muted">not in Vault</span>' : itemById(i.id)?.status && itemById(i.id).status !== 'ok' ? '<span class="badge danger">missing</span>' : ''}</div>
        <div class="mono muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.originalPath)}">${esc(i.originalPath)}</div></div>
        ${i.present ? `<button class="btn sm" data-restore="${esc(i.id)}" data-to="original">Restore</button><button class="btn sm ghost" data-restore="${esc(i.id)}" data-to="folder" title="Restore into a folder you pick">To…</button>` : '<span class="muted" style="font-size:12px">not in backup</span>'}</div>`).join('')}</div>`,
    onOpen: (m, close) => m.addEventListener('click', async e => {
      const b = e.target.closest('[data-restore]');
      if (!b) return;
      let targetFolder = null;
      if (b.dataset.to === 'folder') { [targetFolder] = await pickPaths('folder', false, 'Restore into which folder?'); if (!targetFolder) return; }
      try {
        await post('/api/backups/restore', { folder, itemId: b.dataset.restore, target: b.dataset.to, targetFolder });
        close(null);
        ui.toast('Restoring…', { type: 'busy', timeout: 2500 });
      } catch (err) { ui.toast(err.message, { type: 'error' }); }
    }),
    actions: [
      { label: 'Import library', icon: 'import', left: true, onClick: async () => {
        const n = c.items.filter(i => !i.inVault).length;
        if (!await ui.confirm({ title: 'Import this backup\'s library?', message: `Adds the items, links, notes and collections from this backup that aren't in Vault right now (${n} tracked item${n === 1 ? '' : 's'} missing from Vault, plus any links and notes). Nothing already in Vault is changed.`, confirmLabel: 'Import' })) return false;
        const r = await post('/api/backups/import', { folder });
        ui.toast(`Imported ${r.items} item${r.items === 1 ? '' : 's'} and ${r.collections} collection${r.collections === 1 ? '' : 's'}`, { type: 'ok' });
        refresh();
      } },
      { label: 'Close', kind: 'primary' },
    ],
  });
}

async function deleteBackup(b) {
  const ok = await ui.confirm({
    title: 'Delete this backup?',
    html: `<p>This permanently deletes the ${b.mode === 'mirror' ? 'mirror' : 'snapshot'} from ${esc(ui.fmtDate(b.at))}${b.bytes ? ` (${ui.fmtBytes(b.bytes)})` : ''}. It can't be undone. Your original files aren't touched.</p><p class="mono" style="font-size:12px">${esc(b.folder)}</p>`,
    confirmLabel: 'Delete backup', danger: true,
  });
  if (!ok) return;
  try { await post('/api/backups/delete', { folder: b.folder }); ui.toast('Backup deleted', { type: 'ok' }); }
  catch (e) { ui.toast(e.message, { type: 'error' }); }
  reloadList();
}

async function purgeOld() {
  const snaps = (BK.list || []).filter(b => b.mode === 'snapshot' && b.exists && b.status !== 'running');
  let keep = 3;
  const plan = () => {
    const byDest = {};
    for (const b of snaps) (byDest[b.dest.toLowerCase()] ||= []).push(b);
    return Object.values(byDest).flatMap(list => list.sort((x, y) => (y.at || '').localeCompare(x.at || '')).slice(keep));
  };
  const summary = () => { const p = plan(); return p.length ? `Deletes <b>${p.length}</b> older snapshot${p.length > 1 ? 's' : ''}, freeing about <b>${ui.fmtBytes(p.reduce((s, b) => s + (b.bytes || 0), 0))}</b>.` : 'Nothing to delete with that setting.'; };
  const r = await ui.modal({
    title: 'Clean up old snapshots',
    body: `<p>Keep the newest snapshots on each drive and permanently delete the rest. Mirrors aren't affected.</p>
      <div class="row-field"><div class="grow"><div class="t">Snapshots to keep per drive</div></div><input type="number" class="input" id="keepN" value="${keep}" min="1" max="50" style="width:80px"></div>
      <p id="purgeSum" style="margin-top:10px">${summary()}</p>`,
    onOpen: m => m.querySelector('#keepN').addEventListener('input', e => { keep = Math.max(1, +e.target.value || 1); m.querySelector('#purgeSum').innerHTML = summary(); }),
    actions: [{ label: 'Cancel', value: null }, { label: 'Delete old snapshots', kind: 'danger', value: 'go' }],
  });
  if (r !== 'go') return;
  const victims = plan();
  let n = 0;
  for (const b of victims) { try { await post('/api/backups/delete', { folder: b.folder }); n++; } catch (e) { ui.toast(e.message, { type: 'error' }); } }
  ui.toast(`Deleted ${n} old snapshot${n === 1 ? '' : 's'}`, { type: 'ok' });
  reloadList();
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const el = onPage();
  if (!el || !el.contains(e.target)) return;
  const t = e.target;
  const drive = t.closest('[data-dest]');
  if (drive) { BK.dest = drive.dataset.dest; BK.customDest = false; draw(); return estimate(); }
  const mode = t.closest('[data-mode]');
  if (mode) { BK.mode = mode.dataset.mode; draw(); return updateEst(); }
  const scope = t.closest('[data-scope]');
  if (scope) {
    const s = scope.dataset.scope;
    if (s === 'all') BK.scope = { type: 'all' };
    if (s === 'collection') BK.scope = { type: 'collection', id: BK.scope.type === 'collection' ? BK.scope.id : S.collections[0]?.id || null };
    draw(); return estimate();
  }
  const a = t.closest('[data-act]');
  if (!a) return;
  const row = t.closest('tr[data-folder]');
  const b = row ? BK.list.find(x => x.folder === row.dataset.folder) : null;
  switch (a.dataset.act) {
    case 'pick-dest': {
      const [p] = await pickPaths('folder', false, 'Back up into which folder?');
      if (p) { BK.dest = p; BK.customDest = true; draw(); estimate(); }
      return;
    }
    case 'start': {
      a.disabled = true;
      try { await post('/api/backup/start', { scope: scopeObj(), dest: BK.dest, mode: BK.mode }); }
      catch (err) { ui.toast(err.message, { type: 'error' }); a.disabled = false; }
      return;
    }
    case 'cancel': return post(`/api/jobs/${a.dataset.id}/cancel`).catch(() => {});
    case 'open-folder': return post('/api/open', { path: a.dataset.folder || b?.folder, how: 'folder' }).catch(err => ui.toast(err.message, { type: 'error' }));
    case 'refresh-list': return reloadList();
    case 'browse': return b && browse(b.folder);
    case 'delete-backup': return b && deleteBackup(b);
    case 'purge-old': return purgeOld();
    case 'auto-dest-current': return saveAuto({ dest: BK.dest });
  }
});

document.addEventListener('change', e => {
  const el = onPage();
  if (!el || !el.contains(e.target)) return;
  if (e.target.id === 'scopeCol') { BK.scope = { type: 'collection', id: e.target.value || null }; return estimate(); }
  const k = e.target.dataset.auto;
  if (!k) return;
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  saveAuto({ [k]: v });
});
