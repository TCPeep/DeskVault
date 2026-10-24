// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Backups: copy tracked files/folders to any drive or folder.
//
//   <dest>\Vault Backups\2026-10-19 15.30.12\        snapshot (a full copy each time; keeps history)
//   <dest>\Vault Backups\Mirror - <PC name>\         mirror (one copy, only changed files are re-copied)
//
// Each backup folder holds vault-backup.json (what's inside + where it came from + a copy of the
// library) so items can be restored, or the whole library re-imported, even on a fresh install.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { walk } from './files.js';
import { newId } from './store.js';
import { saveAppsList, copyVaultApp, remapHome } from './reinstall.js';

export const BACKUP_DIR = 'Vault Backups';
export const MANIFEST = 'vault-backup.json';
const BIG_FILE = 64 * 1024 * 1024;
const MTIME_SLOP = 2000; // FAT32/exFAT drives store times with 2 s precision

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
const sanitize = s => (String(s || 'item').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120)) || 'item';
const exists = p => fsp.access(p).then(() => true, () => false);

async function freeSpace(dir) {
  try { const s = await fsp.statfs(dir); return s.bavail * s.bsize; } catch { return null; }
}

export async function readManifest(folder) {
  return JSON.parse(await fsp.readFile(path.join(folder, MANIFEST), 'utf8'));
}

