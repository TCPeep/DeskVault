// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// End-to-end test against a throwaway server + fixture files (never touches real data).
//   node test/smoke.mjs [fixtureDir]
// Note: two tiny fixture files get sent to the Recycle Bin (that's what is being tested).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.argv[2] || path.join(os.tmpdir(), `vault-test-${Date.now()}`));
const PORT = 4478;
const BASE = `http://127.0.0.1:${PORT}`;
const FX = path.join(ROOT, 'fx');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(FX, { recursive: true });

const w = (rel, data) => { const p = path.join(FX, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

w('proj/README.md', '# Demo project\n\n![logo](img.png)\n\nSome **bold** text.\n\n```js\nconsole.log(1)\n```\n');
w('proj/src/app.js', 'export const answer = () => 42;\n');
w('proj/img.png', PNG);
w('proj/node_modules/junk/index.js', '// should not be backed up');
w('proj/notes.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF-16 notes ✓', 'utf16le')]));
w('doc.txt', 'a document');
w('paper.pdf', PDF);
w('moveme.md', '# I will move');
w('recreate.txt', 'recreate me ' + 'x'.repeat(5000));
w('safe-save.txt', 'v1');
w('trash-me.txt', 'bye');
w('bin-me.txt', 'into the bin');
fs.mkdirSync(path.join(ROOT, 'backupdest'), { recursive: true });

