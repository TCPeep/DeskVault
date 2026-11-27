// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Storage > Installed apps: desktop programs (from the Windows Uninstall registry keys) and Microsoft Store
// apps, with icons, sizes, when you last opened them (Explorer's UserAssist history), your own ratings,
// and a one-at-a-time uninstall queue that runs each app's own uninstaller. Uninstall commands are only
// ever read from the registry here, never taken from the browser.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { walk } from './files.js';

const ICON_SIZE = 64;
const CACHE_MS = 5 * 60000;
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Uninstallers that hand off to a copy of themselves (Inno Setup's _iu*.tmp, NSIS's Au_.exe, …).
const BUSY_RE = /^(unins\d*\.exe|_iu\w*\.tmp|_un\w*\.tmp|au_\.exe|un_a\.exe|un\.exe|.*uninst.*\.exe|.*uninstall.*\.exe)$/i;
const safeUrl = u => (u && /^https?:\/\/[^\s"'<>]+$/i.test(u) && !/^https?:\/\/[^/]*@/i.test(u) ? u : null);
const lower = p => p.toLowerCase().replace(/[\\/]+$/, '') + '\\';

/** The file a command line or icon spec points at ("C:\x\y.exe" /S, C:\x\y.exe,0, …). */
function fileOf(spec) {
  if (!spec) return null;
  const s = String(spec).trim();
  const m = s.match(/^"([^"]+)"/) || s.match(/^([a-z]:\\.*?\.(?:exe|dll|ico))(?=[\s,]|$)/i);
  return m ? m[1] : null;
}

function parseInstallDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return isNaN(d) || +m[1] < 1990 ? null : d.toISOString(); }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t).toISOString();
}

function runPs(args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', d => { out += d; });
    child.stderr.setEncoding('utf8').on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('PowerShell timed out')); }, timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error((err || out || `PowerShell exited with ${code}`).trim().split('\n')[0])); });
  });
}

export class Apps {
  constructor({ native, store, emit, appDir, dataDir, log }) {
    this.native = native;
    this.store = store;
    this.emit = emit;
    this.log = log;
    this.iconDir = path.join(dataDir, 'thumbs', 'apps');
    this.ps1 = path.join(appDir, 'native', 'store-apps.ps1');
    this.cache = null;
    this.loading = null;
    this.failedIcons = new Set();
    this.queue = null;
    this.running = false;
    const env = process.env, home = os.homedir();
    // Folders too general to tell apps apart by (launch history under them can't be pinned to one app).
    this.generic = new Set([env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.windir, env.windir && path.join(env.windir, 'System32'),
      env.windir && path.join(env.windir, 'SysWOW64'), home, path.join(home, 'AppData'), env.LOCALAPPDATA, env.APPDATA,
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft'),
      env.APPDATA && path.join(env.APPDATA, 'Microsoft'), 'C:\\'].filter(Boolean).map(lower));
  }

  get prefs() {
    const d = this.store.data;
    d.apps ??= { notes: {}, sizes: {} };
    d.apps.notes ??= {}; d.apps.sizes ??= {};
    return d.apps;
  }

  // ---------- listing ----------
  async list({ refresh = false } = {}) {
    if (refresh || !this.cache || Date.now() - this.cache.at > CACHE_MS) {
      if (!this.loading) this.loading = this.load().finally(() => { this.loading = null; });
      await this.loading;
    }
    return this.view();
  }

  view() {
    const { notes, sizes } = this.prefs;
    const apps = (this.cache?.apps || []).map(a => {
      const n = notes[a.id] || {};
      const measured = sizes[a.id];
      const { iconSpec, iconSpecs, tag, key, full, dirs, ...pub } = a;
      return { ...pub, stars: n.stars || 0, note: n.note || '',
        size: a.size || measured?.bytes || null, sizeFrom: a.size ? 'Windows' : measured ? 'measured' : null, measuredAt: measured?.at || null };
    });
    return { apps, at: this.cache?.at ? new Date(this.cache.at).toISOString() : null, queue: this.queueView() };
  }

  async load() {
    const [w, s] = await Promise.all([
      this.native.call(['apps'], { timeout: 60000 }),
      this.storeApps().catch(e => { this.log?.('store apps: ' + e.message); return []; }),
    ]);
    const usage = (w.usage || []).map(u => ({ ...u, lp: u.path.toLowerCase() }));
    const apps = w.apps.map(a => this.desktopApp(a, usage));
    for (const p of s) { const a = this.storeApp(p); if (a) apps.push(a); }
    await this.makeIcons(apps).catch(e => this.log?.('app icons: ' + e.message));
    this.cache = { at: Date.now(), apps };
  }

