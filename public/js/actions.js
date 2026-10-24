// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Everything you can do to items: add, open, edit, move, remove, delete, relink, restore.
import { S, refresh, openItem, closeViewer, itemById, collectionById, parseHash, go, isUnavailable } from './state.js';
import { get, post } from './api.js';
import * as ui from './ui.js';
const { esc, icon } = ui;

const TEXTY = new Set(['code', 'text', 'md']);

export async function openWith(item, how, rel) {
  try { await post('/api/open', { id: item.id, how, rel }); }
  catch (e) { ui.toast(e.message, { type: 'error' }); }
}

/** Primary click on an item. */
export function activate(item) {
  if (item.kind === 'link') {
    if (/^https?:/i.test(item.url)) window.open(item.url, '_blank', 'noopener');
    else openWith(item, 'default');
    post('/api/items/update', { id: item.id, patch: { opened: true } }).catch(() => {});
    return;
  }
  openItem(item.id);
  post('/api/items/update', { id: item.id, patch: { opened: true } }).catch(() => {});
}

export function currentCollection() {
  const r = parseHash();
  return r.name === 'c' && r.arg !== 'unsorted' ? r.arg : null;
}

export function itemMenu(item, opts = {}) {
  if (item.hidden) return [{ label: 'Unlock with Windows Hello', icon: 'unlock', onClick: () => unlock() }];
  const ok = !isUnavailable(item);
  const colLock = !!collectionById(item.collection)?.locked;
  const disk = item.kind === 'file' || item.kind === 'folder';
  const cat = ui.categoryOf(item).cat;
  return [
    item.kind !== 'link' && !opts.inViewer && { label: item.kind === 'note' ? 'Open note' : 'Open in viewer', icon: 'eye', onClick: () => activate(item) },
    item.kind === 'link' && { label: 'Open link', icon: 'external', onClick: () => activate(item) },
    disk && ok && { label: item.kind === 'folder' ? 'Open in Explorer' : 'Open with default app', icon: 'external', onClick: () => openWith(item, 'default') },
    disk && ok && { label: 'Show in folder', icon: 'folder-open', onClick: () => openWith(item, 'reveal') },
    disk && ok && S.app.vscode && (item.kind === 'folder' || TEXTY.has(cat)) && { label: 'Open in VS Code', icon: 'code', onClick: () => openWith(item, 'vscode') },
    disk && ok && S.app.terminal && item.kind === 'folder' && { label: 'Open terminal here', icon: 'terminal', onClick: () => openWith(item, 'terminal') },
    disk && { label: 'Copy path', icon: 'copy', onClick: () => ui.copyText(item.path, 'Path copied') },
    item.kind === 'link' && { label: 'Copy link', icon: 'copy', onClick: () => ui.copyText(item.url, 'Link copied') },
    item.kind === 'link' && /^https?:/i.test(item.url) && { label: 'Refresh preview', icon: 'refresh', onClick: () => refreshPreview(item) },
    { divider: true },
    { label: 'Edit details…', icon: 'edit', onClick: () => editItem(item) },
    { label: item.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onClick: () => setPinned([item.id], !item.pinned) },
    { label: 'Move to collection', icon: 'layers', sub: moveMenu([item.id]) },
    disk && ok && { label: 'Back up…', icon: 'backup', onClick: () => { S.backupScope = { type: 'items', ids: [item.id] }; closeViewer(); go('backups'); } },
    colLock ? { label: 'Locked with its collection', icon: 'lock', disabled: true }
      : { label: item.locked ? 'Remove lock' : 'Lock with Windows Hello', icon: item.locked ? 'unlock' : 'lock', onClick: () => setLock({ itemIds: [item.id], locked: !item.locked }) },
    disk && !ok && { divider: true },
    disk && !ok && { label: 'Search for it again', icon: 'refresh', onClick: () => searchAgain([item.id]) },
    disk && !ok && { label: 'Locate it myself…', icon: 'locate', onClick: () => relink(item) },
    disk && !ok && { label: 'Restore from a backup…', icon: 'history', onClick: () => restoreFromBackup(item) },
    { divider: true },
    { label: 'Remove from Vault', icon: 'x', onClick: () => removeItems([item.id]) },
    disk && ok && { label: item.kind === 'folder' ? 'Delete folder from disk…' : 'Delete file from disk…', icon: 'trash', danger: true, onClick: () => trashItems([item.id]) },
  ].filter(Boolean);
}

