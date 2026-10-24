// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Storage manager: scan chosen places, find what hasn't been opened in ages, find duplicates,
// and clean up (Recycle Bin) or move things to another drive to free space.
//
// "Last opened" comes from NTFS last-access times when Windows records them (fsutil
// DisableLastAccess = 0 or 2); otherwise only "last changed" is available.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { SKIP_DIRS } from './tracker.js';
import { quickHash } from './files.js';
import { newId } from './store.js';
import { knownFolders } from './reinstall.js';

// Rebuildable dev folders: reported as one entry each instead of thousands of files.
const BUNDLES = new Set(['node_modules', '__pycache__', '.venv', 'venv', '.next', '.cache', '.gradle', '.pnpm-store', 'bower_components', '.parcel-cache', '.turbo']);
const MIN_RECORD = 50 * 1024;   // smaller files only count toward totals
const MAX_RECORDS = 400000;
const DAY = 86400000;
// Age buckets (days since last used): <6 months, 6-12 months, 1-2 years, 2-3 years, 3+ years
export const AGE_MAX = [182, 365, 730, 1095, Infinity];
const bucketOf = days => AGE_MAX.findIndex(m => days < m);

const CATS = {
  video: 'mp4 mkv avi mov wmv webm m4v flv mpg mpeg ts vob',
  image: 'jpg jpeg png gif bmp webp heic tif tiff psd raw cr2 nef svg ico',
  audio: 'mp3 wav flac aac m4a ogg wma opus',
  archive: 'zip rar 7z gz tgz bz2 xz tar iso img cab',
  installer: 'exe msi msix appx msixbundle',
  document: 'pdf doc docx xls xlsx ppt pptx odt ods txt md rtf csv epub',
};
const EXT_CAT = {};
for (const [c, list] of Object.entries(CATS)) for (const e of list.split(' ')) EXT_CAT[e] = c;
export const catOf = (p, bundle) => bundle ? 'dev' : EXT_CAT[path.extname(p).slice(1).toLowerCase()] || 'other';

const lc = s => s.toLowerCase();
const exists = p => fsp.access(p).then(() => true, () => false);

async function uniquePath(p) {
  if (!(await exists(p))) return p;
  const ext = path.extname(p), stem = ext ? p.slice(0, -ext.length) : p;
  for (let n = 2; ; n++) { const c = `${stem} (${n})${ext}`; if (!(await exists(c))) return c; }
}

async function dirStats(dir, signal) {
  let bytes = 0, files = 0, mtime = 0, atime = 0;
  const stack = [dir];
  while (stack.length && !signal?.aborted) {
    const d = stack.pop();
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      try { const st = await fsp.stat(full); bytes += st.size; files++; mtime = Math.max(mtime, st.mtimeMs); atime = Math.max(atime, st.atimeMs); } catch {}
    }
  }
  return { bytes, files, mtime, atime };
}

/** 5 spread-out 64 KB samples + size. Identical files always match; different ones essentially never do. */
async function sampleHash(p, size) {
  const h = crypto.createHash('sha1');
  h.update(String(size));
  const fh = await fsp.open(p, 'r');
  try {
    const n = Math.min(65536, size);
    const buf = Buffer.alloc(n);
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const pos = Math.max(0, Math.min(size - n, Math.floor(size * frac)));
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      h.update(buf.subarray(0, bytesRead));
    }
  } finally { await fh.close(); }
  return h.digest('hex');
}

export class Storage {
  constructor({ store, native, emit, dataDir, tracker }) {
    this.store = store;
    this.native = native;
    this.emit = emit;
    this.tracker = tracker;
    this.cacheFile = path.join(dataDir, 'storage-scan.json');
    this.records = [];        // [path, size, mtimeMs, atimeMs, isBundle]
    this.byPath = new Map();  // lowercase path -> record
    this.summary = null;
    this.scan = null;
    this.dupes = null;
    this.job = null;
    this.atimeOn = null;
    this.loadCache();
  }

