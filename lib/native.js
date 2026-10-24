// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Bridge to bin/VaultWin.exe (Windows-only helpers). The exe is compiled from native/*.cs with the
// csc.exe that ships with .NET Framework 4 on every Windows 10/11 install, and rebuilt when the
// source changes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

export class Native {
  constructor(appDir, log) {
    this.appDir = appDir;
    this.binDir = path.join(appDir, 'bin');
    this.exe = path.join(this.binDir, 'VaultWin.exe');
    this.launcher = path.join(this.binDir, 'Vault.exe');
    this.icon = path.join(appDir, 'native', 'vault.ico');
    this.log = log;
  }

  async ensureBuilt() {
    fs.mkdirSync(this.binDir, { recursive: true });
    const stampFile = path.join(this.binDir, 'build-stamp.json');
    const src = ['VaultWin.cs', 'Launcher.cs', 'vault.ico'].map(f => path.join(this.appDir, 'native', f));
    const hash = crypto.createHash('sha1');
    for (const f of src) hash.update(fs.readFileSync(f));
    const stamp = hash.digest('hex');
    let old = null;
    try { old = JSON.parse(fs.readFileSync(stampFile, 'utf8')).stamp; } catch {}
    if (old === stamp && fs.existsSync(this.exe) && fs.existsSync(this.launcher)) return;
    if (!fs.existsSync(CSC)) throw new Error(`C# compiler not found at ${CSC}`);
    const common = ['/nologo', '/optimize+', '/platform:anycpu', `/win32icon:${this.icon}`,
      '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll'];
    await run(CSC, [...common, '/target:exe', `/out:${this.exe}`, src[0]]);
    await run(CSC, [...common, '/target:winexe', `/out:${this.launcher}`, src[1]]);
    fs.writeFileSync(stampFile, JSON.stringify({ stamp, builtAt: new Date().toISOString() }));
    this.log?.('Built native helpers');
  }

  async call(args, { timeout = 30000 } = {}) {
    const out = await run(this.exe, args, { timeout });
    try { return JSON.parse(out); } catch { throw new Error(`Bad helper output for ${args[0]}: ${out.slice(0, 200)}`); }
  }

  /** ids: hex strings. Returns [{id, path, err}] */
  resolveIds(volumeRoot, ids) {
    if (!ids.length) return Promise.resolve([]);
    return this.call(['resolve', volumeRoot, ...ids]);
  }
  pick(mode, multi, title) { return this.call(['pick', mode, multi ? '1' : '0', title || ''], { timeout: 0 }); }
  recycle(paths) { return this.call(['recycle', ...paths], { timeout: 0 }); }
  drives() { return this.call(['drives'], { timeout: 15000 }); }
  open(p) { return this.call(['open', p]); }
  reveal(p) { return this.call(['reveal', p]); }
  helloCheck() { return this.call(['hello-check'], { timeout: 20000 }); }
  /** Shows the Windows Hello prompt; resolves to 'Verified', 'Canceled', 'NotConfiguredForUser', ... */
  hello(message) { return this.call(['hello', message || ''], { timeout: 0 }); }
  binSize() { return this.call(['binsize']); }
  emptyBin() { return this.call(['emptybin'], { timeout: 0 }); }
  shortcut(lnk, target, args, workdir, icon, description) {
    return this.call(['shortcut', lnk, target, args, workdir, icon || '', description || '']);
  }
}

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', d => { out += d; });
    child.stderr.setEncoding('utf8').on('data', d => { err += d; });
    let timer = null;
    if (timeout) timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(cmd)} timed out`)); }, timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out || `${path.basename(cmd)} exited with ${code}`).trim()));
    });
  });
}