export function moveMenu(ids) {
  return [
    { header: 'Move to' },
    ...S.collections.map(c => ({ label: c.name, color: c.color, onClick: () => moveTo(ids, c.id) })),
    { label: 'Unsorted', icon: 'inbox', onClick: () => moveTo(ids, null) },
    { divider: true },
    { label: 'New collection…', icon: 'plus', onClick: async () => { const c = await editCollection(); if (c) moveTo(ids, c.id); } },
  ];
}

export async function moveTo(ids, collection) {
  await post('/api/items/bulk', { ids, collection });
  const c = collectionById(collection);
  ui.toast(`Moved ${ids.length === 1 ? itemById(ids[0])?.name || '1 item' : ids.length + ' items'} to ${c ? c.name : 'Unsorted'}`, { type: 'ok', timeout: 2500 });
  refresh();
}

export async function setPinned(ids, pinned) { await post('/api/items/bulk', { ids, pinned }); refresh(); }

export async function addTags(ids) {
  const r = await ui.modal({
    title: `Add tags to ${ids.length} item${ids.length > 1 ? 's' : ''}`,
    body: `<div class="field"><label>Tags</label><input class="input" name="tags" placeholder="e.g. school, taxes, mods"><div class="hint">Separate with commas.</div></div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Add tags', kind: 'primary', onClick: m => m.querySelector('[name=tags]').value }],
  });
  if (r) { await post('/api/items/bulk', { ids, addTags: r.split(',') }); refresh(); }
}

function collectionOptions(selected) {
  return `<option value="">Unsorted</option>` + S.collections.map(c => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

export async function editItem(item) {
  const disk = item.kind === 'file' || item.kind === 'folder';
  await ui.modal({
    title: 'Edit details',
    body: `
      <div class="field"><label>Name</label><input class="input" name="name" value="${esc(item.name)}" ${disk ? `placeholder="${esc(ui.basename(item.path))}"` : ''}>
        ${disk ? `<div class="hint">A custom name only changes how it shows in Vault. The file itself isn't renamed.</div>` : ''}</div>
      ${item.kind === 'link' ? `<div class="field"><label>URL</label><input class="input" name="url" value="${esc(item.url)}"></div>` : ''}
      <div class="form-grid field">
        <div><label class="field-label">Collection</label><select class="input" name="collection">${collectionOptions(item.collection)}</select></div>
        <div><label class="field-label" style="display:flex;align-items:center">Tags${S.app.ai?.enabled !== false ? `<button type="button" class="btn sm ghost" data-suggest style="margin-left:auto;height:22px;padding:0 6px;font-size:12px">${icon('sparkle')}Suggest</button>` : ''}</label><input class="input" name="tags" value="${esc((item.tags || []).join(', '))}" placeholder="comma, separated"></div>
      </div>
      <div class="field"><label>Description</label><textarea class="input" name="description" rows="3" style="font-family:var(--sans)" placeholder="What is this? Anything worth remembering?">${esc(item.description || '')}</textarea></div>
      ${disk ? `<div class="field"><label>Location</label><div class="mono muted" style="font-size:12px;word-break:break-all">${esc(item.path)}</div></div>` : ''}`,
    onOpen: m => m.querySelector('[data-suggest]')?.addEventListener('click', async e => {
      const b = e.currentTarget;
      b.disabled = true;
      b.innerHTML = `${icon('loader', 'spin')}Thinking…`;
      try {
        const { suggestTags } = await import('./ai.js');
        const tags = await suggestTags(item.id);
        const input = m.querySelector('[name=tags]');
        const cur = input.value.split(',').map(t => t.trim()).filter(Boolean);
        input.value = [...new Set([...cur, ...tags])].join(', ');
        b.innerHTML = `${icon('check')}Added`;
      } catch (err) { ui.toast(err.message, { type: 'error' }); b.disabled = false; b.innerHTML = `${icon('sparkle')}Suggest`; }
    }),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', kind: 'primary', onClick: async m => {
          const v = n => m.querySelector(`[name=${n}]`)?.value;
          const patch = { name: v('name'), collection: v('collection') || null, tags: v('tags'), description: v('description') };
          if (item.kind === 'link') patch.url = v('url');
          await post('/api/items/update', { id: item.id, patch });
          refresh();
        },
      },
    ],
  });
}

export async function editCollection(col) {
  let color = col?.color || ui.COLORS[S.collections.length % ui.COLORS.length];
  return ui.modal({
    title: col ? 'Edit collection' : 'New collection',
    body: `<div class="field"><label>Name</label><input class="input" name="name" value="${esc(col?.name || '')}" placeholder="e.g. School, Game mods, Taxes"></div>
      <div class="field"><label>Colour</label><div class="colors">${ui.COLORS.map(c => `<button type="button" data-color="${c}" class="${c === color ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div></div>
      <div class="row-field" style="margin-top:14px"><div class="grow"><div class="t">${icon('lock')} Lock with Windows Hello</div><div class="d">Hides everything in this collection until you unlock with your PIN, fingerprint or face.</div></div><input type="checkbox" class="switch" name="locked" ${col?.locked ? 'checked' : ''}></div>`,
    onOpen: m => m.querySelector('.colors').addEventListener('click', e => {
      const b = e.target.closest('[data-color]');
      if (!b) return;
      color = b.dataset.color;
      ui.$$('.colors button', m).forEach(x => x.classList.toggle('on', x === b));
    }),
    actions: [
      col && { label: 'Delete', kind: 'ghost', left: true, onClick: async (m, close) => {
        close(null);
        const n = S.items.filter(i => i.collection === col.id).length;
        if (await ui.confirm({ title: `Delete “${col.name}”?`, message: n ? `Its ${n} item${n > 1 ? 's' : ''} move to Unsorted. No files are touched.` : 'No files are touched.', confirmLabel: 'Delete collection', danger: true })) {
          await post('/api/collections', { action: 'delete', id: col.id });
          if (parseHash().arg === col.id) go('all');
          refresh();
        }
        return false;
      } },
      { label: 'Cancel', value: null },
      { label: col ? 'Save' : 'Create', kind: 'primary', onClick: async m => {
        const name = m.querySelector('[name=name]').value.trim();
        if (!name) throw new Error('Give it a name');
        const r = col ? await post('/api/collections', { action: 'update', id: col.id, name, color })
                      : await post('/api/collections', { action: 'create', name, color });
        const wantLock = m.querySelector('[name=locked]').checked;
        const target = col || r;
        if (wantLock !== !!col?.locked) await setLock({ collectionId: target.id, locked: wantLock });
        refresh();
        return target;
      } },
    ].filter(Boolean),
  });
}

export async function removeItems(ids) {
  const items = ids.map(itemById).filter(Boolean);
  if (!items.length) return;
  const ok = await ui.confirm({
    title: items.length === 1 ? `Remove “${items[0].name}” from Vault?` : `Remove ${items.length} items from Vault?`,
    message: items.some(i => i.kind === 'note') ? 'Files on disk are not touched. Notes are deleted (they only live in Vault).' : 'Your files stay exactly where they are. Vault just stops keeping track of them.',
    confirmLabel: 'Remove',
  });
  if (!ok) return;
  await post('/api/items/remove', { ids });
  for (const id of ids) S.selected.delete(id);
  if (ids.includes(parseHash().view)) closeViewer();
  ui.toast(items.length === 1 ? `Removed ${items[0].name}` : `Removed ${items.length} items`, { type: 'ok', timeout: 2500 });
  refresh();
}

/** Delete the real files: Recycle Bin, with a second, explicit step for drives that don't have one. */
export async function trashItems(ids) {
  const items = ids.map(itemById).filter(i => i && (i.kind === 'file' || i.kind === 'folder') && !isUnavailable(i));
  if (!items.length) return ui.toast('Nothing on disk to delete in that selection', { type: 'warn' });
  const ok = await ui.confirm({
    title: items.length === 1 ? `Delete “${items[0].name}”?` : `Delete ${items.length} items from disk?`,
    html: `<p>This sends ${items.length === 1 ? 'it' : 'them'} to the <b>Recycle Bin</b>, so you can still get ${items.length === 1 ? 'it' : 'them'} back from there.</p>
      <div class="list-plain">${items.slice(0, 8).map(i => `<div class="li">${ui.tile(i)}<span class="mono" title="${esc(i.path)}">${esc(i.path)}</span></div>`).join('')}${items.length > 8 ? `<div class="muted">…and ${items.length - 8} more</div>` : ''}</div>`,
    confirmLabel: 'Move to Recycle Bin', danger: true,
  });
  if (!ok) return;
  const busy = ui.toast('Deleting…', { type: 'busy', sticky: true });
  let res;
  try { res = await post('/api/items/trash', { ids: items.map(i => i.id) }); } finally { busy.close(); }
  const done = res.results.filter(r => r.ok);
  const needPerm = res.results.filter(r => r.needsPermanent);
  const failed = res.results.filter(r => !r.ok && !r.needsPermanent);
  if (done.length) ui.toast(`Moved ${done.length === 1 ? done[0].name : done.length + ' items'} to the Recycle Bin`, { type: 'ok' });
  for (const f of failed) ui.toast(`${f.name}: ${f.message}`, { type: 'error', timeout: 8000 });
  if (needPerm.length) {
    const sure = await ui.confirm({
      title: 'No Recycle Bin on that drive',
      html: `<p>${needPerm.length === 1 ? `<b>${esc(needPerm[0].name)}</b> is` : `${needPerm.length} items are`} on a removable or network drive, which has no Recycle Bin. Deleting is <b>permanent</b> and can't be undone.</p>`,
      confirmLabel: 'Delete permanently', danger: true,
    });
    if (sure) {
      const r2 = await post('/api/items/trash', { ids: needPerm.map(r => r.id), permanent: true });
      const ok2 = r2.results.filter(r => r.ok);
      if (ok2.length) ui.toast(`Permanently deleted ${ok2.length} item${ok2.length > 1 ? 's' : ''}`, { type: 'ok' });
      for (const f of r2.results.filter(r => !r.ok)) ui.toast(`${f.name}: ${f.message}`, { type: 'error', timeout: 8000 });
    }
  }
  for (const id of ids) S.selected.delete(id);
  if (ids.includes(parseHash().view)) closeViewer();
  refresh();
}

export async function searchAgain(ids) {
  ui.toast('Looking for it…', { type: 'info', timeout: 2500 });
  await post('/api/items/check', { ids });
  refresh();
}

export async function pickPaths(mode, multi = true, title = '') {
  const hint = ui.toast(`A Windows ${mode === 'folder' ? 'folder' : 'file'} picker is open. If you don't see it, check the taskbar.`, { type: 'busy', sticky: true });
  try { return (await post('/api/pick', { mode, multi, title })).paths || []; }
  catch (e) { ui.toast(e.message, { type: 'error' }); return []; }
  finally { hint.close(); }
}

export async function relink(item) {
  const [p] = await pickPaths(item.kind === 'folder' ? 'folder' : 'files', false, `Where is “${item.name}” now?`);
  if (!p) return;
  try { await post('/api/items/relink', { id: item.id, path: p }); ui.toast(`Got it. Tracking ${item.name} at its new spot`, { type: 'ok' }); refresh(); }
  catch (e) { ui.toast(e.message, { type: 'error' }); }
}

export async function useSuggestion(item, p) {
  try { await post('/api/items/relink', { id: item.id, path: p }); ui.toast(`Tracking ${item.name} at ${p}`, { type: 'ok' }); refresh(); }
  catch (e) { ui.toast(e.message, { type: 'error' }); }
}

export async function restoreFromBackup(item) {
  const busy = ui.toast('Looking through your backups…', { type: 'busy', sticky: true });
  let found = [];
  try {
    const list = (await get('/api/backups')).filter(b => b.exists);
    for (const b of list) {
      try {
        const c = await post('/api/backups/contents', { folder: b.folder });
        const e = c.items.find(i => i.id === item.id && i.present);
        if (e) found.push({ ...b, entry: e });
      } catch {}
    }
  } finally { busy.close(); }
  if (!found.length) return ui.toast(`No backup on a connected drive has a copy of ${item.name}`, { type: 'warn', timeout: 6000 });
  let choice = 0;
  const r = await ui.modal({
    title: `Restore “${item.name}”`,
    body: `<p>Pick a backup to restore from. It's copied back to <span class="mono">${esc(item.path)}</span>${item.status === 'missing' ? '' : ' (or next to it, if something is already there)'}.</p>
      <div class="list-plain" id="rb">${found.map((b, i) => `<label class="li" style="cursor:pointer"><input type="radio" name="b" value="${i}" ${i === 0 ? 'checked' : ''}>
        <span style="flex:1">${esc(ui.fmtDate(b.at))} <span class="muted">· ${b.mode === 'mirror' ? 'Mirror' : 'Snapshot'} · ${esc(b.dest)}</span></span></label>`).join('')}</div>`,
    onOpen: m => m.querySelector('#rb').addEventListener('change', e => { choice = +e.target.value; }),
    actions: [{ label: 'Cancel', value: null }, { label: 'Restore', kind: 'primary', icon: 'history', value: 'go' }],
  });
  if (r !== 'go') return;
  try {
    await post('/api/backups/restore', { folder: found[choice].folder, itemId: item.id, target: 'original' });
    ui.toast(`Restoring ${item.name}…`, { type: 'busy', timeout: 3000 });
  } catch (e) { ui.toast(e.message, { type: 'error' }); }
}

// ---------- adding ----------
export async function addFlow(mode, prefill = []) {
  if (mode === 'link') return addLink();
  if (mode === 'note') {
    const n = await post('/api/items/add-note', { collection: currentCollection() });
    await refresh();
    return openItem(n.id);
  }
  let paths = prefill;
  if (mode === 'files' || mode === 'folder') {
    paths = await pickPaths(mode, true, mode === 'folder' ? 'Add folders to Vault' : 'Add files to Vault');
    if (!paths.length) return;
  }
  return addPathsModal(paths, mode === 'paste');
}

async function addPathsModal(paths, editable) {
  const r = await ui.modal({
    title: editable ? 'Add by path' : `Add ${paths.length} item${paths.length > 1 ? 's' : ''}`,
    wide: true,
    body: `
      ${editable
        ? `<div class="field"><label>Paths, one per line</label><textarea class="input" name="paths" rows="5" placeholder="C:\\Users\\you\\Documents\\resume.pdf&#10;D:\\Projects\\my-game">${esc(paths.join('\n'))}</textarea>
           <div class="hint">Tip: in Explorer, hold <kbd>Shift</kbd> and right-click a file or folder, choose <b>Copy as path</b>, then press <kbd>Ctrl</kbd>+<kbd>V</kbd> anywhere in Vault.</div></div>`
        : `<div class="list-plain" style="max-height:220px;overflow:auto">${paths.map(p => `<div class="li">${ui.tile(p, '', /\.[^\\]+$/.test(p) ? null : 'folder')}<span class="mono" title="${esc(p)}">${esc(p)}</span></div>`).join('')}</div>`}
      <div class="form-grid field">
        <div><label class="field-label">Collection</label><select class="input" name="collection">${collectionOptions(currentCollection())}</select></div>
        <div><label class="field-label">Tags</label><input class="input" name="tags" placeholder="optional, comma separated"></div>
      </div>
      <p class="muted" style="margin:14px 0 0;font-size:12.5px">${icon('shield')} Files stay where they are. Vault only links to them and follows them if they move.</p>`,
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Add to Vault', kind: 'primary', onClick: async m => {
        const list = editable ? m.querySelector('[name=paths]').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : paths;
        if (!list.length) throw new Error('Paste at least one path');
        return post('/api/items/add', { paths: list, collection: m.querySelector('[name=collection]').value || null, tags: m.querySelector('[name=tags]').value });
      },
    }],
  });
  if (!r) return;
  await refresh();
  if (r.added.length) ui.toast(`Added ${r.added.length === 1 ? r.added[0].name : r.added.length + ' items'}`, { type: 'ok' });
  if (r.skipped.length) {
    await ui.modal({
      title: `${r.skipped.length} not added`,
      body: `<div class="list-plain">${r.skipped.map(s => `<div class="li"><span class="mono" title="${esc(s.path)}">${esc(s.path)}</span><span class="muted" style="font-size:12.5px">${esc(s.reason)}</span></div>`).join('')}</div>`,
      actions: [{ label: 'OK', kind: 'primary' }],
    });
  }
}