const server = spawn(process.execPath, [path.join(APP, 'server.js'), '--port', String(PORT), '--data', path.join(ROOT, 'data')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VAULT_SKIP_APPS: '1' } });
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => { serverOut += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, p, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', Origin: BASE } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok && !headers['x-expect-error']) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, json, headers: res.headers };
}
const state = async () => (await api('GET', '/api/state')).json;
const item = async id => (await state()).items.find(i => i.id === id);
async function waitFor(fn, ms = 20000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function waitJob(id) {
  return waitFor(async () => { const j = (await state()).jobs.find(x => x.id === id); return j && j.state !== 'running' ? j : null; }, 60000, 'job');
}

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack}`); throw e; }
}

try {
  await waitFor(async () => { try { return (await api('GET', '/api/ping')).json.ok; } catch { return false; } }, 30000, 'server');
  // Keep searching inside the fixture folder only.
  await api('POST', '/api/settings', { patch: { searchRoots: [FX], searchOtherDrives: false } });

  const ids = {};
  await step('add files and folders', async () => {
    const names = ['proj', 'doc.txt', 'paper.pdf', 'moveme.md', 'recreate.txt', 'safe-save.txt', 'trash-me.txt', 'bin-me.txt'];
    const r = (await api('POST', '/api/items/add', { paths: names.map(n => `"${path.join(FX, n)}"`), collection: 'projects', tags: 'test, demo' })).json;
    assert.equal(r.added.length, names.length, JSON.stringify(r.skipped));
    for (const it of r.added) ids[path.basename(it.path)] = it.id;
    assert.equal(r.added.find(i => i.name === 'proj').kind, 'folder');
    assert.deepEqual(r.added[0].tags, ['test', 'demo']);
    const again = (await api('POST', '/api/items/add', { paths: [path.join(FX, 'doc.txt'), 'relative\\path', path.join(FX, 'nope.txt')] })).json;
    assert.equal(again.added.length, 0);
    assert.equal(again.skipped.length, 3);
  });

  await step('add link + note, update, bulk', async () => {
    const link = (await api('POST', '/api/items/add-link', { url: 'github.com/someone', collection: 'documents' })).json;
    assert.equal(link.url, 'https://github.com/someone');
    const note = (await api('POST', '/api/items/add-note', { name: 'Ideas', body: '# hi' })).json;
    await api('POST', '/api/items/update', { id: note.id, patch: { body: '# updated', pinned: true, tags: '#a,b' } });
    const n = await item(note.id);
    assert.equal(n.body, '# updated'); assert.equal(n.pinned, true); assert.deepEqual(n.tags, ['a', 'b']);
    await api('POST', '/api/items/bulk', { ids: [note.id, link.id], addTags: ['shared'] });
    assert.ok((await item(link.id)).tags.includes('shared'));
    const bad = await api('POST', '/api/items/add-link', { url: 'javascript:alert(1)' }, { 'x-expect-error': 1 });
    assert.equal(bad.status, 400);
  });

  await step('viewer endpoints', async () => {
    const list = (await api('GET', `/api/items/${ids.proj}/list`)).json;
    assert.deepEqual(list.entries.filter(e => e.dir).map(e => e.name), ['node_modules', 'src']);
    const js = (await api('GET', `/api/items/${ids.proj}/view?rel=src/app.js`)).json;
    assert.equal(js.kind, 'text'); assert.equal(js.lang, 'javascript'); assert.match(js.text, /answer/);
    const u16 = (await api('GET', `/api/items/${ids.proj}/view?rel=notes.txt`)).json;
    assert.equal(u16.text, 'UTF-16 notes ✓'); assert.equal(u16.encoding, 'utf-16le');
    const md = (await api('GET', `/api/items/${ids.proj}/view?rel=README.md`)).json;
    assert.equal(md.kind, 'markdown');
    const pdf = await fetch(`${BASE}/f/${ids['paper.pdf']}/paper.pdf`);
    assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const ranged = await fetch(`${BASE}/f/${ids['paper.pdf']}/paper.pdf`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206); assert.equal(await ranged.text(), '%PDF');
    const img = await fetch(`${BASE}/f/${ids.proj}/img.png`);
    assert.equal(img.headers.get('content-type'), 'image/png');
  });

  await step('security checks', async () => {
    // fetch() won't send a custom Host header, so use http.request (DNS-rebinding check)
    const http = await import('node:http');
    const hostStatus = await new Promise((res, rej) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { Host: 'evil.example:4478' } }, r => { r.resume(); res(r.statusCode); }).on('error', rej);
    });
    assert.equal(hostStatus, 403);
    const cross = await fetch(`${BASE}/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(cross.status, 403);
    const noOrigin = await fetch(`${BASE}/api/items/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":[]}' });
    assert.equal(noOrigin.status, 403);
    const evilOrigin = await fetch(`${BASE}/api/items/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"ids":[]}' });
    assert.equal(evilOrigin.status, 403);
    const form = await fetch(`${BASE}/api/items/remove`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: BASE }, body: '{"ids":[]}' });
    assert.equal(form.status, 403);
    const trav = await api('GET', `/api/items/${ids.proj}/view?rel=..%2Fdoc.txt`, null, { 'x-expect-error': 1 });
    assert.equal(trav.status, 400);
    const trav2 = await fetch(`${BASE}/f/${ids['doc.txt']}/..%2F..%2Fdata%2Flibrary.json`);
    assert.ok(trav2.status >= 400);
    const sib = await fetch(`${BASE}/f/${ids['doc.txt']}/paper.pdf`);
    assert.equal(sib.status, 403);
  });

  await step('moved + renamed file is followed by file ID', async () => {
    const to = path.join(FX, 'sub', 'deeper', 'renamed-doc.txt');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(path.join(FX, 'doc.txt'), to);
    await api('POST', '/api/items/check', {});
    const it = await item(ids['doc.txt']);
    assert.equal(it.path, to); assert.equal(it.status, 'ok'); assert.equal(it.moved.how, 'file-id'); assert.equal(it.name, 'renamed-doc.txt');
  });

  await step('renamed folder is followed; custom names stick', async () => {
    await api('POST', '/api/items/update', { id: ids.proj, patch: { name: 'My Demo Project' } });
    fs.renameSync(path.join(FX, 'proj'), path.join(FX, 'proj-renamed'));
    await api('POST', '/api/items/check', {});
    const it = await item(ids.proj);
    assert.equal(it.path, path.join(FX, 'proj-renamed')); assert.equal(it.name, 'My Demo Project');
  });

  await step('editor-style safe save keeps the path', async () => {
    const p = path.join(FX, 'safe-save.txt');
    fs.writeFileSync(p + '.tmp', 'v2 with more text');
    fs.renameSync(p + '.tmp', p);
    await api('POST', '/api/items/check', {});
    const it = await item(ids['safe-save.txt']);
    assert.equal(it.path, p); assert.equal(it.status, 'ok'); assert.ok(!it.moved); assert.equal(it.fp.size, 17);
  });

  await step('moved away + new file at old path -> follows the original', async () => {
    const to = path.join(FX, 'other', 'moveme.md');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(path.join(FX, 'moveme.md'), to);
    fs.writeFileSync(path.join(FX, 'moveme.md'), 'a brand-new file');
    await api('POST', '/api/items/check', {});
    assert.equal((await item(ids['moveme.md'])).path, to);
  });

  await step('deleted + re-created elsewhere is found by search', async () => {
    const data = fs.readFileSync(path.join(FX, 'recreate.txt'));
    fs.rmSync(path.join(FX, 'recreate.txt'));
    fs.mkdirSync(path.join(FX, 'elsewhere', 'x'), { recursive: true });
    fs.writeFileSync(path.join(FX, 'elsewhere', 'x', 'recreate.txt'), data);
    await api('POST', '/api/items/check', {});
    const it = await waitFor(async () => { const i = await item(ids['recreate.txt']); return i.status === 'ok' && i.moved?.how === 'search' ? i : null; }, 20000, 'search');
    assert.equal(it.path, path.join(FX, 'elsewhere', 'x', 'recreate.txt'));
  });

  await step('file in Recycle Bin is reported as such', async () => {
    const r = JSON.parse(await new Promise((res, rej) => {
      const c = spawn(path.join(APP, 'bin', 'VaultWin.exe'), ['recycle', path.join(FX, 'bin-me.txt')]);
      let o = ''; c.stdout.on('data', d => { o += d; }); c.on('close', code => code ? rej(new Error('recycle failed')) : res(o));
    }));
    assert.equal(r[0].gone, true);
    await api('POST', '/api/items/check', {});
    const it = await item(ids['bin-me.txt']);
    assert.equal(it.status, 'recycled'); assert.match(it.recyclePath, /\$Recycle\.Bin/i);
  });

  await step('delete to Recycle Bin via API', async () => {
    const r = (await api('POST', '/api/items/trash', { ids: [ids['trash-me.txt']] })).json;
    assert.equal(r.results[0].ok, true, JSON.stringify(r)); assert.equal(r.results[0].recycled, true);
    assert.ok(!fs.existsSync(path.join(FX, 'trash-me.txt')));
    assert.ok(!(await item(ids['trash-me.txt'])));
  });

  const dest = path.join(ROOT, 'backupdest');
  let snapFolder, mirrorFolder;
  await step('snapshot backup (excludes node_modules)', async () => {
    const est = (await api('POST', '/api/backup/estimate', { scope: { type: 'all' }, dest })).json;
    assert.ok(est.files >= 8, JSON.stringify(est));
    const job = (await api('POST', '/api/backup/start', { scope: { type: 'all' }, dest, mode: 'snapshot' })).json;
    const done = await waitJob(job.id);
    assert.equal(done.state, 'complete', JSON.stringify(done.errors));
    snapFolder = done.folder;
    const app = path.join(snapFolder, 'Projects', 'proj-renamed', 'src', 'app.js');
    assert.ok(fs.existsSync(app), 'app.js copied');
    assert.ok(!fs.existsSync(path.join(snapFolder, 'Projects', 'proj-renamed', 'node_modules')), 'node_modules excluded');
    const srcM = fs.statSync(path.join(FX, 'proj-renamed', 'src', 'app.js')).mtimeMs;
    assert.ok(Math.abs(fs.statSync(app).mtimeMs - srcM) < 2000, 'mtime kept');
    const m = JSON.parse(fs.readFileSync(path.join(snapFolder, 'vault-backup.json'), 'utf8'));
    assert.equal(m.status, 'complete'); assert.ok(m.library.items.length >= 8);
  });

  await step('mirror backup only copies changes', async () => {
    const j1 = await waitJob((await api('POST', '/api/backup/start', { scope: { type: 'all' }, dest, mode: 'mirror' })).json.id);
    assert.equal(j1.state, 'complete');
    mirrorFolder = j1.folder;
    assert.ok(j1.copied > 0);
    fs.writeFileSync(path.join(FX, 'proj-renamed', 'src', 'app.js'), 'export const answer = () => 43;\n');
    const j2 = await waitJob((await api('POST', '/api/backup/start', { scope: { type: 'all' }, dest, mode: 'mirror' })).json.id);
    assert.equal(j2.copied, 1); assert.equal(j2.unchanged, j1.copied - 1 + (j2.filesTotal - j1.filesTotal));
    assert.equal(j2.folder, mirrorFolder);
  });

  await step('restore a missing file from backup', async () => {
    fs.rmSync(path.join(FX, 'paper.pdf'));
    await api('POST', '/api/items/check', { ids: [ids['paper.pdf']] });
    await waitFor(async () => (await item(ids['paper.pdf'])).status === 'missing', 5000, 'missing');
    const list = (await api('GET', '/api/backups')).json;
    assert.ok(list.some(b => b.folder === mirrorFolder && b.exists));
    const contents = (await api('POST', '/api/backups/contents', { folder: mirrorFolder })).json;
    assert.ok(contents.items.some(i => i.id === ids['paper.pdf'] && i.present));
    const job = (await api('POST', '/api/backups/restore', { folder: mirrorFolder, itemId: ids['paper.pdf'], target: 'original' })).json;
    assert.equal((await waitJob(job.id)).state, 'complete');
    assert.equal(fs.readFileSync(path.join(FX, 'paper.pdf'), 'utf8'), PDF);
    await api('POST', '/api/items/check', { ids: [ids['paper.pdf']] });
    assert.equal((await item(ids['paper.pdf'])).status, 'ok');
  });

  await step('restore a removed item re-adds it; library import', async () => {
    await api('POST', '/api/items/remove', { ids: [ids['safe-save.txt']] });
    assert.ok(fs.existsSync(path.join(FX, 'safe-save.txt')), 'remove keeps files');
    const r = (await api('POST', '/api/backups/import', { folder: snapFolder })).json;
    assert.equal(r.items, 1);
    assert.ok(await item(ids['safe-save.txt']));
  });

  await step('purge backups safely', async () => {
    const refuse = await api('POST', '/api/backups/delete', { folder: path.join(FX, 'proj-renamed') }, { 'x-expect-error': 1 });
    assert.equal(refuse.status, 400);
    assert.ok(fs.existsSync(path.join(FX, 'proj-renamed')));
    await api('POST', '/api/backups/delete', { folder: snapFolder });
    assert.ok(!fs.existsSync(snapFolder));
  });

  await step('collections + settings', async () => {
    const c = (await api('POST', '/api/collections', { action: 'create', name: 'Games', color: '#f87171' })).json;
    await api('POST', '/api/collections', { action: 'update', id: c.id, name: 'Game mods' });
    await api('POST', '/api/items/bulk', { ids: [ids.proj], collection: c.id });
    assert.equal((await item(ids.proj)).collection, c.id);
    await api('POST', '/api/collections', { action: 'delete', id: c.id });
    assert.equal((await item(ids.proj)).collection, null);
    const s = (await api('POST', '/api/settings', { patch: { theme: 'light', checkIntervalSec: 5 } })).json;
    assert.equal(s.theme, 'light'); assert.equal(s.checkIntervalSec, 15);
  });

  await step('static app + vendor files are served', async () => {
    for (const p of ['/', '/vendor/marked.js', '/vendor/purify.js', '/vendor/highlight.js', '/vendor/hl-powershell.js', '/js/main.js', '/js/storage.js', '/js/reinstall.js', '/app.css']) {
      const r = await fetch(BASE + p);
      assert.equal(r.status, 200, p);
    }
  });

  await step('backups carry a runnable Vault + READ ME', async () => {
    const vb = path.join(dest, 'Vault Backups');
    assert.ok(fs.existsSync(path.join(vb, 'Vault app', 'server.js')), 'app copy');
    assert.ok(fs.existsSync(path.join(vb, 'Vault app', 'node', 'node.exe')), 'node bundled');
    assert.ok(fs.existsSync(path.join(vb, 'Vault app', 'data', 'library.json')), 'library copied');
    assert.ok(!fs.existsSync(path.join(vb, 'Vault app', 'data', 'vault.log')), 'logs not copied');
    assert.match(fs.readFileSync(path.join(vb, 'READ ME FIRST.txt'), 'utf8'), /Restore everything/);
  });

  await step('restore everything puts missing items back', async () => {
    fs.rmSync(path.join(FX, 'proj-renamed'), { recursive: true });
    fs.rmSync(path.join(FX, 'paper.pdf'));
    const job = (await api('POST', '/api/backups/restore-all', { folder: mirrorFolder })).json;
    assert.equal((await waitJob(job.id)).state, 'complete');
    assert.ok(fs.existsSync(path.join(FX, 'proj-renamed', 'src', 'app.js')));
    assert.ok(fs.existsSync(path.join(FX, 'paper.pdf')));
    await api('POST', '/api/items/check', {});
    assert.equal((await item(ids.proj)).status, 'ok');
    const again = await api('POST', '/api/backups/restore-all', { folder: mirrorFolder }, { 'x-expect-error': 1 });
    assert.equal(again.status, 400); // nothing left to restore, nothing overwritten
  });

  await step('new user folder after reinstall is remapped', async () => {
    const { remapHome } = await import(new URL('../lib/reinstall.js', import.meta.url));
    const home = os.homedir();
    assert.equal(remapHome('C:\\Users\\OldName\\Documents\\a.txt', 'C:\\Users\\OldName'), path.join(home, 'Documents', 'a.txt'));
    assert.equal(remapHome('D:\\Games\\x', 'C:\\Users\\OldName'), 'D:\\Games\\x');
    assert.equal(remapHome(path.join(home, 'x'), home), path.join(home, 'x'));
  });

  await step('reinstall readiness report', async () => {
    const r = (await api('GET', '/api/reinstall')).json;
    assert.ok(Array.isArray(r.candidates) && r.candidates.length > 0);
    assert.ok(r.candidates.every(c => c.label && c.path && 'inVault' in c));
    assert.ok(r.items.length >= 5);
    assert.equal(r.latest, null); // test backups live on C:, which a reinstall would wipe
  });

  await step('website previews (title, description, image, icon)', async () => {
    const http = await import('node:http');
    const site = http.createServer((req, res) => {
      if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<html><head><title>Fallback</title><meta property="og:title" content="Great &amp; Useful Site"><meta property="og:description" content="Tools I always forget"><meta property="og:image" content="/img.png"><link rel="icon" href="/fav.png"></head><body>hi</body></html>`); }
      if (req.url === '/img.png' || req.url === '/fav.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.concat([PNG, Buffer.alloc(100)])); }
      res.writeHead(404); res.end();
    });
    await new Promise(r => site.listen(0, '127.0.0.1', r));
    try {
      const link = (await api('POST', '/api/items/add-link', { url: `http://127.0.0.1:${site.address().port}/page` })).json;
      const it = await waitFor(async () => { const i = await item(link.id); return i.meta?.fetchedAt ? i : null; }, 15000, 'preview');
      assert.equal(it.name, 'Great & Useful Site');
      assert.equal(it.meta.description, 'Tools I always forget');
      assert.ok(it.meta.image && it.meta.icon, JSON.stringify(it.meta));
      const img = await fetch(`${BASE}/thumbs/${it.meta.image}`);
      assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
      assert.equal((await fetch(`${BASE}/thumbs/..%2Flibrary.json`)).status, 404);
      await api('POST', '/api/items/remove', { ids: [link.id] });
      assert.ok(!fs.existsSync(path.join(ROOT, 'data', 'thumbs', it.meta.image)), 'thumbs cleaned up');
    } finally { site.close(); }
  });

  await step('storage: scan, stale + size filters, duplicates', async () => {
    const big = Buffer.alloc(1.5 * 1024 * 1024, 7);
    w('stash/movie.mp4', big);
    w('stash/copy of movie.mp4', big);
    w('stash/old-installer.exe', Buffer.alloc(300 * 1024, 1));
    w('stash/tiny.txt', 'small');
    w('stash/toarchive.zip', Buffer.alloc(200 * 1024, 3));
    w('stash/webapp/node_modules/pkg/index.js', 'module.exports = 1;');
    w('stash/webapp/node_modules/pkg/package.json', '{}');
    const threeYears = new Date(Date.now() - 3.2 * 365 * 86400e3);
    fs.utimesSync(path.join(FX, 'stash', 'old-installer.exe'), threeYears, threeYears);
    await api('POST', '/api/storage/scan', { roots: [path.join(FX, 'stash'), path.join(FX, 'proj-renamed')] });
    const st = await waitFor(async () => { const s = (await api('GET', '/api/storage')).json; return s.scan?.state === 'complete' ? s : null; }, 30000, 'scan');
    assert.ok(st.summary.files >= 5);
    assert.ok(st.summary.cats.video.bytes >= big.length * 2);
    assert.equal(typeof st.atimeOn, 'boolean');
    const all = (await api('GET', '/api/storage/files?minSize=0')).json;
    assert.ok(!all.rows.some(r => r.name === 'tiny.txt'), 'small files only in totals');
    assert.ok(all.rows.some(r => r.bundle && r.name === 'node_modules'), 'node_modules as one entry');
    const old = (await api('GET', '/api/storage/files?minAge=1095&basis=changed')).json;
    assert.deepEqual(old.rows.map(r => r.name), ['old-installer.exe']);
    const bigOnly = (await api('GET', '/api/storage/files?minSize=1048576')).json;
    assert.equal(bigOnly.total, 2);
    const d = (await api('POST', '/api/storage/duplicates', {})).json;
    assert.equal(d.groups.length, 1); assert.equal(d.groups[0].files.length, 2); assert.equal(d.groups[0].wasted, big.length);
    const bin = (await api('GET', '/api/storage/bin')).json;
    assert.equal(bin.hr, 0);
  });

  await step('storage: delete to Recycle Bin, move to another place, refuse unknown paths', async () => {
    const dupe = path.join(FX, 'stash', 'copy of movie.mp4');
    const r = (await api('POST', '/api/storage/recycle', { paths: [dupe] })).json;
    assert.equal(r.results[0].ok, true, JSON.stringify(r));
    assert.ok(!fs.existsSync(dupe));
    const bad = await api('POST', '/api/storage/recycle', { paths: [path.join(FX, 'doc-not-scanned.txt')] }, { 'x-expect-error': 1 });
    assert.equal(bad.status, 400);
    const archiveDest = path.join(ROOT, 'archive-drive');
    fs.mkdirSync(archiveDest, { recursive: true });
    const src = path.join(FX, 'stash', 'toarchive.zip');
    await api('POST', '/api/storage/move', { paths: [src], dest: archiveDest, track: true });
    const job = await waitFor(async () => { const s = (await api('GET', '/api/storage')).json; return s.job?.state && s.job.state !== 'running' ? s.job : null; }, 20000, 'move');
    assert.equal(job.state, 'complete', JSON.stringify(job.errors));
    const moved = path.join(archiveDest, 'Vault Archive', src.replace(/^([A-Z]):\\/i, '$1\\'));
    assert.ok(fs.existsSync(moved), moved);
    assert.ok(!fs.existsSync(src));
    assert.equal(fs.statSync(moved).size, 200 * 1024);
    assert.ok((await state()).items.some(i => i.path === path.join(archiveDest, 'Vault Archive')), 'archive folder tracked');
  });

  await step('local AI: index, answer with sources, summarize, tags, never sees locked items', async () => {
    const st = (await api('GET', '/api/ai/status')).json;
    if (!st.running || !st.model) { console.log('       (skipped: Ollama not running)'); return; }
    const ndjson = async (p, body) => {
      const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(body) });
      assert.equal(r.status, 200, p);
      return (await r.text()).split('\n').filter(Boolean).map(l => JSON.parse(l));
    };
    const note = (await api('POST', '/api/items/add-note', { name: 'Garage', body: 'The garage door code is 4417. Change the remote batteries every March.' })).json;
    await api('POST', '/api/ai/index', {});
    await waitFor(async () => { const s = (await api('GET', '/api/ai/status')).json; return !s.job && s.index.items > 3 ? s : null; }, 180000, 'index');
    const lines = await ndjson('/api/ai/ask', { question: 'What is the garage door code?' });
    const src = lines.find(l => l.type === 'sources');
    assert.ok(src?.sources.some(s => s.itemId === note.id), 'note used as a source: ' + JSON.stringify(src));
    assert.match(lines.filter(l => l.type === 'token').map(l => l.t).join(''), /4417/);
    assert.ok(lines.some(l => l.type === 'done'), JSON.stringify(lines.slice(-2)));
    const sum = await ndjson('/api/ai/summarize', { itemId: ids.proj, rel: 'README.md' });
    assert.ok(sum.filter(l => l.type === 'token').length > 3, JSON.stringify(sum.slice(-2)));
    const tags = (await api('POST', '/api/ai/tags', { itemId: ids.proj })).json.tags;
    assert.ok(Array.isArray(tags) && tags.length > 0, JSON.stringify(tags));
    await api('POST', '/api/lock/set', { itemIds: [note.id], locked: true });
    const after = await ndjson('/api/ai/ask', { question: 'What is the garage door code?' });
    assert.ok(!after.find(l => l.type === 'sources').sources.some(s => s.itemId === note.id), 'locked note never reaches the AI');
    assert.ok(!after.filter(l => l.type === 'token').map(l => l.t).join('').includes('4417'), 'locked content not in answer');
    await api('POST', '/api/ai/unload', {});
  });

  await step('lock hides items until Windows Hello unlock', async () => {
    await waitFor(async () => (await state()).app.lock.hello, 15000, 'hello check');
    if ((await state()).app.lock.hello !== 'Available') { console.log('       (skipped: Windows Hello not available)'); return; }
    await api('POST', '/api/lock/set', { itemIds: [ids['moveme.md']], locked: true });
    await api('POST', '/api/lock/set', { collectionId: 'documents', locked: true });
    const s = await state();
    const hidden = s.items.find(i => i.id === ids['moveme.md']);
    assert.equal(hidden.name, 'Locked item'); assert.equal(hidden.path, undefined); assert.equal(hidden.hidden, true);
    assert.ok(!JSON.stringify(s.items).includes('moveme'), 'no names or paths leak');
    assert.equal(s.app.lock.unlocked, false); assert.equal(s.app.lock.any, true);
    for (const [m, p, b] of [['GET', `/api/items/${ids['moveme.md']}/view`], ['POST', '/api/items/remove', { ids: [ids['moveme.md']] }],
      ['POST', '/api/items/trash', { ids: [ids['moveme.md']] }], ['POST', '/api/lock/set', { itemIds: [ids['moveme.md']], locked: false }]]) {
      assert.equal((await api(m, p, b, { 'x-expect-error': 1 })).status, 423, p);
    }
    assert.equal((await fetch(`${BASE}/f/${ids['moveme.md']}/moveme.md`)).status, 423);
    const acts = (await api('GET', '/api/activity')).json;
    assert.ok(!acts.some(a => a.itemId === ids['moveme.md'] && /moveme/.test(a.message)), 'activity redacted');
  });

  console.log(`\nAll ${passed} steps passed.`);
} catch (e) {
  console.log('\n--- server output ---\n' + serverOut.slice(-4000));
  process.exitCode = 1;
} finally {
  try { await api('POST', '/api/shutdown', {}); } catch {}
  await sleep(500);
  server.kill();
}
