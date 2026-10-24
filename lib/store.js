// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// The library lives in one JSON file (data/library.json). Writes are atomic (temp file + rename)
// and a dated copy is kept in data/history/ so a bad edit can always be rolled back.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const newId = () => crypto.randomBytes(6).toString('base64url');

export function defaultSettings() {
  const home = os.homedir();
  return {
    theme: 'system',            // system | dark | light
    view: 'list',               // list | grid
    checkIntervalSec: 60,       // how often tracked paths are re-checked
    searchRoots: [home],        // where to look for items that moved and can't be found by ID
    searchOtherDrives: true,    // also search the roots of other fixed drives
    backupExcludes: ['node_modules', '__pycache__', '.venv', 'venv', '.next', '.cache', '.parcel-cache', 'Thumbs.db', 'desktop.ini'],
    autoBackup: { enabled: false, every: 'daily', dest: '', mode: 'mirror', keep: 5, lastRun: null, lastResult: null },
  };
}

function defaults() {
  return {
    version: 1,
    items: [],
    collections: [
      { id: 'projects', name: 'Projects', color: '#818cf8' },
      { id: 'documents', name: 'Documents', color: '#34d399' },
    ],
    backups: [],
    activity: [],
    settings: defaultSettings(),
  };
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'library.json');
    this.historyDir = path.join(dataDir, 'history');
    fs.mkdirSync(this.historyDir, { recursive: true });
    this.data = this.load();
    this.timer = null;
  }

  load() {
    let data = null;
    for (const f of [this.file, this.file + '.tmp']) {
      try { data = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch {}
    }
    if (!data) data = defaults();
    const base = defaults();
    data.items ??= [];
    data.collections ??= base.collections;
    data.backups ??= [];
    data.activity ??= [];
    data.settings = { ...base.settings, ...(data.settings || {}) };
    data.settings.autoBackup = { ...base.settings.autoBackup, ...(data.settings.autoBackup || {}) };
    return data;
  }

  get items() { return this.data.items; }
  get collections() { return this.data.collections; }
  get settings() { return this.data.settings; }
  get backups() { return this.data.backups; }

  item(id) { return this.data.items.find(i => i.id === id); }

  log(type, message, extra = {}) {
    const entry = { at: new Date().toISOString(), type, message, ...extra };
    this.data.activity.unshift(entry);
    if (this.data.activity.length > 500) this.data.activity.length = 500;
    this.save();
    return entry;
  }

  /** Debounced save. */
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const json = JSON.stringify(this.data, null, 1);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, this.file);
    // One rolling copy per day, keep the last 14.
    const day = new Date().toISOString().slice(0, 10);
    const snap = path.join(this.historyDir, `library-${day}.json`);
    fs.writeFileSync(snap, json);
    const old = fs.readdirSync(this.historyDir).filter(f => /^library-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 14))) fs.rmSync(path.join(this.historyDir, f), { force: true });
  }
}