export async function addLink(prefill = {}) {
  const r = await ui.modal({
    title: prefill.url ? 'Save this site' : 'Add a link',
    body: `<div class="field"><label>URL</label><input class="input" name="url" placeholder="https://…" value="${esc(prefill.url || '')}" autofocus></div>
      <div class="field"><label>Name</label><input class="input" name="name" placeholder="optional: Vault uses the site's own title" value="${esc(prefill.name || '')}"></div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">${icon('globe')} Vault saves the site's title, description and preview image so you can recognise it later.</p>
      <div class="form-grid field">
        <div><label class="field-label">Collection</label><select class="input" name="collection">${collectionOptions(currentCollection())}</select></div>
        <div><label class="field-label">Tags</label><input class="input" name="tags" placeholder="optional"></div>
      </div>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Add link', kind: 'primary', onClick: m => {
      const v = n => m.querySelector(`[name=${n}]`).value;
      return post('/api/items/add-link', { url: v('url'), name: v('name'), collection: v('collection') || null, tags: v('tags') });
    } }],
  });
  if (r) { ui.toast(`Saved ${r.name}. Fetching its preview…`, { type: 'ok' }); refresh(); }
}

export async function refreshPreview(item) {
  const t = ui.toast('Fetching preview…', { type: 'busy', sticky: true });
  try {
    const it = await post(`/api/items/${encodeURIComponent(item.id)}/preview`);
    if (it.meta?.error) ui.toast(it.meta.error, { type: 'warn' }); else ui.toast('Preview updated', { type: 'ok', timeout: 2000 });
    refresh();
  } catch (e) { ui.toast(e.message, { type: 'error' }); } finally { t.close(); }
}

// ---------- Windows Hello lock ----------
export async function unlock() {
  const t = ui.toast('Windows Hello is asking for your PIN (or fingerprint / face)…', { type: 'busy', sticky: true });
  try {
    const r = await post('/api/lock/unlock');
    if (r.ok) { ui.toast('Unlocked', { type: 'ok', timeout: 2000 }); await refresh(); return true; }
    if (r.result !== 'Canceled') ui.toast(r.message, { type: 'warn', timeout: 9000 });
    return false;
  } catch (e) { ui.toast(e.message, { type: 'error' }); return false; }
  finally { t.close(); }
}

export async function lockNow() { await post('/api/lock/lock'); ui.toast('Locked', { type: 'ok', timeout: 1500 }); refresh(); }

export async function setLock({ itemIds, collectionId, locked }) {
  try {
    if (locked && !S.app.lock?.any) {
      const ok = await ui.confirm({
        title: 'Lock with Windows Hello',
        html: `<p>Locked things are hidden in Vault (names, locations and contents) until you unlock with your Windows PIN, fingerprint or face. Vault locks again after ${S.app.lock?.minutes || 5} idle minutes, or when you click the lock button.</p><p class="muted" style="font-size:13px">This is a privacy screen inside Vault. The files themselves aren't encrypted, so they're still visible in Explorer.</p>`,
        confirmLabel: 'Lock it',
      });
      if (!ok) return false;
    }
    if (!locked && !S.app.lock?.unlocked && !(await unlock())) return false;
    await post('/api/lock/set', { itemIds, collectionId, locked });
    ui.toast(locked ? 'Locked' : 'Lock removed', { type: 'ok', timeout: 2500 });
    refresh();
    return true;
  } catch (e) { ui.toast(e.message, { type: 'error' }); return false; }
}

export function addMenu(anchor) {
  ui.menu(anchor, [
    { label: 'Files…', icon: 'file-plus', onClick: () => addFlow('files') },
    { label: 'Folders…', icon: 'folder-plus', onClick: () => addFlow('folder') },
    { label: 'Paste a path…', icon: 'clipboard', onClick: () => addFlow('paste') },
    { divider: true },
    { label: 'Link', icon: 'link', onClick: () => addFlow('link') },
    { label: 'Note', icon: 'note', onClick: () => addFlow('note') },
  ], { align: 'right' });
}