function uniqueName(name, taken, isFile) {
  let candidate = name, n = 2;
  const ext = isFile ? path.extname(name) : '';
  const stem = isFile && ext ? name.slice(0, -ext.length) : name;
  while (taken.has(candidate.toLowerCase())) candidate = `${stem} (${n++})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

async function uniquePath(p) {
  if (!(await exists(p))) return p;
  const ext = path.extname(p), stem = ext ? p.slice(0, -ext.length) : p;
  for (let n = 2; ; n++) { const c = `${stem} (${n})${ext}`; if (!(await exists(c))) return c; }
}

export class Backups {
  constructor({ store, emit, tracker, appDir, dataDir, atimeEnabled }) {
    this.store = store;
    this.appDir = appDir;
    this.dataDir = dataDir;
    this.atimeEnabled = atimeEnabled || (async () => false);
    this.emit = emit;
    this.tracker = tracker;
    this.jobs = new Map();
  }

  start() {
    this.timer = setInterval(() => this.autoTick().catch(e => console.error('auto backup', e)), 5 * 60 * 1000);
    setTimeout(() => this.autoTick().catch(() => {}), 30 * 1000);
  }

  running() { return [...this.jobs.values()].find(j => j.state === 'running'); }

  publicJob(j) {
    const { abort, lastEmit, ...rest } = j;
    return { ...rest, errors: j.errors.slice(0, 50), errorCount: j.errors.length };
  }

  update(job, force = false) {
    const t = Date.now();
    if (!force && t - (job.lastEmit || 0) < 250) return;
    job.lastEmit = t;
    this.emit('job', this.publicJob(job));
  }

  listJobs() { return [...this.jobs.values()].map(j => this.publicJob(j)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }

  cancel(id) {
    const j = this.jobs.get(id);
    if (j && j.state === 'running') { j.abort.abort(); j.phase = 'cancelling'; this.update(j, true); }
  }

  scopeItems(scope = { type: 'all' }) {
    let items = this.store.items.filter(i => i.kind === 'file' || i.kind === 'folder');
    if (scope.type === 'collection') items = items.filter(i => (i.collection || null) === (scope.id || null));
    if (scope.type === 'items') { const ids = new Set(scope.ids || []); items = items.filter(i => ids.has(i.id)); }
    return items;
  }

  collectionName(id) {
    return this.store.collections.find(c => c.id === id)?.name || 'Unsorted';
  }

  /** Work out every file to copy. prevMap: item id -> stored path from an earlier mirror. */
  async plan(items, { prevMap = {}, signal, onProgress } = {}) {
    const excludes = this.store.settings.backupExcludes || [];
    const files = [], dirs = [], skipped = [], mapping = {};
    const taken = new Set(Object.values(prevMap).map(s => s.toLowerCase()));
    let bytes = 0;
    for (const item of items) {
      if (signal?.aborted) break;
      let st;
      try { st = await fsp.stat(item.path); } catch { skipped.push({ id: item.id, name: item.name, reason: item.status === 'offline' ? 'drive not connected' : 'not found' }); continue; }
      const stored = prevMap[item.id] || path.join(sanitize(this.collectionName(item.collection)),
        uniqueName(sanitize(path.basename(item.path) || item.name), taken, item.kind === 'file'));
      if (!prevMap[item.id]) taken.add(stored.toLowerCase());
      mapping[item.id] = stored;
      if (item.kind === 'file') {
        files.push({ src: item.path, dst: stored, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
        bytes += st.size;
      } else {
        dirs.push(stored);
        await walk(item.path, {
          exclude: excludes, signal,
          onFile: f => {
            if (f.dir) { dirs.push(path.join(stored, f.rel)); return; }
            files.push({ src: path.join(item.path, f.rel), dst: path.join(stored, f.rel), size: f.size, mtimeMs: f.mtimeMs, atimeMs: f.atimeMs });
            bytes += f.size;
            if (files.length % 500 === 0) onProgress?.(files.length, bytes);
          },
        });
      }
    }
    return { files, dirs, skipped, mapping, bytes };
  }

  async estimate({ scope, dest }) {
    const items = this.scopeItems(scope);
    const p = await this.plan(items);
    const free = dest ? await freeSpace(dest) : null;
    const sameDrive = dest ? items.filter(i => i.path && i.path.slice(0, 2).toLowerCase() === dest.slice(0, 2).toLowerCase()).length : 0;
    return { items: items.length, files: p.files.length, bytes: p.bytes, skipped: p.skipped, free, sameDrive };
  }

  startBackup({ scope = { type: 'all' }, dest, mode = 'snapshot', auto = false }) {
    if (this.running()) throw new Error('Another backup or restore is already running');
    if (!dest || !path.isAbsolute(dest)) throw new Error('Pick where to back up to');
    if (!fs.existsSync(dest)) throw new Error(`${dest} isn't available. Is the drive connected?`);
    if (!['snapshot', 'mirror'].includes(mode)) throw new Error('Unknown backup mode');
    const items = this.scopeItems(scope);
    if (!items.length) throw new Error('Nothing to back up in that selection');
    const job = this.newJob('backup', { mode, dest, auto, scope, title: `${mode === 'mirror' ? 'Mirror' : 'Snapshot'} to ${dest}` });
    this.runBackup(job, items).catch(e => this.fail(job, e));
    return this.publicJob(job);
  }

  newJob(kind, extra) {
    const job = {
      id: newId(), kind, state: 'running', phase: 'scanning', startedAt: new Date().toISOString(), finishedAt: null,
      filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0, copied: 0, unchanged: 0, current: '', errors: [], skipped: [],
      abort: new AbortController(), ...extra,
    };
    this.jobs.set(job.id, job);
    for (const [id, j] of this.jobs) if (j.state !== 'running' && this.jobs.size > 10) this.jobs.delete(id);
    this.update(job, true);
    return job;
  }

  fail(job, e) {
    job.state = 'failed';
    job.phase = 'done';
    job.message = e.message;
    job.finishedAt = new Date().toISOString();
    this.store.log('backup', `${job.kind === 'restore' ? 'Restore' : 'Backup'} failed: ${e.message}`);
    this.update(job, true);
  }

  async runBackup(job, items) {
    const signal = job.abort.signal;
    const base = path.join(job.dest, BACKUP_DIR);
    const folder = job.mode === 'mirror' ? path.join(base, `Mirror - ${sanitize(os.hostname())}`) : path.join(base, stamp(new Date()));
    job.folder = folder;
    let prev = null;
    if (job.mode === 'mirror') { try { prev = await readManifest(folder); } catch {} }
    const prevMap = Object.fromEntries((prev?.items || []).map(i => [i.id, i.stored]));

    const plan = await this.plan(items, { prevMap, signal, onProgress: (n, b) => { job.filesTotal = n; job.bytesTotal = b; this.update(job); } });
    job.filesTotal = plan.files.length;
    job.bytesTotal = plan.bytes;
    job.skipped = plan.skipped;
    if (signal.aborted) return this.finish(job, null);

    await fsp.mkdir(folder, { recursive: true });
    const free = await freeSpace(folder);
    if (job.mode === 'snapshot' && free != null && plan.bytes > free) {
      await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Not enough space: needs ${fmtBytes(plan.bytes)}, ${fmtBytes(free)} free`);
    }

    // For mirrors, keep entries of items that are no longer selected so their stored paths stay reserved.
    const keepPrev = (prev?.items || []).filter(i => !plan.mapping[i.id]);
    const manifest = {
      app: 'vault', format: 1, mode: job.mode, auto: job.auto, computer: os.hostname(), home: os.homedir(),
      createdAt: prev?.createdAt || job.startedAt, updatedAt: job.startedAt, status: 'running',
      items: [
        ...items.filter(i => plan.mapping[i.id]).map(i => ({
          id: i.id, name: i.name, kind: i.kind, collection: this.collectionName(i.collection), tags: i.tags || [],
          originalPath: i.path, stored: plan.mapping[i.id], backedUpAt: job.startedAt,
        })),
        ...keepPrev,
      ],
      library: { collections: this.store.collections, items: this.store.items },
    };
    await this.writeManifest(folder, manifest);

    job.phase = 'copying';
    job.preserveAtime = await this.atimeEnabled();
    await this.copyAll(job, plan, folder, job.mode === 'mirror');

    // Reinstall kit: the installed-apps list, and a runnable copy of Vault on this drive.
    if (!signal.aborted) {
      job.phase = 'extras';
      job.current = 'Saving your apps list and a copy of Vault...';
      this.update(job, true);
      manifest.extras = {};
      try { manifest.extras.apps = await saveAppsList(path.join(folder, '_This PC')); } catch (e) { job.errors.push({ path: 'apps list', message: e.message }); }
      try { this.store.flush(); await copyVaultApp(this.appDir, base, this.dataDir); manifest.extras.vaultApp = true; } catch (e) { job.errors.push({ path: 'Vault app copy', message: e.message }); }
    }

    manifest.status = signal.aborted ? 'cancelled' : job.errors.length ? 'errors' : 'complete';
    manifest.finishedAt = new Date().toISOString();
    manifest.stats = { files: job.filesTotal, bytes: job.bytesTotal, copied: job.copied, unchanged: job.unchanged, errors: job.errors.length };
    await this.writeManifest(folder, manifest);
    await this.finish(job, manifest);
  }

  async writeManifest(folder, manifest) {
    const tmp = path.join(folder, MANIFEST + '.tmp');
    await fsp.writeFile(tmp, JSON.stringify(manifest, null, 1));
    await fsp.rename(tmp, path.join(folder, MANIFEST));
  }

  async copyAll(job, plan, root, skipUnchanged) {
    const signal = job.abort.signal;
    for (const d of plan.dirs) await fsp.mkdir(path.join(root, d), { recursive: true }).catch(e => job.errors.push({ path: d, message: e.message }));
    let i = 0;
    const worker = async () => {
      while (i < plan.files.length && !signal.aborted) {
        const f = plan.files[i++];
        const dst = path.join(root, f.dst);
        job.current = f.src;
        try {
          if (skipUnchanged) {
            const st = await fsp.stat(dst).catch(() => null);
            if (st && st.size === f.size && Math.abs(st.mtimeMs - f.mtimeMs) <= MTIME_SLOP) {
              job.unchanged++; job.filesDone++; job.bytesDone += f.size; this.update(job);
              continue;
            }
          }
          await fsp.mkdir(path.dirname(dst), { recursive: true });
          if (f.size > BIG_FILE) {
            let last = 0;
            const rs = fs.createReadStream(f.src);
            rs.on('data', c => { job.bytesDone += c.length; last += c.length; this.update(job); });
            try { await pipeline(rs, fs.createWriteStream(dst), { signal }); }
            catch (e) { job.bytesDone -= last; await fsp.rm(dst, { force: true }).catch(() => {}); throw e; }
            job.bytesDone -= last; // re-added below
          } else {
            await fsp.copyFile(f.src, dst);
          }
          const mt = new Date(f.mtimeMs);
          await fsp.utimes(dst, mt, mt).catch(() => {});
          // Reading a file counts as "opening" it; put the source's last-opened time back so
          // Storage doesn't think everything was used today. Skipped if it changed meanwhile.
          if (job.preserveAtime && f.atimeMs) {
            const cur = await fsp.stat(f.src).catch(() => null);
            if (cur && cur.mtimeMs === f.mtimeMs) await fsp.utimes(f.src, new Date(f.atimeMs), cur.mtime).catch(() => {});
          }
          job.copied++;
          job.bytesDone += f.size;
        } catch (e) {
          if (signal.aborted) break;
          job.errors.push({ path: f.src, message: e.code === 'EBUSY' ? 'File is in use by another program' : e.message });
        }
        job.filesDone++;
        this.update(job);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  async finish(job, manifest) {
    const cancelled = job.abort.signal.aborted;
    job.state = cancelled ? 'cancelled' : job.errors.length ? 'errors' : 'complete';
    job.phase = 'done';
    job.current = '';
    job.finishedAt = new Date().toISOString();
    if (job.kind === 'backup' && manifest) {
      const entry = {
        folder: job.folder, dest: job.dest, mode: job.mode, auto: job.auto, at: job.finishedAt, status: job.state,
        items: manifest.items.length, files: job.filesTotal, bytes: job.bytesTotal, copied: job.copied, errors: job.errors.length,
        ids: manifest.items.map(i => i.id), apps: !!manifest.extras?.apps?.winget, vaultApp: !!manifest.extras?.vaultApp,
      };
      const list = this.store.data.backups.filter(b => b.folder.toLowerCase() !== job.folder.toLowerCase());
      list.unshift(entry);
      this.store.data.backups = list.slice(0, 200);
      const what = job.mode === 'mirror' ? `Mirror updated (${job.copied} copied, ${job.unchanged} unchanged)` : `Snapshot saved (${job.copied} files, ${fmtBytes(job.bytesTotal)})`;
      this.store.log('backup', `${what} → ${job.folder}${job.errors.length ? ` with ${job.errors.length} errors` : ''}${cancelled ? ' (cancelled)' : ''}`);
      if (job.auto) {
        this.store.settings.autoBackup.lastResult = job.state;
        if (job.mode === 'snapshot' && !cancelled) await this.pruneAuto(job.dest).catch(() => {});
      }
    }
    if (job.kind === 'restore') {
      this.store.log('restore', `Restored ${job.itemName} to ${job.target}${job.errors.length ? ` with ${job.errors.length} errors` : ''}${cancelled ? ' (cancelled)' : ''}`);
      if (!cancelled) await this.afterRestore(job).catch(e => console.error('afterRestore', e));
    }
    this.store.save();
    this.update(job, true);
    this.emit('backups');
  }

  // ---------- auto backup ----------
  async autoTick() {
    const ab = this.store.settings.autoBackup;
    if (!ab?.enabled || !ab.dest || this.running()) return;
    const every = { hourly: 3600e3, daily: 86400e3, weekly: 7 * 86400e3 }[ab.every] || 86400e3;
    if (ab.lastRun && Date.now() - Date.parse(ab.lastRun) < every) return;
    if (!fs.existsSync(ab.dest)) return; // drive not plugged in; try again later
    if (!this.scopeItems().length) return;
    ab.lastRun = new Date().toISOString();
    this.store.save();
    this.startBackup({ scope: { type: 'all' }, dest: ab.dest, mode: ab.mode || 'mirror', auto: true });
  }

  async pruneAuto(dest) {
    const keep = Math.max(1, Number(this.store.settings.autoBackup.keep) || 5);
    const all = (await this.discoverIn(path.join(dest, BACKUP_DIR))).filter(b => b.mode === 'snapshot' && b.auto && b.status !== 'running');
    all.sort((a, b) => b.at.localeCompare(a.at));
    for (const b of all.slice(keep)) await this.remove(b.folder);
  }

  // ---------- listing / discovery ----------
  async discoverIn(base) {
    const out = [];
    let names = [];
    try { names = await fsp.readdir(base); } catch { return out; }
    for (const n of names) {
      const folder = path.join(base, n);
      try {
        const m = await readManifest(folder);
        if (m.app !== 'vault') continue;
        out.push({
          folder, dest: path.dirname(base), mode: m.mode, auto: !!m.auto, at: m.finishedAt || m.updatedAt || m.createdAt,
          status: m.status, items: m.items?.length || 0, files: m.stats?.files, bytes: m.stats?.bytes, computer: m.computer,
          errors: m.stats?.errors || 0, ids: (m.items || []).map(i => i.id), apps: !!m.extras?.apps?.winget, vaultApp: !!m.extras?.vaultApp,
        });
      } catch {}
    }
    return out;
  }

  /** Backups from history plus any found in "Vault Backups" on connected drives. */
  async list(drives = []) {
    const map = new Map();
    for (const b of this.store.backups) map.set(b.folder.toLowerCase(), { ...b, exists: false });
    const bases = new Set();
    for (const d of drives) if (d.ready) bases.add(path.join(d.root, BACKUP_DIR));
    for (const b of this.store.backups) bases.add(path.join(b.dest, BACKUP_DIR));
    if (this.store.settings.autoBackup.dest) bases.add(path.join(this.store.settings.autoBackup.dest, BACKUP_DIR));
    for (const base of bases) {
      for (const b of await this.discoverIn(base)) {
        const key = b.folder.toLowerCase();
        map.set(key, { ...(map.get(key) || {}), ...b, exists: true });
      }
    }
    for (const [key, b] of map) if (!b.exists) b.exists = fs.existsSync(path.join(b.folder, MANIFEST));
    for (const b of this.running() ? [this.running()] : []) { const e = map.get(b.folder?.toLowerCase()); if (e) e.status = 'running'; }
    return [...map.values()].sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  }

  async contents(folder) {
    const m = await readManifest(folder);
    if (m.app !== 'vault') throw new Error('Not a Vault backup');
    return {
      folder, mode: m.mode, status: m.status, at: m.finishedAt || m.updatedAt, computer: m.computer,
      items: (m.items || []).map(i => ({ ...i, inVault: !!this.store.item(i.id), present: fs.existsSync(path.join(folder, i.stored)) })),
    };
  }

  /** Permanently delete one backup folder. Only ever touches folders that are Vault backups. */
  async remove(folder) {
    if (this.running()?.folder?.toLowerCase() === folder.toLowerCase()) throw new Error('That backup is being written right now');
    if (path.basename(path.dirname(folder)).toLowerCase() !== BACKUP_DIR.toLowerCase()) throw new Error('Not inside a "Vault Backups" folder');
    const m = await readManifest(folder).catch(() => null);
    if (!m || m.app !== 'vault') throw new Error('No Vault backup manifest there; refusing to delete');
    await fsp.rm(folder, { recursive: true, force: true });
    this.store.data.backups = this.store.data.backups.filter(b => b.folder.toLowerCase() !== folder.toLowerCase());
    this.store.log('purge', `Deleted backup ${folder}`);
    this.emit('backups');
  }

  // ---------- restore ----------
  async startRestore({ folder, itemId, target = 'original', targetFolder }) {
    if (this.running()) throw new Error('Another backup or restore is already running');
    const m = await readManifest(folder);
    if (m.app !== 'vault') throw new Error('Not a Vault backup');
    const entry = (m.items || []).find(i => i.id === itemId);
    if (!entry) throw new Error('That item is not in this backup');
    const src = path.join(folder, entry.stored);
    if (!fs.existsSync(src)) throw new Error('The backed-up copy is missing from the backup folder');
    let dst;
    if (target === 'folder') {
      if (!targetFolder || !fs.existsSync(targetFolder)) throw new Error('Pick a folder to restore into');
      dst = await uniquePath(path.join(targetFolder, path.basename(entry.originalPath)));
    } else {
      dst = remapHome(entry.originalPath, m.home);
      if (await exists(dst)) {
        const d = new Date();
        const ext = entry.kind === 'file' ? path.extname(dst) : '';
        dst = await uniquePath(`${ext ? dst.slice(0, -ext.length) : dst} (restored ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())})${ext}`);
      }
    }
    const job = this.newJob('restore', { itemId, itemName: entry.name, folder, target: dst, entry, library: m.library, title: `Restore ${entry.name}` });
    (async () => {
      const files = [], dirs = [];
      if (entry.kind === 'file') {
        const st = await fsp.stat(src);
        files.push({ src, dst: path.basename(dst), size: st.size, mtimeMs: st.mtimeMs });
      } else {
        dirs.push(path.basename(dst));
        await walk(src, {
          signal: job.abort.signal,
          onFile: f => {
            if (f.dir) dirs.push(path.join(path.basename(dst), f.rel));
            else files.push({ src: path.join(src, f.rel), dst: path.join(path.basename(dst), f.rel), size: f.size, mtimeMs: f.mtimeMs });
          },
        });
      }
      job.filesTotal = files.length;
      job.bytesTotal = files.reduce((s, f) => s + f.size, 0);
      job.phase = 'copying';
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await this.copyAll(job, { files, dirs }, path.dirname(dst), false);
      await this.finish(job, null);
    })().catch(e => this.fail(job, e));
    return this.publicJob(job);
  }

  /** Fresh-install mode: put back every item from this backup that isn't at its (home-adjusted) location. */
  async startRestoreAll({ folder }) {
    if (this.running()) throw new Error('Another backup or restore is already running');
    const m = await readManifest(folder);
    if (m.app !== 'vault') throw new Error('Not a Vault backup');
    const todo = [];
    for (const e of m.items || []) {
      const src = path.join(folder, e.stored);
      const dst = remapHome(e.originalPath, m.home);
      if (fs.existsSync(src) && !(await exists(dst))) todo.push({ e, src, dst });
    }
    if (!todo.length) throw new Error('Everything in this backup is already in place. Nothing to restore.');
    const job = this.newJob('restore', { itemName: `${todo.length} item${todo.length > 1 ? 's' : ''}`, folder, target: path.dirname(todo[0].dst), library: m.library, all: todo, title: 'Restore everything' });
    (async () => {
      const files = [], dirs = [];
      for (const t of todo) {
        if (t.e.kind === 'file') {
          const st = await fsp.stat(t.src);
          dirs.push(path.dirname(t.dst));
          files.push({ src: t.src, dst: t.dst, size: st.size, mtimeMs: st.mtimeMs });
        } else {
          dirs.push(t.dst);
          await walk(t.src, { signal: job.abort.signal, onFile: f => {
            if (f.dir) dirs.push(path.join(t.dst, f.rel));
            else files.push({ src: path.join(t.src, f.rel), dst: path.join(t.dst, f.rel), size: f.size, mtimeMs: f.mtimeMs });
          } });
        }
      }
      job.filesTotal = files.length;
      job.bytesTotal = files.reduce((s, f) => s + f.size, 0);
      job.phase = 'copying';
      await this.copyAll(job, { files, dirs }, '', false);
      await this.finish(job, null);
    })().catch(e => this.fail(job, e));
    return this.publicJob(job);
  }

  async afterRestore(job) {
    const list = job.all ? job.all.map(t => ({ entry: t.e, target: t.dst })) : [{ entry: job.entry, target: job.target }];
    for (const { entry, target } of list) {
      if (!fs.existsSync(target)) continue;
      try { await this.adoptRestored(entry, target, job.library); } catch (e) { console.error('adopt', e.message); }
    }
    this.store.save();
    this.emit('items');
  }

  async adoptRestored(entry, target, library) {
    const item = this.store.item(entry.id);
    if (item) {
      if (item.status !== 'ok' || !fs.existsSync(item.path)) await this.tracker.relocate(item, target, 'restored');
      return;
    }
    // Not in Vault (removed, or a fresh install): bring it back pointing at the restored copy.
    const meta = library?.items?.find(i => i.id === entry.id) || {};
    const col = this.store.collections.find(c => c.name === entry.collection) || (meta.collection && this.store.collections.find(c => c.id === meta.collection));
    const fp = (await this.tracker.fingerprint(target)).fp;
    this.store.items.push({
      ...meta, id: entry.id, kind: entry.kind, name: entry.name, path: target, collection: col?.id || null,
      tags: entry.tags || meta.tags || [], fp, status: 'ok', addedAt: meta.addedAt || new Date().toISOString(), statusSince: new Date().toISOString(),
      moved: null, suggestions: undefined,
    });
  }

  /** Merge items/collections from a backup's library copy (for a fresh install or a lost library). */
  async importLibrary(folder) {
    const m = await readManifest(folder);
    if (m.app !== 'vault' || !m.library) throw new Error('That backup has no library copy');
    let items = 0, cols = 0;
    for (const c of m.library.collections || []) {
      if (!this.store.collections.some(x => x.id === c.id)) { this.store.collections.push(c); cols++; }
    }
    for (const it of m.library.items || []) {
      if (!this.store.item(it.id)) { this.store.items.push({ ...it, path: it.path ? remapHome(it.path, m.home) : it.path, status: undefined }); items++; }
    }
    this.store.log('import', `Imported ${items} items and ${cols} collections from ${folder}`);
    this.store.save();
    this.emit('items');
    this.tracker.checkAll({ manual: true });
    return { items, collections: cols };
  }
}

export function fmtBytes(n) {
  if (n == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}