  appDirs(...candidates) {
    const out = new Set();
    for (const c of candidates) {
      if (!c || !/^[a-z]:\\/i.test(c)) continue;
      const d = lower(c);
      if (this.generic.has(d) || d.split('\\').filter(Boolean).length < 3) continue;
      if (/\\(windows|package cache|installer|installshield installation information|\{[0-9a-f-]{36}\})\\/i.test(d)) continue;
      out.add(d);
    }
    return [...out];
  }

  desktopApp(a, usage) {
    const iconFile = fileOf(a.icon);
    const unExe = fileOf(a.uninstall);
    const loc = a.location ? a.location.replace(/^"|"$/g, '') : null;
    const dirs = this.appDirs(loc, iconFile && path.dirname(iconFile), unExe && path.dirname(unExe));
    let lastUsed = null, launches = 0;
    for (const u of usage) {
      if (!dirs.some(d => u.lp.startsWith(d))) continue;
      launches += u.count || 0;
      if (u.last && (!lastUsed || u.last > lastUsed)) lastUsed = u.last;
    }
    // Icon candidates, best first: the app's own DisplayIcon, its main exe, Windows Installer's cached icon, the uninstaller.
    const iconSpecs = [];
    if (a.icon) iconSpecs.push(a.icon);
    if (loc) {
      try {
        const words = a.name.toLowerCase().split(/\W+/).filter(x => x.length > 2);
        const exes = fs.readdirSync(loc).filter(f => /\.exe$/i.test(f) && !/unins|uninst|setup|update|crash|helper|report|install/i.test(f));
        const best = exes.find(f => words.some(x => f.toLowerCase().includes(x))) || exes[0];
        if (best) iconSpecs.push(path.join(loc, best));
      } catch {}
    }
    if (a.msi && /^\{[0-9A-F-]{36}\}$/i.test(a.key) && process.env.windir) {
      try {
        const dir = path.join(process.env.windir, 'Installer', a.key);
        const f = fs.readdirSync(dir).find(x => /\.(ico|exe)$/i.test(x));
        if (f) iconSpecs.push(path.join(dir, f));
      } catch {}
    }
    if (unExe && !/\\(windows|system32)\\/i.test(unExe)) iconSpecs.push(unExe);
    const iconSpec = iconSpecs[0] || null;
    const missing = !!((loc && !fs.existsSync(loc)) || (unExe && !fs.existsSync(unExe)));
    return {
      id: `w:${a.tag}:${a.key}`, kind: 'desktop', tag: a.tag, key: a.key, dirs, iconSpec, iconSpecs,
      name: a.name, publisher: a.publisher || null, version: a.version || null,
      installed: parseInstallDate(a.installDate), size: a.sizeKb > 0 ? a.sizeKb * 1024 : null,
      location: loc, uninstall: a.uninstall, msi: !!a.msi, noRemove: !!a.noRemove, missing,
      url: safeUrl(a.url), help: safeUrl(a.help), comments: a.comments || null,
      scope: a.tag === 'HKCU' ? 'Just you' : 'Everyone on this PC', arch: a.tag === 'HKLM32' ? '32-bit' : a.tag === 'HKLM64' ? '64-bit' : null,
      lastUsed, launches,
    };
  }

  async storeApps() {
    const out = await runPs(['-File', this.ps1], { timeout: 90000 });
    const j = JSON.parse(out.trim() || '[]');
    return Array.isArray(j) ? j : [j];
  }

