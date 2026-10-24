// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Keeps every tracked file/folder pointed at its real location.
//
// 1. Quick check: stat the saved path. Still there -> fine.
// 2. The drive came back under a different letter (USB sticks do this) -> same path, new letter.
// 3. NTFS file ID: every file/folder keeps its ID when moved or renamed on the same drive, so we ask
//    Windows where that ID lives now. Instant, no searching. Lands in $Recycle.Bin -> "in Recycle Bin".
// 4. Search: copied to another drive, or deleted and re-created? Walk the search roots in the
//    background looking for the same name, then confirm by size + content hash (files) or by
//    matching child names (folders). Close-but-not-sure hits become suggestions.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { quickHash, folderSignature } from './files.js';

export const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information', 'windows', 'program files',
  'program files (x86)', 'programdata', 'appdata', '$windows.~bt', '$windows.~ws', 'windowsapps', '$sysreset', 'recovery', 'msocache',
  '.vs', '.cache', '__pycache__', '.venv', 'venv', '.next', 'perflogs', 'config.msi', 'vault backups', '$getcurrent', 'onedrivetemp']);
const RECYCLE_RE = /\\\$recycle\.bin\\/i;
// Something truly deleted shouldn't make Vault crawl the drives forever: search right away, then
// at most twice more, 6 hours apart. "Search again" in the app always runs.
const AUTO_SEARCH_LIMIT = 3;
const AUTO_SEARCH_GAP = 6 * 60 * 60 * 1000;
const SEARCH_BUDGET = 4 * 60 * 1000;

const now = () => new Date().toISOString();
const lc = s => s.toLowerCase();

async function statKind(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory() ? 'folder' : st.isFile() ? 'file' : null;
  } catch { return null; }
}

export class Tracker {
  constructor({ store, native, emit }) {
    this.store = store;
    this.native = native;
    this.emit = emit;
    this.checking = null;
    this.searchRun = null;
    this.searchQueue = new Map();
    this.lastCheck = null;
    this.drives = { list: [], byLetter: new Map(), byDev: new Map(), at: 0 };
  }

  start() {
    const loop = async () => {
      try { await this.checkAll(); } catch (e) { console.error('check failed', e); }
      const sec = Math.max(15, Number(this.store.settings.checkIntervalSec) || 60);
      this.timer = setTimeout(loop, sec * 1000);
    };
    loop();
  }

  status() {
    return { checking: !!this.checking, searching: this.searchRun ? [...this.searchRun.ids] : [], lastCheck: this.lastCheck };
  }

