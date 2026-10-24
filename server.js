// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Vault - a local home for your important files, folders, links and notes.
// Run: node server.js [--port 4477] [--data <dir>] [--open]
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, newId, defaultSettings } from './lib/store.js';
import { Tracker } from './lib/tracker.js';
import { Backups, fmtBytes } from './lib/backup.js';
import { Storage } from './lib/storage.js';
import { fetchPreview, removeThumbs, THUMB_RE } from './lib/links.js';
import { candidates as reinstallCandidates } from './lib/reinstall.js';
import { Ai } from './lib/ai.js';
import { Native } from './lib/native.js';
import * as files from './lib/files.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const PORT = Number(arg('port', 4477));
const DATA_DIR = path.resolve(arg('data', path.join(APP_DIR, 'data')));
const OPEN = argv.includes('--open');
const PUBLIC = path.join(APP_DIR, 'public');
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

fs.mkdirSync(DATA_DIR, { recursive: true });
const logFile = path.join(DATA_DIR, 'vault.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  process.stdout.write(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, line);
  } catch {}
}
console.error = (...a) => log('ERROR', ...a.map(x => x?.stack || x));

// ---------- events (Server-Sent Events) ----------
const clients = new Set();
let ai = null; // set up below; 'items' changes nudge its search index
function emit(type, data = {}) {
  if (type === 'items' && ai) ai.scheduleIndex();
  // Never leak a locked item's name or location through live events.
  if (type === 'moved' && data.id) {
    const it = store.item(data.id);
    if (it && isHidden(it)) data = { id: data.id, name: 'A locked item', to: 'somewhere new', how: data.how };
  }
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

const store = new Store(DATA_DIR);
const native = new Native(APP_DIR, log);
const tracker = new Tracker({ store, native, emit });
const storage = new Storage({ store, native, emit, dataDir: DATA_DIR, tracker });
const backups = new Backups({ store, emit, tracker, appDir: APP_DIR, dataDir: DATA_DIR, atimeEnabled: () => storage.atimeEnabled() });
const THUMBS = path.join(DATA_DIR, 'thumbs');
ai = new Ai({ store, emit, dataDir: DATA_DIR, isLocked: i => itemLocked(i) });

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(json);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) { size += c.length; if (size > 5e6) throw new HttpError(413, 'Request too large'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Invalid JSON'); }
}

/** Accepts "C:\x", quoted paths, file:/// URLs. */
function cleanPath(p) {
  let s = String(p || '').trim().replace(/^["']|["']$/g, '').trim();
  if (/^file:\/\//i.test(s)) { try { s = fileURLToPath(s); } catch {} }
  s = s.replace(/\//g, '\\');
  if (!path.isAbsolute(s)) return null;
  s = path.resolve(s);
  return s.length > 3 ? s.replace(/\\+$/, '') : s;
}

const sameText = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
const tidyTags = tags => [...new Set((Array.isArray(tags) ? tags : String(tags || '').split(','))
  .map(t => String(t).trim().replace(/^#/, '')).filter(Boolean).map(t => t.slice(0, 40)))].slice(0, 30);
const validCollection = id => (id && store.collections.some(c => c.id === id) ? id : null);

function itemOr404(id) {
  const item = store.item(id);
  if (!item) throw new HttpError(404, 'No such item');
  return item;
}

// ---------- Windows Hello lock ----------
// Locked items and collections are hidden from the browser (names, paths, contents) until you unlock
// with Windows Hello (PIN, fingerprint or face). It's a privacy screen inside Vault: the files on disk
// aren't encrypted. Unlocking lasts a few minutes and is extended while you use locked items.
const lock = { until: 0, hello: null, prompting: false };
const lockMinutes = () => Math.max(1, Number(store.settings.lockMinutes) || 5);
const isUnlocked = () => Date.now() < lock.until;
const colLocked = id => !!(id && store.collections.find(c => c.id === id)?.locked);
const itemLocked = i => !!(i.locked || colLocked(i.collection));
const isHidden = i => itemLocked(i) && !isUnlocked();
const shownName = i => (isHidden(i) ? 'a locked item' : i.name);
const HELLO_HELP = {
  NotConfiguredForUser: 'Windows Hello isn\'t set up. Add a PIN in Windows Settings > Accounts > Sign-in options.',
  DeviceNotPresent: 'No Windows Hello device is available on this PC.',
  DisabledByPolicy: 'Windows Hello is turned off by a policy on this PC.',
  DeviceBusy: 'Windows Hello is busy. Try again in a moment.',
};
function redact(i) {
  return { id: i.id, kind: i.kind, name: 'Locked item', hidden: true, locked: true, collection: i.collection, pinned: i.pinned, addedAt: i.addedAt, status: 'ok' };
}
/** Throws 423 for locked items while Vault is locked; using a locked item keeps the unlock alive. */
function access(item) {
  if (isHidden(item)) throw new HttpError(423, 'This is locked. Unlock with Windows Hello first.');
  if (itemLocked(item)) lock.until = Date.now() + lockMinutes() * 60000;
  return item;
}
const itemOpen = id => access(itemOr404(id));
setInterval(() => { if (lock.until && !isUnlocked()) { lock.until = 0; emit('items'); } }, 10000).unref();

/** Resolve a path inside a tracked item. For single-file items, only the file itself (plus sibling
 *  images, so a Markdown file's pictures show up). */
function itemPath(item, rel) {
  if (item.kind === 'folder') {
    const abs = files.safeJoin(item.path, rel || '');
    if (!abs) throw bad('Bad path');
    return abs;
  }
  if (item.kind !== 'file') throw bad('This item has no files');
  if (!rel || sameText(rel, path.basename(item.path))) return item.path;
  const abs = files.safeJoin(path.dirname(item.path), rel);
  if (!abs || files.kindOf(abs) !== 'image') throw new HttpError(403, 'Only the tracked file can be viewed');
  return abs;
}

async function addPaths(paths, { collection, tags }) {
  const added = [], skipped = [];
  for (const raw of paths) {
    const p = cleanPath(raw);
    if (!p) { skipped.push({ path: raw, reason: 'Not a full path (should start like C:\\...)' }); continue; }
    const dupe = store.items.find(i => i.path && sameText(i.path, p));
    if (dupe) { skipped.push({ path: p, reason: `Already in Vault as "${shownName(dupe)}"` }); continue; }
    let f;
    try { f = await tracker.fingerprint(p); } catch (e) { skipped.push({ path: p, reason: e.code === 'ENOENT' ? 'Not found' : e.message }); continue; }
    const sameThing = store.items.find(i => i.fp?.ino && i.fp.ino === f.fp.ino && i.fp.dev === f.fp.dev);
    if (sameThing) { skipped.push({ path: p, reason: `Already in Vault as "${shownName(sameThing)}"` }); continue; }
    const at = new Date().toISOString();
    const item = {
      id: newId(), kind: f.kind, name: path.basename(p) || p, customName: false, path: p,
      collection: validCollection(collection), tags: tidyTags(tags), description: '', pinned: false,
      addedAt: at, modifiedAt: new Date(f.fp.mtimeMs).toISOString(), fp: f.fp, status: 'ok', statusSince: at, lastSeen: at,
    };
    store.items.push(item);
    added.push(item);
  }
  if (added.length) {
    store.log('add', added.length === 1 ? `Added ${added[0].name}` : `Added ${added.length} items`, added.length === 1 ? { itemId: added[0].id } : {});
    store.save();
    emit('items');
  }
  return { added, skipped };
}

let driveCache = { at: 0, list: [] };
async function drives(force) {
  if (force || Date.now() - driveCache.at > 10000) {
    try { driveCache = { at: Date.now(), list: await native.drives() }; } catch (e) { log('drives', e.message); }
  }
  return driveCache.list;
}

function findExe(candidates) { return candidates.find(c => c && fs.existsSync(c)); }
const vscodeExe = () => findExe([
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
]);
const terminalExe = () => findExe([path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe')]);

function detached(exe, args) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', e => log('spawn failed', exe, e.message));
  child.unref();
}

const shortcutPaths = () => ({
  desktop: path.join(os.homedir(), 'Desktop', 'Vault.lnk'),
  startup: path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Vault.lnk'),
});

async function refreshPreview(item) {
  const old = item.meta;
  const meta = await fetchPreview(item.url, THUMBS, item.id);
  const live = store.item(item.id);
  if (!live) return removeThumbs(THUMBS, meta);
  for (const f of [old?.image, old?.icon]) if (f && f !== meta.image && f !== meta.icon) await removeThumbs(THUMBS, { image: f });
  live.meta = meta;
  if (!live.customName && meta.title) live.name = meta.title;
  if (!live.description && meta.description) live.description = '';
  store.save();
  emit('items');
  return live;
}

function stateSnapshot() {
  return {
    items: store.items.map(i => (isHidden(i) ? redact(i) : i)),
    collections: store.collections,
    settings: store.settings,
    tracker: tracker.status(),
    jobs: backups.listJobs(),
    app: {
      version: VERSION, dataDir: DATA_DIR, appDir: APP_DIR, port: PORT, home: os.homedir(), computer: os.hostname(),
      vscode: !!vscodeExe(), terminal: !!terminalExe(), systemDrive: (process.env.SystemDrive || 'C:').toUpperCase(),
      lock: { unlocked: isUnlocked(), until: lock.until, minutes: lockMinutes(), hello: lock.hello, help: HELLO_HELP[lock.hello] || null,
        any: store.collections.some(c => c.locked) || store.items.some(i => i.locked) },
      ai: { enabled: ai.cfg.enabled },
      shortcuts: Object.fromEntries(Object.entries(shortcutPaths()).map(([k, p]) => [k, fs.existsSync(p)])),
    },
  };
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', '/api/ping', () => ({ ok: true, app: 'vault' }));
route('GET', '/api/state', () => stateSnapshot());
route('GET', '/api/activity', () => store.data.activity.slice(0, 300).map(ev => {
  const it = ev.itemId && store.item(ev.itemId);
  return it && isHidden(it) ? { at: ev.at, type: ev.type, message: 'Something changed on a locked item' } : ev;
}));

route('POST', '/api/items/add', async b => addPaths(Array.isArray(b.paths) ? b.paths : [], b));

route('POST', '/api/items/add-link', async b => {
  let url = String(b.url || '').trim();
  if (!url) throw bad('Enter a URL');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  let parsed;
  try { parsed = new URL(url); } catch { throw bad('That URL does not look right'); }
  if (!['http:', 'https:', 'mailto:', 'steam:', 'discord:'].includes(parsed.protocol)) throw bad('Only web links are supported');
  const at = new Date().toISOString();
  const item = {
    id: newId(), kind: 'link', name: String(b.name || '').trim() || parsed.hostname + parsed.pathname.replace(/\/$/, ''),
    customName: !!b.name, url: parsed.href, collection: validCollection(b.collection), tags: tidyTags(b.tags),
    description: String(b.description || ''), pinned: false, addedAt: at, modifiedAt: at, status: 'ok',
  };
  store.items.push(item);
  store.log('add', `Added link ${item.name}`, { itemId: item.id });
  store.save(); emit('items');
  if (/^https?:/i.test(item.url)) refreshPreview(item).catch(e => log('preview', e.message));
  return item;
});

route('POST', '/api/items/add-note', async b => {
  const at = new Date().toISOString();
  const item = {
    id: newId(), kind: 'note', name: String(b.name || '').trim() || 'Untitled note', customName: true, body: String(b.body || ''),
    collection: validCollection(b.collection), tags: tidyTags(b.tags), description: '', pinned: false,
    addedAt: at, modifiedAt: at, status: 'ok',
  };
  store.items.push(item);
  store.log('add', `Created note ${item.name}`);
  store.save(); emit('items');
  return item;
});

route('POST', '/api/items/update', async b => {
  const item = itemOpen(b.id);
  const oldUrl = item.url;
  const p = b.patch || {};
  if ('name' in p) {
    const name = String(p.name || '').trim();
    if (item.kind === 'file' || item.kind === 'folder') {
      item.customName = !!name && name !== path.basename(item.path);
      item.name = name || path.basename(item.path);
    } else item.name = name || item.name;
  }
  if ('collection' in p) item.collection = validCollection(p.collection);
  if ('tags' in p) item.tags = tidyTags(p.tags);
  if ('description' in p) item.description = String(p.description || '').slice(0, 5000);
  if ('pinned' in p) item.pinned = !!p.pinned;
  if ('body' in p && item.kind === 'note') { item.body = String(p.body); item.modifiedAt = new Date().toISOString(); }
  if ('url' in p && item.kind === 'link') { try { item.url = new URL(String(p.url)).href; } catch { throw bad('That URL does not look right'); } }
  if ('opened' in p) item.lastOpened = new Date().toISOString();
  if ('dismissMove' in p) item.moved = null;
  store.save(); emit('items', { quiet: 'opened' in p || 'body' in p });
  if (item.kind === 'link' && item.url !== oldUrl && /^https?:/i.test(item.url)) refreshPreview(item).catch(() => {});
  return item;
});

route('POST', '/api/items/:id/preview', async (b, q, params) => {
  const item = itemOpen(params.id);
  if (item.kind !== 'link' || !/^https?:/i.test(item.url)) throw bad('Only web links have previews');
  return refreshPreview(item);
});

route('POST', '/api/items/bulk', async b => {
  const ids = new Set(b.ids || []);
  const targets = store.items.filter(i => ids.has(i.id) && !isHidden(i));
  for (const item of targets) {
    if ('collection' in b) item.collection = validCollection(b.collection);
    if (b.addTags) item.tags = tidyTags([...(item.tags || []), ...tidyTags(b.addTags)]);
    if ('pinned' in b) item.pinned = !!b.pinned;
  }
  store.save(); emit('items');
  return { updated: targets.length };
});

// Remove from Vault only. The files themselves are not touched.
route('POST', '/api/items/remove', async b => {
  const ids = new Set(b.ids || []);
  if (store.items.some(i => ids.has(i.id) && isHidden(i))) throw new HttpError(423, 'Unlock with Windows Hello to remove locked items');
  const removed = store.items.filter(i => ids.has(i.id));
  for (const i of removed) if (i.kind === 'link') removeThumbs(THUMBS, i.meta);
  store.data.items = store.items.filter(i => !ids.has(i.id));
  if (removed.length) store.log('remove', removed.length === 1 ? `Removed ${removed[0].name} from Vault (files kept)` : `Removed ${removed.length} items from Vault (files kept)`);
  store.save(); emit('items');
  return { removed: removed.length };
});

// Delete the real file/folder: Recycle Bin on fixed drives. Drives without a Recycle Bin
// need permanent:true, which the UI only sends after a second, explicit confirmation.
route('POST', '/api/items/trash', async b => {
  const ids = new Set(b.ids || []);
  if (store.items.some(i => ids.has(i.id) && isHidden(i))) throw new HttpError(423, 'Unlock with Windows Hello to delete locked items');
  const targets = store.items.filter(i => ids.has(i.id) && (i.kind === 'file' || i.kind === 'folder'));
  const list = await drives(true);
  const results = [];
  for (const item of targets) {
    if (!fs.existsSync(item.path)) { results.push({ id: item.id, name: item.name, ok: false, message: 'Not found at its path' }); continue; }
    const root = (/^[a-z]:\\/i.exec(item.path) || [''])[0].toUpperCase();
    const drive = list.find(d => d.root.toUpperCase() === root);
    const hasBin = drive?.type === 'Fixed';
    if (!hasBin && !b.permanent) { results.push({ id: item.id, name: item.name, ok: false, needsPermanent: true, message: 'This drive has no Recycle Bin' }); continue; }
    try {
      if (hasBin) {
        const [r] = await native.recycle([item.path]);
        if (!r.gone) { results.push({ id: item.id, name: item.name, ok: false, message: r.aborted ? 'Cancelled' : `Windows couldn't delete it (code ${r.code}). Is it open somewhere?` }); continue; }
      } else {
        await fsp.rm(item.path, { recursive: true, force: false });
      }
      results.push({ id: item.id, name: item.name, ok: true, recycled: hasBin });
      store.log('purge', hasBin ? `Moved ${item.path} to the Recycle Bin` : `Permanently deleted ${item.path}`);
    } catch (e) { results.push({ id: item.id, name: item.name, ok: false, message: e.message }); }
  }
  const gone = new Set(results.filter(r => r.ok).map(r => r.id));
  store.data.items = store.items.filter(i => !gone.has(i.id));
  store.save(); emit('items');
  return { results };
});

route('POST', '/api/items/check', async b => {
  const ids = b.ids?.length ? b.ids : null;
  await tracker.checkAll({ ids, manual: true });
  return { tracker: tracker.status() };
});

route('POST', '/api/items/relink', async b => {
  const item = itemOpen(b.id);
  const p = cleanPath(b.path);
  if (!p) throw bad('Not a full path');
  await tracker.relink(item, p);
  return item;
});

route('GET', '/api/items/:id/list', async (b, q, params) => {
  const item = itemOpen(params.id);
  if (item.kind !== 'folder') throw bad('Not a folder');
  const abs = itemPath(item, q.get('rel'));
  let entries;
  try { entries = await fsp.readdir(abs, { withFileTypes: true }); }
  catch (e) { throw new HttpError(e.code === 'ENOENT' ? 404 : 500, e.code === 'ENOENT' ? 'Folder not found' : e.message); }
  const out = [];
  for (const d of entries.slice(0, 5000)) {
    const isDir = d.isDirectory() || (d.isSymbolicLink() && await fsp.stat(path.join(abs, d.name)).then(s => s.isDirectory(), () => false));
    let size = null, mtime = null;
    if (!isDir) { try { const st = await fsp.stat(path.join(abs, d.name)); size = st.size; mtime = st.mtimeMs; } catch {} }
    out.push({ name: d.name, dir: isDir, size, mtime, kind: isDir ? 'folder' : files.kindOf(d.name) || 'file' });
  }
  out.sort((a, b2) => (b2.dir - a.dir) || a.name.localeCompare(b2.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { rel: q.get('rel') || '', entries: out, truncated: entries.length > 5000 };
});

route('GET', '/api/items/:id/view', async (b, q, params) => {
  const item = itemOpen(params.id);
  const abs = itemPath(item, q.get('rel'));
  let st;
  try { st = await fsp.stat(abs); } catch { throw new HttpError(404, 'File not found'); }
  if (st.isDirectory()) return { kind: 'folder', name: path.basename(abs), path: abs };
  let kind = files.kindOf(abs);
  if (!kind) kind = (await files.sniffText(abs)) ? 'text' : 'binary';
  const info = { kind, name: path.basename(abs), path: abs, size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, lang: files.langOf(abs) };
  if (kind === 'text' || kind === 'markdown' || kind === 'html') Object.assign(info, await files.readText(abs, kind === 'text' ? 3e6 : 2e6));
  return info;
});

route('POST', '/api/items/:id/folder-size', async (b, q, params) => {
  const item = itemOpen(params.id);
  if (item.kind !== 'folder') throw bad('Not a folder');
  let count = 0, bytes = 0;
  await files.walk(item.path, { onFile: f => { if (!f.dir) { count++; bytes += f.size; } } });
  item.folderStats = { files: count, bytes, at: new Date().toISOString() };
  store.save();
  return item.folderStats;
});

route('POST', '/api/open', async b => {
  const how = b.how || 'default';
  if (how === 'recyclebin') { await native.open('shell:RecycleBinFolder'); return { ok: true }; }
  let target;
  if (b.id) {
    const item = itemOpen(b.id);
    if (item.kind === 'link') target = item.url;
    else target = itemPath(item, b.rel);
    item.lastOpened = new Date().toISOString();
    store.save();
  } else if (b.path && (how === 'reveal' || how === 'folder')) {
    target = cleanPath(b.path);
    // Only open places Vault knows about (backups, the data folder, tracked items).
    const known = [DATA_DIR, APP_DIR, ...store.backups.map(x => x.folder), ...store.items.filter(i => i.path).map(i => i.path),
      ...[...backups.jobs.values()].map(j => j.target).filter(Boolean)];
    const isBackup = target && /\\vault backups(\\|$)/i.test(target);
    const inScan = target && (storage.has(target) || (storage.summary?.roots || []).some(r => target.toLowerCase().startsWith(r.toLowerCase() + '\\')));
    if (!target || !(isBackup || inScan || known.some(k => sameText(k, target) || target.toLowerCase().startsWith(k.toLowerCase() + '\\')))) throw new HttpError(403, 'Unknown location');
  } else throw bad('Nothing to open');
  if (/^https?:|^mailto:|^steam:|^discord:/i.test(target)) { await native.open(target); return { ok: true }; }
  if (!fs.existsSync(target)) throw new HttpError(404, 'Not found');
  if (how === 'reveal') await native.reveal(target);
  else if (how === 'folder') await native.open(fs.statSync(target).isDirectory() ? target : path.dirname(target));
  else if (how === 'vscode') { const exe = vscodeExe(); if (!exe) throw bad('VS Code not found'); detached(exe, [target]); }
  else if (how === 'terminal') {
    const exe = terminalExe(); if (!exe) throw bad('Windows Terminal not found');
    detached(exe, ['-d', fs.statSync(target).isDirectory() ? target : path.dirname(target)]);
  } else await native.open(target);
  return { ok: true };
});

let picking = false;
route('POST', '/api/pick', async b => {
  if (picking) throw bad('A file picker is already open (it may be behind this window)');
  picking = true;
  try { return { paths: await native.pick(b.mode === 'folder' ? 'folder' : 'files', b.multi !== false, b.title || '') }; }
  finally { picking = false; }
});

route('GET', '/api/drives', async () => {
  const list = await drives(true);
  return list.filter(d => d.ready).map(d => ({ ...d, letter: d.root[0] }));
});

route('POST', '/api/collections', async b => {
  const cols = store.collections;
  if (b.action === 'create') {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw bad('Name it first');
    const c = { id: newId(), name, color: b.color || '#818cf8' };
    cols.push(c);
    store.save(); emit('items');
    return c;
  }
  const c = cols.find(x => x.id === b.id);
  if (!c) throw new HttpError(404, 'No such collection');
  if (b.action === 'update') {
    if (b.name) c.name = String(b.name).trim().slice(0, 60);
    if (b.color) c.color = String(b.color).slice(0, 20);
  } else if (b.action === 'delete') {
    store.data.collections = cols.filter(x => x.id !== c.id);
    for (const i of store.items) if (i.collection === c.id) i.collection = null;
  } else if (b.action === 'move') {
    const idx = cols.indexOf(c), to = Math.max(0, Math.min(cols.length - 1, idx + (b.dir < 0 ? -1 : 1)));
    cols.splice(idx, 1); cols.splice(to, 0, c);
  }
  store.save(); emit('items');
  return { ok: true };
});

route('POST', '/api/settings', async b => {
  const s = store.settings, p = b.patch || {};
  if (p.theme && ['system', 'dark', 'light'].includes(p.theme)) s.theme = p.theme;
  if (p.view && ['list', 'grid'].includes(p.view)) s.view = p.view;
  if (p.checkIntervalSec) s.checkIntervalSec = Math.max(15, Math.min(3600, Number(p.checkIntervalSec) || 60));
  if (Array.isArray(p.searchRoots)) s.searchRoots = p.searchRoots.map(cleanPath).filter(Boolean);
  if ('searchOtherDrives' in p) s.searchOtherDrives = !!p.searchOtherDrives;
  if (Array.isArray(p.backupExcludes)) s.backupExcludes = [...new Set(p.backupExcludes.map(x => String(x).trim()).filter(Boolean))];
  if (p.autoBackup) {
    const a = s.autoBackup, q = p.autoBackup;
    if ('enabled' in q) a.enabled = !!q.enabled;
    if (q.every && ['hourly', 'daily', 'weekly'].includes(q.every)) a.every = q.every;
    if ('dest' in q) a.dest = q.dest ? cleanPath(q.dest) || '' : '';
    if (q.mode && ['mirror', 'snapshot'].includes(q.mode)) a.mode = q.mode;
    if (q.keep) a.keep = Math.max(1, Math.min(100, Number(q.keep) || 5));
  }
  if (p.reset === 'searchRoots') s.searchRoots = defaultSettings().searchRoots;
  if (p.lockMinutes) s.lockMinutes = Math.max(1, Math.min(240, Number(p.lockMinutes) || 5));
  store.save(); emit('settings');
  return s;
});

route('POST', '/api/shortcut', async b => {
  const p = shortcutPaths()[b.where];
  if (!p) throw bad('Unknown shortcut');
  if (b.enabled) {
    await native.shortcut(p, native.launcher, b.where === 'startup' ? '--background' : '', APP_DIR, native.icon, 'Vault - your important files in one place');
  } else await fsp.rm(p, { force: true });
  return { ok: true, exists: fs.existsSync(p) };
});

route('POST', '/api/backup/estimate', async b => backups.estimate({ scope: b.scope, dest: b.dest ? cleanPath(b.dest) : null }));
route('POST', '/api/backup/start', async b => backups.startBackup({ scope: b.scope, dest: cleanPath(b.dest), mode: b.mode }));
route('POST', '/api/jobs/:id/cancel', async (b, q, params) => { backups.cancel(params.id); return { ok: true }; });
route('GET', '/api/backups', async () => backups.list(await drives(true)));
route('POST', '/api/backups/contents', async b => {
  const c = await backups.contents(cleanPath(b.folder));
  c.items = c.items.map(i => { const it = store.item(i.id); return it && isHidden(it) ? { ...i, name: 'Locked item', originalPath: '', stored: '', hidden: true } : i; });
  return c;
});
route('POST', '/api/backups/delete', async b => { await backups.remove(cleanPath(b.folder)); return { ok: true }; });
route('POST', '/api/backups/restore-all', async b => backups.startRestoreAll({ folder: cleanPath(b.folder) }));
route('POST', '/api/backups/restore', async b => { const it = store.item(b.itemId); if (it) access(it); return backups.startRestore({
  folder: cleanPath(b.folder), itemId: b.itemId, target: b.target, targetFolder: b.targetFolder ? cleanPath(b.targetFolder) : null,
}); });
route('POST', '/api/backups/import', async b => backups.importLibrary(cleanPath(b.folder)));

// ---------- lock routes ----------
route('POST', '/api/lock/unlock', async () => {
  if (isUnlocked()) return { ok: true, until: lock.until };
  if (lock.prompting) throw bad('A Windows Hello prompt is already open. Check the taskbar.');
  lock.prompting = true;
  let r;
  try { r = await native.hello('Unlock your locked items in Vault'); } finally { lock.prompting = false; }
  if (r !== 'Verified') return { ok: false, result: r, message: HELLO_HELP[r] || (r === 'Canceled' ? 'Cancelled' : `Windows Hello said: ${r}`) };
  lock.until = Date.now() + lockMinutes() * 60000;
  store.log('lock', 'Unlocked with Windows Hello');
  emit('items');
  return { ok: true, until: lock.until };
});
route('POST', '/api/lock/lock', async () => { lock.until = 0; emit('items'); return { ok: true }; });
route('POST', '/api/lock/set', async b => {
  const want = !!b.locked;
  if (!want && !isUnlocked()) throw new HttpError(423, 'Unlock with Windows Hello before removing a lock');
  if (want && lock.hello && lock.hello !== 'Available') throw bad(HELLO_HELP[lock.hello] || 'Windows Hello isn\'t available, so locking would lock you out.');
  if (b.collectionId) {
    const c = store.collections.find(x => x.id === b.collectionId);
    if (!c) throw new HttpError(404, 'No such collection');
    c.locked = want;
  }
  for (const id of b.itemIds || []) { const i = store.item(id); if (i && (want || !isHidden(i))) i.locked = want; }
  store.log('lock', want ? 'Locked items with Windows Hello' : 'Removed a lock');
  store.save(); emit('items');
  return { ok: true };
});

// ---------- local AI (Ollama) ----------
route('GET', '/api/ai/status', async () => ai.status());
route('POST', '/api/ai/settings', async b => {
  const c = ai.cfg;
  for (const k of ['enabled', 'autoIndex']) if (k in b) c[k] = !!b[k];
  if ('model' in b) c.model = b.model ? String(b.model) : null;
  if ('embedModel' in b) c.embedModel = b.embedModel ? String(b.embedModel) : null;
  store.save(); emit('settings');
  return ai.status();
});
route('POST', '/api/ai/index', async b => { ai.updateIndex({ force: !!b.force }).catch(e => log('ai index:', e.message)); return { started: true }; });
route('POST', '/api/ai/pull', async b => {
  const m = String(b.model || '').trim();
  if (!/^[\w.\-/:]+$/.test(m)) throw bad('That model name doesn\'t look right');
  return ai.startPull(m);
});
route('POST', '/api/ai/unload', async () => ai.unload());
route('POST', '/api/ai/start', async () => {
  const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe');
  if (!fs.existsSync(exe)) throw bad('Ollama isn\'t installed. Get it from ollama.com');
  detached('explorer.exe', [exe]); // via Explorer so Ollama gets your current Windows settings (context size etc.)
  return { ok: true };
});
route('POST', '/api/ai/tags', async b => {
  const item = itemOpen(b.itemId);
  let sample = '';
  if (item.kind === 'file' && ['text', 'markdown'].includes(files.kindOf(item.path))) sample = (await files.readText(item.path, 20000).catch(() => ({ text: '' }))).text;
  else if (item.kind === 'folder') sample = 'Contains: ' + (await fsp.readdir(item.path).catch(() => [])).slice(0, 40).join(', ');
  return { tags: await ai.suggestTags(item, sample) };
});

// ---------- storage manager ----------
route('GET', '/api/storage', async () => { await storage.atimeEnabled(); return { ...(await storage.status()), bin: await native.binSize().catch(() => null) }; });
route('POST', '/api/storage/scan', async b => storage.startScan((b.roots || []).map(cleanPath).filter(Boolean)));
route('POST', '/api/storage/cancel', async () => { storage.cancelScan(); storage.cancelMove(); return { ok: true }; });
route('GET', '/api/storage/files', async (b, q) => storage.query({
  basis: q.get('basis') || 'opened', minAge: Number(q.get('minAge')) || 0, maxAge: Number(q.get('maxAge')) || 0, minSize: Number(q.get('minSize')) || 0, cat: q.get('cat') || 'all',
  q: q.get('q') || '', sort: q.get('sort') || 'size', offset: Number(q.get('offset')) || 0, limit: Math.min(500, Number(q.get('limit')) || 200),
}));
route('POST', '/api/storage/duplicates', async () => storage.findDuplicates());
route('POST', '/api/storage/recycle', async b => storage.recycle((b.paths || []).map(cleanPath).filter(Boolean), await drives(true)));
route('POST', '/api/storage/move', async b => storage.startMove((b.paths || []).map(cleanPath).filter(Boolean), cleanPath(b.dest),
  b.track === false ? null : async root => { if (!store.items.some(i => i.path && sameText(i.path, root))) await addPaths([root], { tags: 'archive' }); }));
route('POST', '/api/storage/add', async b => {
  const paths = (b.paths || []).map(cleanPath).filter(Boolean);
  storage.checkKnown(paths);
  return addPaths(paths, b);
});
route('GET', '/api/storage/bin', async () => native.binSize());
route('POST', '/api/storage/empty-bin', async () => {
  const before = await native.binSize().catch(() => null);
  const r = await native.emptyBin();
  store.log('purge', `Emptied the Recycle Bin${before ? ` (${fmtBytes(before.bytes)})` : ''}`);
  return { ...r, after: await native.binSize().catch(() => null) };
});

// ---------- reinstall readiness ----------
route('GET', '/api/reinstall', async () => {
  const sys = (process.env.SystemDrive || 'C:').toUpperCase();
  const onSys = p => !!p && p.toUpperCase().startsWith(sys + '\\');
  const tracked = store.items.filter(i => i.path);
  const covers = p => tracked.find(i => sameText(i.path, p) || p.toLowerCase().startsWith(i.path.toLowerCase() + '\\'));
  const list = await backups.list(await drives());
  const good = list.filter(b => b.exists && !onSys(b.folder) && (b.status === 'complete' || b.status === 'errors'));
  const covered = new Map();
  for (const b of good) for (const id of b.ids || []) if (!covered.has(id)) covered.set(id, b.at);
  const latest = good[0] || null;
  const items = store.items.filter(i => (i.kind === 'file' || i.kind === 'folder') && onSys(i.path)).map(i => {
    const at = covered.get(i.id) || null;
    const hidden = isHidden(i);
    return { id: i.id, kind: i.kind, name: hidden ? 'Locked item' : i.name, path: hidden ? '' : i.path, hidden,
      backedUpAt: at, changedSince: !!(at && i.fp?.mtimeMs && i.fp.mtimeMs > Date.parse(at) + 60000) };
  });
  const cands = (await reinstallCandidates()).map(c => ({ ...c, inVault: !!covers(c.path), onSystemDrive: onSys(c.path) }));
  return {
    systemDrive: sys, items, candidates: cands, latest,
    appsSaved: !!latest?.apps, vaultApp: !!(latest && fs.existsSync(path.join(latest.dest, 'Vault Backups', 'Vault app', 'server.js'))),
    vaultAppPath: latest ? path.join(latest.dest, 'Vault Backups', 'Vault app') : null,
    appOnSystemDrive: onSys(APP_DIR), appDir: APP_DIR,
    linksAndNotes: store.items.filter(i => i.kind === 'link' || i.kind === 'note').length,
  };
});
route('POST', '/api/reinstall/add', async b => {
  const chosen = (await reinstallCandidates()).filter(c => (b.ids || []).includes(c.id));
  let col = store.collections.find(c => c.name === 'Reinstall kit');
  if (!col) { col = { id: newId(), name: 'Reinstall kit', color: '#fb923c' }; store.collections.push(col); }
  return addPaths(chosen.map(c => c.path), { collection: col.id });
});

route('POST', '/api/shutdown', async () => { setTimeout(() => shutdown('requested from the app'), 200); return { ok: true }; });

// ---------- server ----------
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const VENDOR = {
  'marked.js': 'node_modules/marked/lib/marked.umd.js',
  'purify.js': 'node_modules/dompurify/dist/purify.min.js',
  'highlight.js': 'node_modules/@highlightjs/cdn-assets/highlight.min.js',
  'hl-powershell.js': 'node_modules/@highlightjs/cdn-assets/languages/powershell.min.js',
  'hl-dos.js': 'node_modules/@highlightjs/cdn-assets/languages/dos.min.js',
  'hl-dockerfile.js': 'node_modules/@highlightjs/cdn-assets/languages/dockerfile.min.js',
  'hl-dart.js': 'node_modules/@highlightjs/cdn-assets/languages/dart.min.js',
};
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self'; frame-src 'self'; object-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

async function serveStatic(req, res, pathname) {
  let file;
  if (pathname.startsWith('/vendor/')) {
    const v = VENDOR[pathname.slice(8)];
    if (!v) return false;
    file = path.join(APP_DIR, v);
  } else {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    file = files.safeJoin(PUBLIC, rel);
    if (!file) return false;
  }
  let data;
  try { data = await fsp.readFile(file); } catch { return false; }
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': APP_CSP, 'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
  return true;
}

// Only this app's own pages may call the API: blocks DNS rebinding and other sites poking at localhost.
function guard(req, pathname) {
  if (!HOSTS.has(String(req.headers.host || '').toLowerCase())) return 'Unexpected Host header';
  const isApi = pathname.startsWith('/api/') || pathname.startsWith('/f/') || pathname.startsWith('/thumbs/');
  if (!isApi) return null;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'Cross-site request blocked';
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!ORIGINS.has(req.headers.origin)) return 'Cross-origin request blocked';
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return 'JSON only';
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    const blocked = guard(req, pathname);
    if (blocked) return send(res, 403, { error: blocked });

    if (pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }

    // /thumbs/<itemId>-image.png - saved website preview images
    if (pathname.startsWith('/thumbs/') && req.method === 'GET') {
      const name = pathname.slice(8);
      if (!THUMB_RE.test(name)) throw new HttpError(404, 'Not found');
      const owner = store.items.find(i => i.meta && (i.meta.image === name || i.meta.icon === name));
      if (!owner) throw new HttpError(404, 'Not found');
      access(owner);
      const abs = path.join(THUMBS, name);
      let st;
      try { st = await fsp.stat(abs); } catch { throw new HttpError(404, 'Not found'); }
      return files.sendFile(req, res, abs, st, { 'Cache-Control': 'max-age=86400' });
    }

    // /f/<itemId>/<path inside item> - raw file bytes (viewer, PDF, images, media)
    if (pathname.startsWith('/f/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const [, , id, ...rest] = pathname.split('/');
      const item = itemOpen(id);
      const abs = itemPath(item, rest.join('/'));
      let st;
      try { st = await fsp.stat(abs); } catch { throw new HttpError(404, 'File not found'); }
      if (!st.isFile()) throw new HttpError(404, 'Not a file');
      return files.sendFile(req, res, abs, st, { 'X-Frame-Options': 'SAMEORIGIN' });
    }

    // Streaming AI answers (newline-delimited JSON), so text appears as it's written.
    if (req.method === 'POST' && (pathname === '/api/ai/ask' || pathname === '/api/ai/summarize')) {
      const body = await readBody(req);
      let job;
      if (pathname === '/api/ai/summarize') {
        const item = itemOpen(body.itemId);
        let input;
        if (item.kind === 'note') input = { name: item.name, text: item.body || '', kind: 'markdown' };
        else {
          const abs = itemPath(item, body.rel);
          const kind = files.kindOf(abs) || ((await files.sniffText(abs)) ? 'text' : 'binary');
          if (!['text', 'markdown', 'html'].includes(kind)) throw bad('Vault can only summarise text-based files');
          const r = await files.readText(abs, 200000);
          input = { name: path.basename(abs), text: r.text, truncated: r.truncated, kind, lang: files.langOf(abs) };
        }
        job = (send, signal) => ai.summarize(input, send, signal);
      } else {
        const question = String(body.question || '').trim().slice(0, 2000);
        if (!question) throw bad('Ask something first');
        const history = (Array.isArray(body.history) ? body.history : []).slice(-4).map(h => ({ q: String(h.q || '').slice(0, 2000), a: String(h.a || '').slice(0, 6000) }));
        job = (send, signal) => ai.ask({ question, history }, send, signal);
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      const ctrl = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
      const send = o => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
      try { await job(send, ctrl.signal); } catch (e) { if (e.name !== 'AbortError') send({ type: 'error', message: e.message }); }
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = matchRoute(r.pattern, pathname);
        if (!m) continue;
        const body = req.method === 'POST' ? await readBody(req) : {};
        const result = await r.handler(body, url.searchParams, m);
        return send(res, 200, result ?? { ok: true });
      }
      throw new HttpError(404, 'Unknown API route');
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, pathname)) return;
    // SPA fallback
    if (req.method === 'GET' && !path.extname(pathname) && await serveStatic(req, res, '/')) return;
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    // Plain Errors are user-facing problems ("drive not connected"); TypeError etc. are bugs.
    const status = e.status || (e.constructor === Error ? 400 : 500);
    if (status >= 500) log('ERROR', req.method, pathname, e.stack || e.message);
    if (!res.headersSent) send(res, status, { error: e.message || 'Something went wrong' });
    else res.end();
  }
});

function matchRoute(pattern, pathname) {
  const pp = pattern.split('/'), xp = pathname.split('/');
  if (pp.length !== xp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = xp[i];
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

function openBrowser() { native.open(`http://127.0.0.1:${PORT}/`).catch(e => log('open browser failed', e.message)); }

function shutdown(why) {
  log(`Shutting down (${why})`);
  try { store.flush(); } catch {}
  for (const res of clients) res.end();
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', e => log('UNCAUGHT', e.stack || e.message));
process.on('unhandledRejection', e => log('UNHANDLED', e?.stack || e));

server.on('error', async e => {
  if (e.code === 'EADDRINUSE') {
    // Probably already running: just open it.
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`);
      if ((await r.json()).app === 'vault') { log('Vault is already running'); if (OPEN) openBrowser(); process.exit(0); }
    } catch {}
    log(`Port ${PORT} is used by another program. Start with --port <number>.`);
    process.exit(1);
  }
  log('server error', e.stack);
});

try { await native.ensureBuilt(); } catch (e) { log('ERROR building native helper:', e.message); }
native.helloCheck().then(r => { lock.hello = r; }, () => { lock.hello = 'Unavailable'; });
server.listen(PORT, '127.0.0.1', () => {
  log(`Vault running at http://127.0.0.1:${PORT}/  (data: ${DATA_DIR})`);
  try { fs.writeFileSync(path.join(DATA_DIR, 'launch.txt'), `${PORT}\n${process.execPath}\n`); } catch {}
  tracker.start();
  backups.start();
  ai.scheduleIndex(45000);
  if (OPEN) openBrowser();
});