  storeApp(p) {
    if (!p?.family || !p.full || !/^[\w.\-~]+$/.test(p.full)) return null;
    let logoFile = null;
    if (p.logo && p.location) {
      try {
        const rel = p.logo.replace(/\//g, '\\');
        const dir = path.join(p.location, path.dirname(rel));
        const base = path.parse(rel).name.toLowerCase();
        const files = fs.readdirSync(dir).filter(f => f.toLowerCase().startsWith(base) && /\.png$/i.test(f));
        const rank = f => ['scale-200', 'targetsize-64', 'scale-150', 'targetsize-48', 'scale-125', 'scale-100'].findIndex(t => f.toLowerCase().includes(t));
        files.sort((x, y) => ((rank(x) + 1) || 99) - ((rank(y) + 1) || 99));
        if (files[0]) logoFile = path.join(dir, files[0]);
      } catch {}
    }
    return {
      id: `s:${p.family}`, kind: 'store', full: p.full, iconSpec: logoFile ? 'png:' + logoFile : null, dirs: [],
      name: p.name || p.family, publisher: p.publisher || null, version: p.version || null,
      installed: p.installed || null, size: null, location: p.location || null, uninstall: 'Remove-AppxPackage (Microsoft Store app)',
      msi: false, noRemove: false, missing: false, url: null, help: null, comments: p.kind === 'Store' ? 'From the Microsoft Store' : 'Packaged app (installed outside the Store)',
      scope: 'Just you', arch: null, lastUsed: null, launches: 0,
    };
  }

  /** Cached PNG per icon source; tries each app's candidates in turn (up to 4 rounds) until one works. */
  async makeIcons(apps) {
    await fsp.mkdir(this.iconDir, { recursive: true });
    const pending = apps.map(a => ({ a, specs: [...(a.iconSpecs || (a.iconSpec ? [a.iconSpec] : []))] }));
    for (const a of apps) a.icon = null;
    for (let round = 0; round < 4; round++) {
      const todo = [];
      for (const p of pending) {
        if (p.a.icon) continue;
        let spec;
        while ((spec = p.specs.shift()) && this.failedIcons.has(spec));
        if (!spec) continue;
        const name = sha(spec) + '.png', file = path.join(this.iconDir, name);
        if (fs.existsSync(file)) { p.a.icon = name; continue; }
        if (spec.startsWith('png:')) {
          try { await fsp.copyFile(spec.slice(4), file); p.a.icon = name; } catch { this.failedIcons.add(spec); }
          continue;
        }
        todo.push({ p, spec, name, file });
      }
      if (!todo.length) continue;
      const list = path.join(os.tmpdir(), `deskvault-icons-${process.pid}.txt`);
      await fsp.writeFile(list, todo.map(t => `${t.file}\t${t.spec.replace(/[\t\r\n]/g, ' ')}`).join('\n'), 'utf8');
      try { await this.native.call(['appicons', list, String(ICON_SIZE)], { timeout: 120000 }); }
      finally { fsp.rm(list, { force: true }).catch(() => {}); }
      for (const t of todo) { if (fs.existsSync(t.file)) t.p.a.icon = t.name; else this.failedIcons.add(t.spec); }
    }
  }

  iconPath(name) {
    if (!/^[0-9a-f]{16}\.png$/.test(name)) return null;
    return path.join(this.iconDir, name);
  }

  app(id) {
    const a = this.cache?.apps.find(x => x.id === id);
    if (!a) { const e = new Error('That app isn\'t in the list any more. Refresh and try again.'); e.status = 404; throw e; }
    return a;
  }

  // ---------- your notes, sizes ----------
  setNote(id, { stars, note }) {
    this.app(id);
    const n = this.prefs.notes[id] || {};
    if (stars !== undefined) n.stars = Math.max(0, Math.min(5, Math.round(Number(stars) || 0)));
    if (note !== undefined) n.note = String(note || '').slice(0, 1000);
    if (!n.stars && !n.note) delete this.prefs.notes[id]; else this.prefs.notes[id] = { ...n, at: new Date().toISOString() };
    this.store.save();
    return { stars: n.stars || 0, note: n.note || '' };
  }

  async measure(id) {
    const a = this.app(id);
    if (!a.location || !fs.existsSync(a.location)) throw new Error('This app doesn\'t say where it\'s installed, so it can\'t be measured');
    let bytes = 0, files = 0;
    await walk(a.location, { onFile: f => { if (!f.dir) { bytes += f.size; files++; } } });
    const m = { bytes, files, at: new Date().toISOString() };
    this.prefs.sizes[id] = m;
    this.store.save();
    return m;
  }

  // ---------- uninstall queue ----------
  queueView() {
    if (!this.queue) return null;
    return { state: this.queue.state, items: this.queue.items.map(({ _wake, ...i }) => i) };
  }
  emitQueue() { this.emit('apps', { queue: this.queueView() }); }

  async uninstall(ids) {
    if (!this.cache) await this.list();
    const apps = [...new Set(ids)].map(id => this.app(id));
    const blocked = apps.find(a => a.noRemove);
    if (blocked) throw new Error(`${blocked.name} says it can't be removed from here`);
    if (!this.queue || this.queue.state !== 'running') this.queue = { state: 'running', items: [], startedAt: new Date().toISOString() };
    for (const a of apps) {
      if (this.queue.items.some(i => i.id === a.id && ['waiting', 'running'].includes(i.state))) continue;
      this.queue.items.push({ id: a.id, name: a.name, icon: a.icon, kind: a.kind, state: 'waiting', message: '' });
    }
    this.queue.cancel = false;
    if (!this.running) this.run();
    this.emitQueue();
    return this.queueView();
  }

  skip() {
    const it = this.queue?.items.find(i => i.state === 'running');
    if (!it) return false;
    it.skip = true;
    it._wake?.();
    return true;
  }
  cancel() {
    if (!this.queue) return;
    for (const i of this.queue.items) if (i.state === 'waiting') { i.state = 'cancelled'; i.message = 'Not started'; }
    this.emitQueue();
  }
  clear() { if (!this.running) { this.queue = null; this.emitQueue(); } }

  async run() {
    this.running = true;
    try {
      let it;
      while ((it = this.queue.items.find(i => i.state === 'waiting'))) {
        it.state = 'running';
        it.startedAt = new Date().toISOString();
        this.emitQueue();
        const app = this.cache?.apps.find(a => a.id === it.id);
        try {
          Object.assign(it, app ? (app.kind === 'store' ? await this.removeStore(app, it) : await this.removeDesktop(app, it)) : { state: 'failed', message: 'App not found' });
        } catch (e) { it.state = 'failed'; it.message = e.message; }
        it.finishedAt = new Date().toISOString();
        delete it._wake;
        if (it.state === 'done') this.store.log('apps', `Uninstalled ${it.name}`);
        this.emitQueue();
      }
    } finally {
      this.running = false;
      if (this.queue) this.queue.state = 'done';
      this.cache = null;
      this.emitQueue();
      this.emit('apps', { changed: true });
    }
  }

  wait(ms, it) { return new Promise(r => { const t = setTimeout(r, ms); it._wake = () => { clearTimeout(t); r(); }; }); }

  async removeDesktop(app, it) {
    it.message = 'Uninstaller open. Look for its window (it may be behind this one).';
    this.emitQueue();
    const exited = this.native.call(['uninstall', app.uninstall], { timeout: 0 }).then(r => ({ r }), e => ({ e }));
    const first = await Promise.race([exited, new Promise(r => { it._wake = () => r({ skipped: true }); })]);
    if (first.skipped) return { state: 'skipped', message: 'Skipped. Its uninstaller may still be open.' };
    if (first.e) return { state: 'failed', message: first.e.message };
    if (first.r.cancelled) return { state: 'cancelled', message: 'The Windows permission prompt was declined' };
    if (!first.r.ok) return { state: 'failed', message: first.r.error || 'Couldn\'t start the uninstaller' };
    it.message = 'Checking it\'s gone…';
    this.emitQueue();
    const exitedAt = Date.now();
    let idle = 0;
    while (Date.now() - exitedAt < 30 * 60000) {
      if (!(await this.native.call(['appexists', app.tag, app.key]).catch(() => true))) return { state: 'done', message: 'Uninstalled' };
      if (it.skip) return { state: 'skipped', message: 'Skipped. It still shows as installed.' };
      idle = (await this.uninstallerRunning()) ? 0 : idle + 1;
      if (idle >= 4 && Date.now() - exitedAt > 8000) return { state: 'kept', message: 'Still installed. The uninstaller closed without removing it (or needs a restart to finish).' };
      if (idle === 0) { it.message = 'Uninstaller still running…'; this.emitQueue(); }
      await this.wait(2500, it);
    }
    return { state: 'kept', message: 'Still installed after 30 minutes' };
  }

  async removeStore(app, it) {
    it.message = 'Removing…';
    this.emitQueue();
    await runPs(['-Command', `Remove-AppxPackage -Package '${app.full}'`], { timeout: 10 * 60000 });
    return { state: 'done', message: 'Uninstalled' };
  }

  uninstallerRunning() {
    return new Promise(resolve => {
      const child = spawn('tasklist.exe', ['/fo', 'csv', '/nh'], { windowsHide: true });
      let out = '';
      child.stdout.setEncoding('utf8').on('data', d => { out += d; });
      child.on('error', () => resolve(false));
      child.on('close', () => resolve(out.split('\n').some(l => BUSY_RE.test((l.match(/^"([^"]+)"/) || [])[1] || ''))));
    });
  }
}