  async fingerprint(abs) {
    const st = await fsp.stat(abs, { bigint: true });
    const isDir = st.isDirectory();
    if (!isDir && !st.isFile()) throw new Error('Not a regular file or folder');
    const fp = { ino: st.ino.toString(16), dev: st.dev.toString(16), size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
    if (isDir) Object.assign(fp, await folderSignature(abs));
    else fp.hash = await quickHash(abs, fp.size);
    return { kind: isDir ? 'folder' : 'file', fp };
  }

  async refreshDrives(force = false) {
    if (!force && Date.now() - this.drives.at < 20000) return this.drives;
    let list = [];
    try { list = await this.native.drives(); } catch (e) { console.error('drives failed', e.message); }
    const byLetter = new Map(), byDev = new Map();
    await Promise.all(list.map(async d => {
      const L = d.root[0].toUpperCase();
      let dev = null;
      if (d.ready) {
        try { dev = (await fsp.stat(d.root, { bigint: true })).dev.toString(16); byDev.set(dev, L); } catch {}
      }
      byLetter.set(L, { ...d, letter: L, dev });
    }));
    this.drives = { list, byLetter, byDev, at: Date.now() };
    return this.drives;
  }

  /** Check every (or some) tracked paths. manual=true skips the search cooldown. */
  checkAll({ ids = null, manual = false } = {}) {
    if (this.checking) return this.checking;
    this.checking = this._checkAll(ids, manual).finally(() => { this.checking = null; this.lastCheck = now(); });
    return this.checking;
  }

  async _checkAll(ids, manual) {
    await this.refreshDrives(manual);
    const items = this.store.items.filter(i => (i.kind === 'file' || i.kind === 'folder') && (!ids || ids.includes(i.id)));
    let changed = false;
    const lost = [], replaced = [];
    for (const item of items) {
      const r = await this.quick(item);
      changed ||= r.changed;
      if (r.lost) lost.push(item);
      if (r.replaced) replaced.push(item);
    }
    if (replaced.length) changed = (await this.handleReplaced(replaced)) || changed;
    if (lost.length) changed = (await this.resolveLost(lost, manual)) || changed;
    if (changed) { this.store.save(); this.emit('items'); }
  }

  async quick(item) {
    let st = null;
    try { st = await fsp.stat(item.path, { bigint: true }); } catch {}
    const kind = st ? (st.isDirectory() ? 'folder' : st.isFile() ? 'file' : null) : null;
    if (kind && kind === item.kind) {
      const ino = st.ino.toString(16), dev = st.dev.toString(16);
      if (item.fp?.ino && ino !== item.fp.ino && dev === item.fp.dev) return { replaced: true, st };
      return { changed: await this.markPresent(item) };
    }
    const m = /^([a-z]):\\/i.exec(item.path);
    if (m && item.fp?.dev) {
      const L = m[1].toUpperCase();
      const mountedAt = this.drives.byDev.get(item.fp.dev);
      if (!mountedAt) {
        const cur = this.drives.byLetter.get(L);
        return { changed: this.setStatus(item, 'offline', { offlineDrive: L, letterTaken: !!(cur && cur.dev) }) };
      }
      if (mountedAt !== L) {
        const alt = mountedAt + item.path.slice(1);
        if (await statKind(alt) === item.kind) { await this.relocate(item, alt, 'drive-letter'); return { changed: true }; }
      }
    }
    return { lost: true };
  }

  async markPresent(item) {
    let changed = false;
    try {
      const st = await fsp.stat(item.path, { bigint: true });
      const fp = item.fp || {};
      const ino = st.ino.toString(16), dev = st.dev.toString(16);
      if (fp.size !== Number(st.size) || Math.abs((fp.mtimeMs || 0) - Number(st.mtimeMs)) > 1 || fp.ino !== ino || fp.dev !== dev) {
        item.fp = (await this.fingerprint(item.path)).fp;
        item.modifiedAt = new Date(item.fp.mtimeMs).toISOString();
        changed = true;
      }
    } catch { return false; }
    if (item.status !== 'ok') {
      const was = item.status;
      item.status = 'ok';
      item.statusSince = now();
      delete item.suggestions; delete item.recyclePath; delete item.offlineDrive; delete item.letterTaken; delete item.searches;
      if (was ==='missing' || was === 'recycled' || was === 'offline') this.store.log('found', `${item.name} is back`, { itemId: item.id });
      changed = true;
    }
    item.lastSeen = now();
    return changed;
  }

  // Something with a new file ID sits at the saved path. Either an editor "safe-saved" the file
  // (old ID is gone -> keep the path) or the original moved to another folder and a new thing
  // took its name (old ID now lives elsewhere -> follow the original).
  async handleReplaced(items) {
    const byDev = groupBy(items.filter(i => this.drives.byDev.has(i.fp.dev)), i => i.fp.dev);
    for (const [dev, group] of byDev) {
      const L = this.drives.byDev.get(dev);
      let results = [];
      try { results = await this.native.resolveIds(`${L}:\\`, group.map(i => i.fp.ino)); } catch {}
      const map = new Map(results.map(r => [r.id, r]));
      for (const item of group) {
        const r = map.get(item.fp.ino);
        const elsewhere = r?.path && !RECYCLE_RE.test(r.path) && lc(path.dirname(r.path)) !== lc(path.dirname(item.path));
        if (elsewhere && await statKind(r.path) === item.kind && !this.trackedElsewhere(r.path, item.id)) {
          await this.relocate(item, r.path, 'file-id', 'a different item now uses the old location');
        } else {
          item.fp.ino = null; // force markPresent to adopt the new identity
          await this.markPresent(item);
        }
      }
    }
    for (const item of items.filter(i => !this.drives.byDev.has(i.fp.dev))) { item.fp.ino = null; await this.markPresent(item); }
    return true;
  }

  async resolveLost(lost, manual) {
    let changed = false;
    const withId = lost.filter(i => i.fp?.ino && this.drives.byDev.has(i.fp.dev));
    const stillLost = lost.filter(i => !withId.includes(i));
    for (const [dev, group] of groupBy(withId, i => i.fp.dev)) {
      const L = this.drives.byDev.get(dev);
      let results = [];
      try { results = await this.native.resolveIds(`${L}:\\`, group.map(i => i.fp.ino)); } catch (e) { console.error('resolve failed', e.message); }
      const map = new Map(results.map(r => [r.id, r]));
      for (const item of group) {
        const r = map.get(item.fp.ino);
        if (r?.path && RECYCLE_RE.test(r.path)) {
          changed = this.setStatus(item, 'recycled', { recyclePath: r.path }) || changed;
        } else if (r?.path && await statKind(r.path) === item.kind && !this.trackedElsewhere(r.path, item.id)) {
          await this.relocate(item, r.path, 'file-id');
          changed = true;
        } else stillLost.push(item);
      }
    }
    for (const item of stillLost) changed = this.setStatus(item, 'missing') || changed;
    const busy = id => this.searchQueue.has(id) || this.searchRun?.ids.has(id);
    const due = stillLost.filter(i => !busy(i.id) && (manual || autoSearchDue(i)));
    if (due.length) this.search(due);
    return changed;
  }

  trackedElsewhere(p, exceptId) {
    const l = lc(p);
    return this.store.items.some(i => i.id !== exceptId && i.path && lc(i.path) === l);
  }

  setStatus(item, status, extra = {}) {
    let changed = false;
    if (item.status !== status) {
      item.status = status;
      item.statusSince = now();
      changed = true;
      const msg = {
        missing: `${item.name} can't be found at ${item.path}`,
        recycled: `${item.name} is in the Recycle Bin`,
        offline: `${item.name} is on drive ${extra.offlineDrive || '?'}:, which isn't connected`,
      }[status];
      if (msg) this.store.log(status, msg, { itemId: item.id });
    }
    for (const [k, v] of Object.entries(extra)) if (item[k] !== v) { item[k] = v; changed = true; }
    return changed;
  }

  async relocate(item, to, how, note) {
    const from = item.path;
    item.path = to;
    if (!item.customName) item.name = path.basename(to) || to;
    try { item.fp = (await this.fingerprint(to)).fp; item.modifiedAt = new Date(item.fp.mtimeMs).toISOString(); } catch {}
    const at = now();
    item.moves = [...(item.moves || []), { from, to, at, how }].slice(-25);
    item.moved = { from, to, at, how };
    item.status = 'ok';
    item.statusSince = at;
    item.lastSeen = at;
    delete item.suggestions; delete item.recyclePath; delete item.offlineDrive; delete item.letterTaken; delete item.searches;
    const via = { 'file-id': 'followed it by its file ID', 'drive-letter': 'its drive changed letter', search: 'found it by searching', manual: 'you pointed Vault to it', restored: 'restored from backup', archived: 'moved to another drive from Storage' }[how] || how;
    this.store.log('moved', `${item.name} moved to ${to} (${via}${note ? '; ' + note : ''})`, { itemId: item.id, from, to, how });
    this.emit('moved', { id: item.id, name: item.name, from, to, how });
  }

  /** Point a missing item at a path the user picked. */
  async relink(item, to) {
    const kind = await statKind(to);
    if (!kind) throw new Error('That path does not exist');
    if (kind !== item.kind) throw new Error(`That is a ${kind}, but this item is a ${item.kind}`);
    if (this.trackedElsewhere(to, item.id)) throw new Error('Another Vault item already points there');
    await this.relocate(item, to, 'manual');
    this.store.save();
    this.emit('items');
  }

  // ---------- background search ----------
  search(items) {
    for (const i of items) this.searchQueue.set(i.id, i);
    if (!this.searchRun) this.runSearchQueue();
  }

  async runSearchQueue() {
    while (this.searchQueue.size) {
      const batch = [...this.searchQueue.values()];
      this.searchQueue.clear();
      this.searchRun = { ids: new Set(batch.map(i => i.id)) };
      this.emit('search', { active: true, ids: [...this.searchRun.ids] });
      try { await this.runSearch(batch); } catch (e) { console.error('search failed', e); }
    }
    this.searchRun = null;
    this.emit('search', { active: false, ids: [] });
  }

  async searchRoots(items) {
    const roots = [];
    for (const item of items) {
      // closest folder that still exists near where it used to be
      let d = path.dirname(item.path);
      while (d && !(await statKind(d))) { const p = path.dirname(d); if (p === d) { d = null; break; } d = p; }
      if (d) roots.push(d);
    }
    for (const r of this.store.settings.searchRoots || []) roots.push(r);
    if (this.store.settings.searchOtherDrives) {
      const sys = lc((process.env.SystemDrive || 'C:') + '\\');
      for (const d of this.drives.list) if (d.ready && (d.type === 'Fixed' || d.type === 'Removable') && lc(d.root) !== sys) roots.push(d.root);
    }
    const seen = new Set();
    return roots.filter(r => !seen.has(lc(r)) && seen.add(lc(r)));
  }

  async runSearch(items) {
    const started = Date.now();
    const targets = new Map();
    for (const i of items) {
      const n = lc(path.basename(i.path));
      if (!targets.has(n)) targets.set(n, []);
      targets.get(n).push(i);
    }
    const found = new Map(), maybe = new Map();
    const queue = await this.searchRoots(items);
    const visited = new Set();
    let qi = 0, active = 0;
    const deadline = started + SEARCH_BUDGET;
    const worker = async () => {
      while (Date.now() < deadline && found.size < items.length) {
        if (qi >= queue.length) {
          if (active === 0) return;
          await new Promise(r => setTimeout(r, 5));
          continue;
        }
        const dir = queue[qi++];
        const key = lc(dir);
        if (visited.has(key)) continue;
        visited.add(key);
        active++;
        try {
          let entries;
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
          for (const d of entries) {
            if (d.isSymbolicLink()) continue;
            const full = path.join(dir, d.name);
            const isDir = d.isDirectory();
            const t = targets.get(lc(d.name));
            if (t) {
              for (const item of t) {
                if (found.has(item.id) || this.trackedElsewhere(full, item.id)) continue;
                const v = await this.verify(item, full, isDir);
                if (v === 'match') found.set(item.id, full);
                else if (v === 'maybe') {
                  if (!maybe.has(item.id)) maybe.set(item.id, []);
                  if (maybe.get(item.id).length < 5) maybe.get(item.id).push(full);
                }
              }
            }
            if (isDir && !SKIP_DIRS.has(lc(d.name)) && !d.name.startsWith('$')) queue.push(full);
          }
        } finally { active--; }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    let changed = false;
    for (const item of items) {
      if (!this.store.item(item.id) || item.status === 'ok') continue; // removed or came back meanwhile
      const hit = found.get(item.id);
      if (hit) { await this.relocate(item, hit, 'search'); changed = true; }
      else {
        const sug = maybe.get(item.id) || [];
        if (JSON.stringify(sug) !== JSON.stringify(item.suggestions || [])) { item.suggestions = sug; changed = true; }
      }
      item.lastSearched = now();
      if (item.status !== 'ok') item.searches = (item.searches || 0) + 1;
    }
    this.store.save();
    this.emit('items');
    return changed;
  }

  async verify(item, full, isDir) {
    if ((item.kind === 'folder') !== isDir) return 'no';
    try {
      if (!isDir) {
        const st = await fsp.stat(full);
        if (!item.fp?.size && item.fp?.size !== 0) return 'maybe';
        if (st.size !== item.fp.size) return 'maybe';
        if (!item.fp.hash) return 'match';
        return (await quickHash(full, st.size)) === item.fp.hash ? 'match' : 'maybe';
      }
      const sig = await folderSignature(full);
      const want = item.fp?.children || [];
      if (!want.length) return sig.count === 0 ? 'match' : 'maybe';
      const have = new Set(sig.children.map(lc));
      // children list is capped at 60 names, so also check a few beyond the cap directly
      let hits = 0;
      for (const n of want) if (have.has(lc(n)) || (sig.count > 60 && fs.existsSync(path.join(full, n)))) hits++;
      const ratio = hits / want.length;
      return ratio >= 0.6 ? 'match' : ratio >= 0.25 ? 'maybe' : 'no';
    } catch { return 'no'; }
  }
}

function autoSearchDue(item) {
  const n = item.searches || 0;
  if (n === 0) return true;
  if (n >= AUTO_SEARCH_LIMIT) return false;
  return Date.now() - Date.parse(item.lastSearched || 0) > AUTO_SEARCH_GAP;
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

export const homeDir = os.homedir();