  async loadCache() {
    try {
      const c = JSON.parse(await fsp.readFile(this.cacheFile, 'utf8'));
      this.summary = c.summary;
      this.setRecords(c.records || []);
    } catch {}
  }

  setRecords(recs) {
    this.records = recs;
    this.byPath = new Map(recs.map(r => [lc(r[0]), r]));
  }

  async saveCache() {
    const tmp = this.cacheFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ summary: this.summary, records: this.records }));
    await fsp.rename(tmp, this.cacheFile);
  }

  has(p) { return this.byPath.has(lc(p)); }

  async atimeEnabled() {
    if (this.atimeOn != null) return this.atimeOn;
    const out = await new Promise(res => {
      let o = '';
      const c = spawn('fsutil', ['behavior', 'query', 'disablelastaccess'], { windowsHide: true });
      c.stdout.on('data', d => { o += d; });
      c.on('error', () => res(''));
      c.on('close', () => res(o));
    });
    const m = /=\s*(\d)/.exec(out);
    this.atimeOn = m ? (m[1] === '0' || m[1] === '2') : false;
    return this.atimeOn;
  }

  async suggestedRoots() {
    const kf = await knownFolders(); // the real locations, even when redirected into OneDrive
    return ['Downloads', 'Desktop', 'Documents', 'Videos', 'Pictures', 'Music'].map(n => kf[n]).filter(p => p && fs.existsSync(p));
  }

  publicScan() {
    if (!this.scan) return null;
    const { abort, lastEmit, ...rest } = this.scan;
    return rest;
  }

  async status() {
    return {
      summary: this.summary, scan: this.publicScan(), job: this.job && { ...this.job, abort: undefined },
      dupes: this.dupes && { at: this.dupes.at, groups: this.dupes.groups.length, wasted: this.dupes.wasted },
      suggested: await this.suggestedRoots(), atimeOn: this.atimeOn,
    };
  }

  tick(obj, force) {
    const t = Date.now();
    if (!force && t - (obj.lastEmit || 0) < 300) return;
    obj.lastEmit = t;
    this.emit('storage', { scan: this.publicScan(), job: this.job && { ...this.job, abort: undefined, lastEmit: undefined } });
  }

  // ---------- scanning ----------
  startScan(roots) {
    if (this.scan?.state === 'running') throw new Error('A scan is already running');
    const list = [...new Set(roots.filter(r => r && fs.existsSync(r)))];
    if (!list.length) throw new Error('Pick at least one folder or drive to scan');
    const scan = { id: newId(), roots: list, state: 'running', startedAt: new Date().toISOString(), files: 0, bytes: 0, dirs: 0, current: '', abort: new AbortController() };
    this.scan = scan;
    this.runScan(scan).catch(e => { scan.state = 'failed'; scan.error = e.message; this.tick(scan, true); });
    return this.publicScan();
  }

  cancelScan() { if (this.scan?.state === 'running') this.scan.abort.abort(); }

  async runScan(scan) {
    const signal = scan.abort.signal;
    const atimeOn = await this.atimeEnabled();
    const now = Date.now();
    const recs = [];
    const blank = () => AGE_MAX.map(() => ({ bytes: 0, files: 0 }));
    const sum = { files: 0, bytes: 0, opened: blank(), changed: blank(), cats: {} };
    const folders = new Map();
    const seen = new Set();
    let minKept = MIN_RECORD;

    const account = (p, size, mtime, atime, bundle, chain, filesInside = 1) => {
      const used = atimeOn ? Math.max(atime, mtime) : mtime;
      const bo = bucketOf((now - used) / DAY), bc = bucketOf((now - mtime) / DAY);
      sum.files += filesInside; sum.bytes += size;
      sum.opened[bo].bytes += size; sum.opened[bo].files += filesInside;
      sum.changed[bc].bytes += size; sum.changed[bc].files += filesInside;
      const cat = catOf(p, bundle);
      const c = (sum.cats[cat] ||= { bytes: 0, files: 0 });
      c.bytes += size; c.files += filesInside;
      for (const f of chain) {
        const a = folders.get(f) || { bytes: 0, files: 0, used: 0, changed: 0 };
        a.bytes += size; a.files += filesInside; a.used = Math.max(a.used, used); a.changed = Math.max(a.changed, mtime);
        folders.set(f, a);
      }
      if (size >= minKept || bundle) recs.push([p, size, Math.round(mtime), Math.round(atime), bundle ? 1 : 0]);
      if (recs.length > MAX_RECORDS) {
        recs.sort((x, y) => y[1] - x[1]);
        recs.length = Math.floor(MAX_RECORDS * 0.75);
        minKept = recs[recs.length - 1][1];
        scan.truncated = true;
      }
      scan.files += filesInside; scan.bytes += size;
    };

    for (const root of scan.roots) {
      const stack = [{ dir: root, depth: 0, chain: [root] }];
      while (stack.length && !signal.aborted) {
        const { dir, depth, chain } = stack.pop();
        if (seen.has(lc(dir))) continue;
        seen.add(lc(dir));
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        scan.dirs++;
        scan.current = dir;
        this.tick(scan);
        const work = [];
        for (const d of entries) {
          if (d.isSymbolicLink()) continue;
          const full = path.join(dir, d.name);
          if (d.isDirectory()) {
            const ln = lc(d.name);
            if (BUNDLES.has(ln)) work.push({ full, bundle: true });
            else if (!SKIP_DIRS.has(ln) && !d.name.startsWith('$')) stack.push({ dir: full, depth: depth + 1, chain: depth < 2 ? [...chain, full] : chain });
          } else if (d.isFile()) work.push({ full });
        }
        for (let i = 0; i < work.length && !signal.aborted; i += 32) {
          await Promise.all(work.slice(i, i + 32).map(async w => {
            try {
              if (w.bundle) {
                const s = await dirStats(w.full, signal);
                if (s.files) account(w.full, s.bytes, s.mtime, s.atime, true, chain, s.files);
              } else {
                const st = await fsp.stat(w.full);
                account(w.full, st.size, st.mtimeMs, st.atimeMs, false, chain);
              }
            } catch {}
          }));
        }
      }
    }

    const topFolders = [...folders.entries()]
      .filter(([p]) => !scan.roots.some(r => lc(r) === lc(p)))
      .sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 40)
      .map(([p, a]) => ({ path: p, ...a }));
    this.summary = {
      at: new Date().toISOString(), roots: scan.roots, atimeOn, cancelled: signal.aborted, truncated: !!scan.truncated,
      files: sum.files, bytes: sum.bytes, opened: sum.opened, changed: sum.changed, cats: sum.cats, folders: topFolders,
      rootTotals: scan.roots.map(r => ({ path: r, ...(folders.get(r) || { bytes: 0, files: 0 }) })), freed: 0,
    };
    this.setRecords(recs);
    this.dupes = null;
    scan.state = signal.aborted ? 'cancelled' : 'complete';
    scan.finishedAt = new Date().toISOString();
    scan.current = '';
    await this.saveCache().catch(e => console.error('storage cache', e.message));
    this.tick(scan, true);
    this.emit('storage-done', {});
  }

  // ---------- querying ----------
  lastUsed(r, basis) {
    return basis === 'changed' || !this.summary?.atimeOn ? r[2] : Math.max(r[2], r[3]);
  }

  inVaultChecker() {
    const paths = this.store.items.filter(i => i.path).map(i => lc(i.path));
    return p => { const l = lc(p); return paths.some(v => l === v || l.startsWith(v + '\\')); };
  }

  query({ basis = 'opened', minAge = 0, maxAge = 0, minSize = 0, cat = 'all', q = '', sort = 'size', offset = 0, limit = 200 }) {
    const now = Date.now(), ql = q.toLowerCase();
    let rows = this.records.filter(r => {
      if (minSize && r[1] < minSize) return false;
      if (minAge && now - this.lastUsed(r, basis) < minAge * DAY) return false;
      if (maxAge && now - this.lastUsed(r, basis) >= maxAge * DAY) return false;
      if (cat !== 'all' && catOf(r[0], r[4]) !== cat) return false;
      if (ql && !lc(r[0]).includes(ql)) return false;
      return true;
    });
    const totalBytes = rows.reduce((s, r) => s + r[1], 0);
    if (sort === 'age') rows.sort((a, b) => this.lastUsed(a, basis) - this.lastUsed(b, basis));
    else if (sort === 'name') rows.sort((a, b) => path.basename(a[0]).localeCompare(path.basename(b[0])));
    else rows.sort((a, b) => b[1] - a[1]);
    const inVault = this.inVaultChecker();
    return {
      total: rows.length, totalBytes,
      rows: rows.slice(offset, offset + limit).map(r => ({
        path: r[0], name: path.basename(r[0]), dir: path.dirname(r[0]), size: r[1], changed: r[2],
        opened: this.summary?.atimeOn ? Math.max(r[2], r[3]) : null, bundle: !!r[4], cat: catOf(r[0], r[4]), inVault: inVault(r[0]),
      })),
    };
  }

  // ---------- duplicates ----------
  async findDuplicates() {
    if (this.dupesRun) return this.dupesRun;
    this.dupesRun = (async () => {
      const bySize = new Map();
      for (const r of this.records) {
        if (r[4] || r[1] < 1024 * 1024) continue;
        if (!bySize.has(r[1])) bySize.set(r[1], []);
        bySize.get(r[1]).push(r);
      }
      let cands = [...bySize.values()].filter(g => g.length > 1).sort((a, b) => b[0][1] - a[0][1]);
      const flat = [];
      for (const g of cands) { if (flat.length + g.length > 20000) break; flat.push(...g); }
      const byHash = new Map();
      let done = 0;
      for (const r of flat) {
        try {
          const key = r[1] + ':' + await sampleHash(r[0], r[1]);
          if (!byHash.has(key)) byHash.set(key, []);
          byHash.get(key).push(r);
        } catch {}
        if (++done % 50 === 0) this.emit('storage', { dupes: { done, total: flat.length } });
      }
      const inVault = this.inVaultChecker();
      const groups = [...byHash.values()].filter(g => g.length > 1).map(g => ({
        size: g[0][1], wasted: g[0][1] * (g.length - 1),
        files: g.map(r => ({ path: r[0], name: path.basename(r[0]), dir: path.dirname(r[0]), changed: r[2], opened: this.summary?.atimeOn ? Math.max(r[2], r[3]) : null, inVault: inVault(r[0]) })),
      })).sort((a, b) => b.wasted - a.wasted).slice(0, 300);
      this.dupes = { at: new Date().toISOString(), groups, wasted: groups.reduce((s, g) => s + g.wasted, 0) };
      return this.dupes;
    })().finally(() => { this.dupesRun = null; });
    return this.dupesRun;
  }

  dropRecord(p, freedBytes) {
    const r = this.byPath.get(lc(p));
    if (!r) return;
    this.byPath.delete(lc(p));
    const i = this.records.indexOf(r);
    if (i >= 0) this.records.splice(i, 1);
    if (this.summary) this.summary.freed = (this.summary.freed || 0) + freedBytes;
    if (this.dupes) {
      for (const g of this.dupes.groups) g.files = g.files.filter(f => lc(f.path) !== lc(p));
      this.dupes.groups = this.dupes.groups.filter(g => g.files.length > 1);
      for (const g of this.dupes.groups) g.wasted = g.size * (g.files.length - 1);
    }
  }

  checkKnown(paths) {
    const unknown = paths.filter(p => !this.has(p));
    if (unknown.length) throw new Error(`Not part of the current scan: ${unknown[0]}. Re-scan and try again.`);
  }

  // ---------- clean up ----------
  async recycle(paths, drives) {
    this.checkKnown(paths);
    const results = [];
    for (const p of paths) {
      const r = this.byPath.get(lc(p));
      const root = (/^[a-z]:\\/i.exec(p) || [''])[0].toUpperCase();
      const drive = drives.find(d => d.root.toUpperCase() === root);
      if (drive?.type !== 'Fixed') { results.push({ path: p, ok: false, message: 'This drive has no Recycle Bin. Delete it in Explorer if you\'re sure.' }); continue; }
      try {
        const [res] = await this.native.recycle([p]);
        if (!res.gone) { results.push({ path: p, ok: false, message: res.aborted ? 'Cancelled' : `Windows couldn't delete it (code ${res.code}). Is it open somewhere?` }); continue; }
        this.dropRecord(p, r[1]);
        results.push({ path: p, ok: true, size: r[1] });
        this.store.log('purge', `Storage: moved ${p} to the Recycle Bin`);
      } catch (e) { results.push({ path: p, ok: false, message: e.message }); }
    }
    this.saveCache().catch(() => {});
    return { results };
  }

  /** Move files/folders to <dest>\Vault Archive\<drive letter>\<original path>. Copies, verifies, then deletes the original. */
  startMove(paths, dest, onArchiveRoot) {
    if (this.job?.state === 'running') throw new Error('A move is already running');
    this.checkKnown(paths);
    if (!dest || !fs.existsSync(dest)) throw new Error('Pick where to move them');
    const archiveRoot = path.join(dest, 'Vault Archive');
    const job = { id: newId(), state: 'running', total: paths.length, done: 0, bytes: 0, freed: 0, current: '', errors: [], archiveRoot, abort: new AbortController() };
    this.job = job;
    (async () => {
      const sameDrive = p => lc(p.slice(0, 2)) === lc(dest.slice(0, 2));
      for (const p of paths) {
        if (job.abort.signal.aborted) break;
        const r = this.byPath.get(lc(p));
        job.current = p;
        this.tick(job);
        try {
          const rel = p.replace(/^([a-z]):\\/i, '$1\\');
          const target = await uniquePath(path.join(archiveRoot, rel));
          await fsp.mkdir(path.dirname(target), { recursive: true });
          if (r[4]) {
            await fsp.cp(p, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
            const [a, b] = await Promise.all([dirStats(p), dirStats(target)]);
            if (a.bytes !== b.bytes || a.files !== b.files) throw new Error('Copy check failed, original kept');
          } else {
            const st = await fsp.stat(p);
            await fsp.copyFile(p, target, fs.constants.COPYFILE_EXCL);
            const st2 = await fsp.stat(target);
            if (st2.size !== st.size || (await quickHash(p, st.size)) !== (await quickHash(target, st2.size))) {
              await fsp.rm(target, { force: true });
              throw new Error('Copy check failed, original kept');
            }
            await fsp.utimes(target, st.atime, st.mtime).catch(() => {});
          }
          await fsp.rm(p, { recursive: true, force: false });
          // Vault items that lived there follow along.
          for (const item of this.store.items) {
            if (!item.path) continue;
            const l = lc(item.path), lp = lc(p);
            if (l === lp || l.startsWith(lp + '\\')) await this.tracker.relocate(item, target + item.path.slice(p.length), 'archived');
          }
          job.bytes += r[1];
          if (!sameDrive(p)) job.freed += r[1];
          this.dropRecord(p, sameDrive(p) ? 0 : r[1]);
          this.store.log('archive', `Storage: moved ${p} to ${target}`);
        } catch (e) { job.errors.push({ path: p, message: e.message }); }
        job.done++;
        this.tick(job);
      }
      if (job.done > job.errors.length) await onArchiveRoot?.(archiveRoot);
      job.state = job.abort.signal.aborted ? 'cancelled' : job.errors.length ? 'errors' : 'complete';
      job.current = '';
      this.store.save();
      this.saveCache().catch(() => {});
      this.tick(job, true);
      this.emit('items');
    })().catch(e => { job.state = 'failed'; job.errors.push({ path: '', message: e.message }); this.tick(job, true); });
    return { ...job, abort: undefined };
  }

  cancelMove() { if (this.job?.state === 'running') this.job.abort.abort(); }
}
