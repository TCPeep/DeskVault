// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Reinstall helpers: where Windows really keeps your folders, things people forget to back up,
// the installed-apps list, and a runnable copy of Vault itself on the backup drive.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

function run(cmd, args, timeout = 90000) {
  return new Promise(resolve => {
    let out = '', err = '';
    const c = spawn(cmd, args, { windowsHide: true });
    const t = setTimeout(() => c.kill(), timeout);
    c.stdout.setEncoding('utf8').on('data', d => { out += d; });
    c.stderr.setEncoding('utf8').on('data', d => { err += d; });
    c.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    c.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

let kfCache = null;
/** Desktop/Documents/... as Windows resolves them (they may be redirected into OneDrive). */
export async function knownFolders() {
  if (kfCache) return kfCache;
  const home = os.homedir();
  const names = { Desktop: 'Desktop', Personal: 'Documents', 'My Pictures': 'Pictures', 'My Video': 'Videos', 'My Music': 'Music', '{374DE290-123F-4565-9164-39C4925E467B}': 'Downloads' };
  const kf = Object.fromEntries(Object.values(names).map(n => [n, path.join(home, n)]));
  const r = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'], 10000);
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line);
    if (m && names[m[1]]) kf[names[m[1]]] = m[2].replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`).trim();
  }
  kfCache = kf;
  return kf;
}

/** Commonly forgotten places that a Windows reinstall wipes. Only ones that exist are returned. */
export async function candidates() {
  const home = os.homedir();
  const kf = await knownFolders();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const bar = path.join(local, 'Programs', 'Beyond-All-Reason', 'data');
  const list = [
    { id: 'desktop', label: 'Desktop', path: kf.Desktop, why: 'Everything sitting on your desktop.' },
    { id: 'documents', label: 'Documents', path: kf.Documents, why: 'Your documents folder.' },
    { id: 'pictures', label: 'Pictures', path: kf.Pictures, why: 'Photos, screenshots and wallpapers.' },
    { id: 'videos', label: 'Videos', path: kf.Videos, why: 'Recordings and clips.' },
    { id: 'music', label: 'Music', path: kf.Music, why: 'Your music files.' },
    { id: 'downloads', label: 'Downloads', path: kf.Downloads, why: 'Usually mostly installers. Check Storage first; you may not need most of it.' },
    { id: 'savedgames', label: 'Saved Games', path: path.join(home, 'Saved Games'), why: 'Where many games keep their saves.' },
    { id: 'mygames', label: 'My Games', path: path.join(kf.Documents, 'My Games'), why: 'Game saves and settings (Paradox, Bethesda, many others).' },
    { id: 'locallow', label: 'Game saves (AppData\\LocalLow)', path: path.join(home, 'AppData', 'LocalLow'), why: 'Unity games such as The Long Dark and The Long Drive save here. Hidden folder, easy to forget.' },
    { id: 'obs', label: 'OBS scenes and profiles', path: path.join(appdata, 'obs-studio'), why: 'Your scenes, sources and stream settings.' },
    { id: 'vscode', label: 'VS Code settings', path: path.join(appdata, 'Code', 'User', 'settings.json'), why: 'Editor settings (skip if you use Settings Sync).' },
    { id: 'vscodesnippets', label: 'VS Code snippets', path: path.join(appdata, 'Code', 'User', 'snippets'), why: 'Your code snippets.' },
    { id: 'terminal', label: 'Windows Terminal settings', path: path.join(local, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'), why: 'Profiles, colours and key bindings.' },
    { id: 'psprofile', label: 'PowerShell profile', path: path.join(kf.Documents, 'WindowsPowerShell'), why: 'Your PowerShell profile and modules.' },
    { id: 'gitconfig', label: 'Git settings', path: path.join(home, '.gitconfig'), why: 'Your name, email and Git preferences.' },
    { id: 'fonts', label: 'Fonts you installed', path: path.join(local, 'Microsoft', 'Windows', 'Fonts'), why: 'Fonts installed just for you. Reinstall them by double-clicking.' },
    { id: 'barwidgets', label: 'Beyond All Reason widgets', path: path.join(bar, 'LuaUI', 'Widgets'), why: 'Your custom BAR widgets.' },
    { id: 'barconfig', label: 'Beyond All Reason settings', path: path.join(bar, 'springsettings.cfg'), why: 'Graphics, key and game settings for BAR.' },
  ];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = c.path.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    try { const st = await fsp.stat(c.path); out.push({ ...c, kind: st.isDirectory() ? 'folder' : 'file' }); } catch {}
  }
  return out;
}

/** Save the installed-apps list into <backup>\_This PC\ (winget can reinstall from apps-winget.json). */
export async function saveAppsList(dir) {
  if (process.env.VAULT_SKIP_APPS === '1') return { winget: false, list: false, skipped: true }; // tests
  await fsp.mkdir(dir, { recursive: true });
  const result = { winget: false, list: false };
  const w = await run('winget', ['export', '-o', path.join(dir, 'apps-winget.json'), '--accept-source-agreements', '--disable-interactivity'], 120000);
  result.winget = fs.existsSync(path.join(dir, 'apps-winget.json'));
  const ps = `$k='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';` +
    `Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent } | Sort-Object DisplayName -Unique | ` +
    `Format-Table @{n='Name';e={$_.DisplayName}}, @{n='Version';e={$_.DisplayVersion}}, Publisher -AutoSize | Out-String -Width 220`;
  const l = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 60000);
  if (l.out.trim()) {
    await fsp.writeFile(path.join(dir, 'apps-installed.txt'), `Programs installed on ${os.hostname()} (${new Date().toLocaleString()})\r\n` + l.out.replace(/\r?\n/g, '\r\n'));
    result.list = true;
  }
  await fsp.writeFile(path.join(dir, 'HOW TO REINSTALL APPS.txt'), [
    'After reinstalling Windows:',
    '',
    '1. Open "Terminal" (or PowerShell) and run this to reinstall most of your apps at once:',
    `   winget import -i "${path.join(dir, 'apps-winget.json')}" --accept-package-agreements --accept-source-agreements`,
    '   (Adjust the drive letter if your backup drive has a different one now.)',
    '',
    '2. apps-installed.txt lists everything that was installed, including apps winget does not know.',
    '   Go through it for anything left over (games launchers, drivers, tools from websites).',
    '',
    `winget export: ${result.winget ? 'saved' : 'failed: ' + (w.err || w.out).trim().slice(0, 300)}`,
  ].join('\r\n'));
  return result;
}

const APP_SKIP = new Set(['.git', 'storage-scan.json', 'storage-scan.json.tmp', 'history', 'vault.log', 'vault.log.old', 'thumbs']);

/** Mirror the Vault app (with node.exe) to <backups root>\Vault app so a fresh Windows can run it straight from the backup drive. */
export async function copyVaultApp(appDir, backupsRoot, dataDir) {
  const target = path.join(backupsRoot, 'Vault app');
  const walkCopy = async (src, dst) => {
    await fsp.mkdir(dst, { recursive: true });
    for (const e of await fsp.readdir(src, { withFileTypes: true })) {
      if (APP_SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) { await walkCopy(s, d); continue; }
      const [a, b] = await Promise.all([fsp.stat(s), fsp.stat(d).catch(() => null)]);
      if (b && b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 2000) continue;
      await fsp.copyFile(s, d);
      await fsp.utimes(d, a.atime, a.mtime).catch(() => {});
    }
  };
  // App files (data excluded here; handled below so it always points at this PC's library).
  for (const e of await fsp.readdir(appDir, { withFileTypes: true })) {
    if (APP_SKIP.has(e.name) || e.name === 'data' || e.name === 'node') continue;
    const s = path.join(appDir, e.name), d = path.join(target, e.name);
    if (e.isDirectory()) await walkCopy(s, d);
    else { await fsp.mkdir(target, { recursive: true }); await fsp.copyFile(s, d); }
  }
  await fsp.mkdir(path.join(target, 'data'), { recursive: true });
  await fsp.copyFile(path.join(dataDir, 'library.json'), path.join(target, 'data', 'library.json'));
  await fsp.rm(path.join(target, 'data', 'launch.txt'), { force: true });
  const nodeDst = path.join(target, 'node', 'node.exe');
  const [ns, nd] = await Promise.all([fsp.stat(process.execPath), fsp.stat(nodeDst).catch(() => null)]);
  if (!nd || nd.size !== ns.size) { await fsp.mkdir(path.dirname(nodeDst), { recursive: true }); await fsp.copyFile(process.execPath, nodeDst); }
  await fsp.writeFile(path.join(backupsRoot, 'READ ME FIRST.txt'), [
    'VAULT BACKUPS',
    '=============',
    '',
    'Just reinstalled Windows? Here is how to get everything back:',
    '',
    '1. Open the "Vault app" folder here and double-click "Start Vault.cmd".',
    '   Vault opens in your browser with your whole library. Nothing needs installing (Node.js is included).',
    '2. In Vault, go to Reinstall and click "Restore everything" (or Backups, then Restore…, then pick',
    '   items one by one). Files go back where they were. If your Windows user name changed, Vault puts',
    '   things in your new user folder automatically. Nothing is ever overwritten.',
    '3. Your app list is in "_This PC" inside the newest backup folder, with steps to reinstall',
    '   most apps with one command.',
    '4. Once things are back, you can copy the "Vault app" folder somewhere permanent (another drive is',
    '   best) and run it from there.',
    '',
    'Folders here:',
    '  <date time>        snapshot backups (a full copy each time)',
    '  Mirror - <PC>      the mirror backup (kept up to date)',
    '  Vault app          a runnable copy of Vault',
    '',
  ].join('\r\n'));
  return target;
}

export function remapHome(p, oldHome) {
  const home = os.homedir();
  if (!p || !oldHome || oldHome.toLowerCase() === home.toLowerCase()) return p;
  const l = p.toLowerCase(), o = oldHome.toLowerCase();
  return l === o || l.startsWith(o + '\\') ? home + p.slice(oldHome.length) : p;
}
