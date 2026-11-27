// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Local AI through Ollama: ask questions about your own notes and files (with sources), summarize or
// explain a file, suggest tags. Everything stays on this PC. Locked items are never indexed or sent.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { kindOf, readText, extOf, langOf } from './files.js';
import { AiBook } from './ai-book.js';

const OLLAMA = 'http://127.0.0.1:11434';
const CHUNK = 1200, OVERLAP = 150, MAX_FILE = 300 * 1024, MAX_CHUNKS = 12000;
const DOCS_PER_FOLDER = 80, CARDS_PER_FOLDER = 30, WALK_DEPTH = 4, WALK_ENTRIES = 8000;
const DOC_EXT = new Set(['md', 'markdown', 'txt', 'rst', 'org', 'adoc']);
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', 'dist', 'build', 'bin', 'obj', '.cache',
  'out', 'packages', 'coverage', 'graphify-out', 'edge-profile', 'site-packages', 'target', 'vendor']);
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json'];
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const stripThink = s => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
const noCreds = url => String(url).replace(/(\/\/)[^@/\s]+@/, '$1');

/** How much a doc inside a project folder matters: READMEs first, then hand-off notes and docs/, then other notes. */
function docPriority(name, rel) {
  if (/^readme/i.test(name)) return 0;
  if (/^(handoff|changelog|roadmap|plan|architecture|overview|notes|todo|getting-started|deploy|runbook|memory)/i.test(name) || /(^|\/)docs\//i.test(rel)) return 1;
  return extOf(name) === 'md' ? 2 : 3;
}

/** A plain-text overview of a project folder (stack, git remote, scripts, README intro, layout), or null if it isn't one. */
async function projectCard(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  const names = entries.map(e => e.name);
  const has = n => names.includes(n);
  const dotnet = names.filter(n => /\.(sln|csproj)$/i.test(n));
  if (!PROJECT_MARKERS.some(has) && !dotnet.length) return null;
  const stack = [], lines = [];
  if (has('package.json')) {
    try {
      const p = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
      const deps = { ...p.dependencies, ...p.devDependencies };
      for (const [k, label] of [['next', 'Next.js'], ['react', 'React'], ['vite', 'Vite'], ['express', 'Express'], ['electron', 'Electron'],
        ['discord.js', 'discord.js'], ['tailwindcss', 'Tailwind'], ['typescript', 'TypeScript'], ['prisma', 'Prisma'], ['astro', 'Astro']]) if (deps[k]) stack.push(label);
      if (!stack.length) stack.push('Node.js');
      if (p.name) lines.push(`npm package: ${p.name}${p.version ? ' ' + p.version : ''}`);
      if (p.description) lines.push(`Description: ${p.description}`);
      const sc = Object.entries(p.scripts || {}).slice(0, 14).map(([k, v]) => `  npm run ${k}  ->  ${String(v).slice(0, 110)}`);
      if (sc.length) lines.push('npm scripts:\n' + sc.join('\n'));
    } catch {}
  }
  if (dotnet.length) {
    stack.push('.NET / C#');
    const fw = new Set();
    for (const f of dotnet.filter(n => /\.csproj$/i.test(n)).slice(0, 6)) {
      try { const x = await fsp.readFile(path.join(dir, f), 'utf8'); for (const m of x.matchAll(/<TargetFrameworks?>([^<]+)</g)) m[1].split(';').forEach(t => fw.add(t.trim())); } catch {}
    }
    lines.push(`.NET: ${dotnet.slice(0, 8).join(', ')}${fw.size ? ` (targets ${[...fw].join(', ')})` : ''}. Build with: dotnet build`);
  }
  if (has('requirements.txt') || has('pyproject.toml')) stack.push('Python');
  if (has('Cargo.toml')) stack.push('Rust');
  if (has('go.mod')) stack.push('Go');
  if (has('.git')) {
    try {
      let gitDir = path.join(dir, '.git');
      if ((await fsp.stat(gitDir)).isFile()) gitDir = path.resolve(dir, (await fsp.readFile(gitDir, 'utf8')).replace(/^gitdir:\s*/i, '').trim());
      const cfg = await fsp.readFile(path.join(gitDir, 'config'), 'utf8').catch(() => '');
      const head = (await fsp.readFile(path.join(gitDir, 'HEAD'), 'utf8').catch(() => '')).trim().replace(/^ref:\s*refs\/heads\//, '');
      const remote = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1];
      lines.push(`Git: ${remote ? 'remote ' + noCreds(remote) : 'local repository, no remote (only copy is on this PC)'}${head ? `, branch ${head}` : ''}`);
    } catch {}
  }
  const readme = names.find(n => /^readme(\.(md|txt|markdown))?$/i.test(n));
  if (readme) {
    try {
      const t = (await readText(path.join(dir, readme), 4000)).text.replace(/<[^>]+>/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
      const intro = t.split(/\n\s*\n/).map(s => s.trim()).filter(s => s && !/^(\[!\[|---|```)/.test(s)).slice(0, 3).join('\n');
      lines.push(`README (${readme}) begins:\n${intro.slice(0, 900)}`);
    } catch {}
  } else lines.push('No README yet.');
  const shown = entries.filter(e => !e.name.startsWith('.') || e.name === '.github').slice(0, 45).map(e => e.name + (e.isDirectory() ? '/' : ''));
  lines.push(`Top level: ${shown.join(', ')}${entries.length > 45 ? ', …' : ''}`);
  return { stack, readme, text: `${stack.length ? 'Stack: ' + stack.join(', ') + '\n' : ''}${lines.join('\n')}` };
}

function chunkText(text) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n/);
  const out = [];
  let cur = '';
  for (let p of paras) {
    while (p.length > CHUNK) { if (cur) { out.push(cur); cur = ''; } out.push(p.slice(0, CHUNK)); p = p.slice(CHUNK - OVERLAP); }
    if ((cur + '\n\n' + p).length > CHUNK && cur) { out.push(cur); cur = cur.slice(-OVERLAP) + '\n\n' + p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

const words = s => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
const toB64 = arr => { const f = new Float32Array(arr); let n = 0; for (const x of f) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < f.length; i++) f[i] /= n; return Buffer.from(f.buffer).toString('base64'); };
const fromB64 = s => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };

export class Ai {
  constructor({ store, emit, dataDir, isLocked, openApp }) {
    this.store = store;
    this.emit = emit;
    this.isLocked = isLocked;
    this.openApp = openApp;
    this.file = path.join(dataDir, 'ai-index.json');
    this.chunks = [];
    this.meta = { embedModel: null, at: null };
    this.caps = new Map();
    this.noThink = new Set();
    this.job = null;
    this.pull = null;
    this.timer = null;
    this.book = new AiBook(dataDir);
    this.load();
  }

  get cfg() {
    const s = this.store.settings;
    s.ai = { enabled: true, autoIndex: true, model: null, embedModel: null, ...(s.ai || {}) };
    return s.ai;
  }

  async load() {
    try {
      const d = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this.chunks = d.chunks || [];
      this.meta = d.meta || this.meta;
    } catch {}
  }
  async save() {
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ meta: this.meta, chunks: this.chunks }));
    await fsp.rename(tmp, this.file);
  }

  async api(p, body, { signal, timeout = 120000 } = {}) {
    const res = await fetch(OLLAMA + p, {
      method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined, signal: signal || AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) { const e = new Error(json?.error || text || `Ollama answered ${res.status}`); e.status = res.status; throw e; }
    return json;
  }

  async capabilities(name) {
    if (this.caps.has(name)) return this.caps.get(name);
    let caps = [];
    try { caps = (await this.api('/api/show', { model: name }, { timeout: 8000 })).capabilities || []; } catch {}
    if (!caps.length) caps = /embed/i.test(name) ? ['embedding'] : ['completion'];
    this.caps.set(name, caps);
    return caps;
  }

  async status() {
    const cfg = this.cfg;
    const out = { enabled: cfg.enabled, autoIndex: cfg.autoIndex, running: false, version: null, chatModels: [], embedModels: [], loaded: [],
      model: null, embedModel: null, pull: this.pull, job: this.job && { ...this.job, promise: undefined },
      index: { chunks: this.chunks.length, items: new Set(this.chunks.map(c => c.itemId)).size, at: this.meta.at, embedModel: this.meta.embedModel } };
    try { out.version = (await this.api('/api/version', null, { timeout: 2000 })).version; out.running = true; } catch { return out; }
    const tags = (await this.api('/api/tags', null, { timeout: 5000 })).models || [];
    for (const m of tags) {
      const caps = await this.capabilities(m.name);
      const entry = { name: m.name, size: m.size, params: m.details?.parameter_size || '', vision: caps.includes('vision') };
      (caps.includes('embedding') && !caps.includes('completion') ? out.embedModels : out.chatModels).push(entry);
    }
    out.model = out.chatModels.find(m => m.name === cfg.model)?.name || out.chatModels[0]?.name || null;
    out.embedModel = out.embedModels.find(m => m.name === cfg.embedModel)?.name || out.embedModels[0]?.name || null;
    try {
      out.loaded = ((await this.api('/api/ps', null, { timeout: 3000 })).models || []).map(m => ({ name: m.name, size: m.size, vram: m.size_vram, until: m.expires_at }));
    } catch {}
    return out;
  }

  // ---------- indexing ----------
  scheduleIndex(delay = 60000) {
    if (!this.cfg.enabled || !this.cfg.autoIndex) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.updateIndex().catch(() => {}), delay);
  }

  baseText(item) {
    const col = this.store.collections.find(c => c.id === item.collection)?.name;
    const lines = [item.name, { file: 'File', folder: 'Folder', link: 'Saved website', note: 'Note' }[item.kind] || item.kind];
    if (item.path) lines.push(`Location: ${item.path}`);
    if (item.url) lines.push(`URL: ${item.url}`);
    if (item.meta?.title && item.meta.title !== item.name) lines.push(item.meta.title);
    if (item.meta?.siteName) lines.push(`Site: ${item.meta.siteName}`);
    if (item.meta?.description) lines.push(item.meta.description);
    if (item.description) lines.push(item.description);
    if (item.tags?.length) lines.push(`Tags: ${item.tags.join(', ')}`);
    if (col) lines.push(`Collection: ${col}`);
    if (item.kind === 'note' && item.body) lines.push('', item.body);
    return lines.join('\n');
  }

  async collectDocs() {
    const docs = [];
    for (const item of this.store.items) {
      if (this.isLocked(item)) continue;
      const base = this.baseText(item);
      docs.push({ key: item.id, itemId: item.id, rel: '', title: item.name, sig: sha(base), text: async () => base });
      if (item.status && item.status !== 'ok') continue;
      if (item.kind === 'file' && ['text', 'markdown'].includes(kindOf(item.path)) && (item.fp?.size || 0) < MAX_FILE) {
        docs.push({ key: item.id + '|f', itemId: item.id, rel: '', title: item.name, sig: `${item.fp?.size}:${item.fp?.mtimeMs}`, text: async () => (await readText(item.path, MAX_FILE)).text });
      }
      if (item.kind === 'folder') {
        // Walk breadth-first, collect every note/README candidate, then keep the ones that matter most.
        const cands = [], projectDirs = [{ full: item.path, rel: '' }];
        let seen = 0;
        let level = [{ full: item.path, rel: '' }];
        for (let depth = 0; depth <= WALK_DEPTH && level.length && seen < WALK_ENTRIES; depth++) {
          const next = [];
          for (const d of level) {
            let entries;
            try { entries = await fsp.readdir(d.full, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
              if (++seen > WALK_ENTRIES) break;
              if (e.isSymbolicLink() || e.name.startsWith('.')) continue;
              const full = path.join(d.full, e.name), r = d.rel ? `${d.rel}/${e.name}` : e.name;
              if (e.isDirectory()) {
                if (SKIP.has(e.name.toLowerCase())) continue;
                if (depth < WALK_DEPTH) next.push({ full, rel: r });
                if (depth < 2) projectDirs.push({ full, rel: r });
                continue;
              }
              if (!DOC_EXT.has(extOf(e.name)) && !/^readme/i.test(e.name)) continue;
              cands.push({ full, rel: r, depth, pri: docPriority(e.name, r) });
            }
          }
          level = next;
        }
        cands.sort((a, b) => a.pri - b.pri || a.depth - b.depth);
        let n = 0;
        for (const c of cands) {
          if (n >= DOCS_PER_FOLDER) break;
          try {
            const st = await fsp.stat(c.full);
            if (st.size > MAX_FILE || st.size === 0) continue;
            n++;
            docs.push({ key: `${item.id}|${c.rel}`, itemId: item.id, rel: c.rel, title: `${item.name} › ${c.rel}`, sig: `${st.size}:${st.mtimeMs}`,
              cap: c.pri <= 1 ? 160 : 60, text: async () => (await readText(c.full, MAX_FILE)).text });
          } catch {}
        }
        // Project overview cards: the folder itself and project folders up to two levels in.
        let cards = 0;
        for (const p of projectDirs) {
          if (cards >= CARDS_PER_FOLDER) break;
          const card = await projectCard(p.full).catch(() => null);
          if (!card) continue;
          cards++;
          const name = p.rel ? `${item.name} › ${p.rel}` : item.name;
          const text = `Project overview: ${p.rel ? path.basename(p.full) : item.name}\nLocation: ${p.full}\n${card.text}`;
          docs.push({ key: `${item.id}|card|${p.rel}`, itemId: item.id, rel: card.readme ? (p.rel ? `${p.rel}/${card.readme}` : card.readme) : '',
            title: `${name} (project overview)`, sig: sha(text), cap: 6, text: async () => text });
        }
      }
    }
    return docs;
  }

  async embed(texts, model, kind) {
    const prefix = /nomic/i.test(model) ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
    const r = await this.api('/api/embed', { model, input: texts.map(t => prefix + t), keep_alive: '2m' }, { timeout: 300000 });
    return r.embeddings;
  }

  updateIndex({ force = false } = {}) {
    if (this.job) return this.job.promise;
    const job = { state: 'running', done: 0, total: 0, chunks: 0 };
    this.job = job;
    job.promise = (async () => {
      const st = await this.status();
      if (!st.running) throw new Error('Ollama isn\'t running');
      const model = st.embedModel;
      const docs = await this.collectDocs();
      const byKey = new Map();
      for (const c of this.chunks) { if (!byKey.has(c.key)) byKey.set(c.key, []); byKey.get(c.key).push(c); }
      const keep = [], todo = [];
      for (const d of docs) {
        const old = byKey.get(d.key);
        const fresh = old && old[0].sig === d.sig && (!model || old.every(c => c.v && c.m === model));
        if (fresh && !force) keep.push(...old.map(c => ({ ...c, title: d.title })));
        else todo.push(d);
      }
      job.total = todo.length;
      const added = [];
      let last = 0;
      for (const d of todo) {
        if (keep.length + added.length >= MAX_CHUNKS) break;
        let text = '';
        try { text = await d.text(); } catch { job.done++; continue; }
        const pieces = chunkText(text).slice(0, d.cap || 60);
        for (let i = 0; i < pieces.length; i += 16) {
          const batch = pieces.slice(i, i + 16);
          const vecs = model ? await this.embed(batch.map(p => `${d.title}\n${p}`), model, 'doc') : [];
          batch.forEach((p, j) => added.push({ key: d.key, itemId: d.itemId, rel: d.rel, title: d.title, sig: d.sig, text: p, m: model || null, v: vecs[j] ? toB64(vecs[j]) : null }));
        }
        job.done++;
        if (Date.now() - last > 400) { last = Date.now(); this.emit('ai', { job: { state: 'running', done: job.done, total: job.total } }); }
      }
      this.chunks = [...keep, ...added];
      this.meta = { embedModel: model, at: new Date().toISOString() };
      await this.save();
      job.state = 'done';
      job.chunks = this.chunks.length;
    })().catch(e => { job.state = 'failed'; job.error = e.message; throw e; })
      .finally(() => { this.job = null; this.emit('ai', { job: { state: job.state, error: job.error, chunks: job.chunks } }); });
    return job.promise;
  }

  async search(query, k = 8) {
    const visible = this.chunks.filter(c => { const it = this.store.item(c.itemId); return it && !this.isLocked(it); });
    if (!visible.length) return [];
    const qw = [...new Set(words(query))];
    const df = new Map();
    for (const c of visible) for (const w of new Set(words(c.text + ' ' + c.title))) if (qw.includes(w)) df.set(w, (df.get(w) || 0) + 1);
    const kw = c => {
      const ws = words(c.text + ' ' + c.title);
      let s = 0;
      for (const w of qw) { const n = ws.filter(x => x === w).length; if (n) s += (1 + Math.log(n)) * Math.log(1 + visible.length / (df.get(w) || 1)); }
      return s;
    };
    let qv = null;
    const model = this.meta.embedModel;
    if (model && visible.some(c => c.v)) { try { qv = new Float32Array((await this.embed([query], model, 'query'))[0]); let n = 0; for (const x of qv) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < qv.length; i++) qv[i] /= n; } catch {} }
    const kwMax = Math.max(1e-9, ...visible.map(kw));
    const scored = visible.map(c => {
      let s = kw(c) / kwMax * (qv ? 0.25 : 1);
      if (qv && c.v) { const v = fromB64(c.v); let d = 0; for (let i = 0; i < v.length && i < qv.length; i++) d += v[i] * qv[i]; s += d; }
      return { c, s };
    }).sort((a, b) => b.s - a.s);
    const out = [], perKey = new Map();
    for (const { c, s } of scored) {
      if (out.length >= k) break;
      if ((perKey.get(c.key) || 0) >= 2 || s <= 0) continue;
      perKey.set(c.key, (perKey.get(c.key) || 0) + 1);
      out.push({ ...c, score: s });
    }
    return out;
  }

  // ---------- chatting ----------
  async chat(model, messages, { onToken, signal, format, keepAlive } = {}) {
    const body = { model, messages, stream: !!onToken, format, keep_alive: keepAlive, options: { temperature: 0.3 } };
    if (!this.noThink.has(model)) body.think = false;
    let res;
    try {
      res = await fetch(OLLAMA + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e) { if (e.name === 'AbortError') throw e; throw new Error('Ollama isn\'t running'); }
    if (!res.ok) {
      const t = await res.text();
      if (/think/i.test(t) && body.think === false) { this.noThink.add(model); return this.chat(model, messages, { onToken, signal, format, keepAlive }); }
      throw new Error((() => { try { return JSON.parse(t).error; } catch { return t; } })() || `Ollama answered ${res.status}`);
    }
    if (!onToken) return (await res.json()).message?.content || '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        const t = j.message?.content || '';
        if (t) { full += t; onToken(t); }
      }
    }
    return full;
  }

  async requireModel() {
    if (!this.cfg.enabled) throw new Error('Local AI is turned off in Settings');
    const st = await this.status();
    if (!st.running) throw new Error('Ollama isn\'t running. Start it from the Ask AI page.');
    if (!st.model) throw new Error('No chat model is installed in Ollama yet');
    return st;
  }

  /** A source as shown to the browser: which project/collection it came from, and a short snippet. */
  sourceInfo(h, i) {
    const it = this.store.item(h.itemId);
    const col = it && this.store.collections.find(c => c.id === it.collection)?.name;
    return { n: i + 1, itemId: h.itemId, rel: h.rel, title: h.title, project: it?.name || '', collection: col || '',
      overview: h.key?.includes('|card|') || false, snippet: h.text.slice(0, 220) };
  }

  systemPrompt(memories) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return [
      `You are the assistant inside DeskVault, a personal organiser running on the user's own Windows PC. Today is ${today}.`,
      'Answer from the numbered sources: the user\'s own notes, project READMEs and docs, files and saved websites. Cite them like [1] or [2].',
      'A source titled "(project overview)" describes a project folder: where it lives, its stack, git remote, scripts and layout. Use it for "where is", "how do I run" and "what is" questions.',
      'Give exact paths, commands and names when the sources have them. If the sources don\'t cover the question, say you couldn\'t find it in their vault, then you may add a short general answer clearly marked as general knowledge.',
      'Be concise and practical. Use Markdown.',
      memories.length ? `\nThings the user asked you to remember (use them when relevant; don't cite them as numbered sources):\n${memories.map(m => `- ${m.text}`).join('\n')}` : '',
    ].join('\n');
  }

  /** Turn a follow-up ("how do I deploy it?") into a standalone search query using the conversation so far. */
  async rewriteQuery(model, turns, question, signal) {
    const convo = turns.slice(-3).map(t => `User: ${t.q}\nAssistant: ${t.a.slice(0, 700)}`).join('\n\n');
    const out = stripThink(await this.chat(model, [
      { role: 'system', content: 'You rewrite a follow-up message as a standalone search query for the user\'s personal files, notes and project docs. Resolve words like "it", "that", "there" and "the other one" from the conversation. Keep names, paths and numbers. Reply with the query only: one line, no quotes, no explanation.' },
      { role: 'user', content: `Conversation:\n${convo}\n\nFollow-up: ${question}\n\nStandalone query:` },
    ], { signal, keepAlive: '5m' }));
    const q = out.split('\n').map(s => s.trim()).find(Boolean)?.replace(/^(standalone query:|query:)\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').slice(0, 300) || '';
    return q.length >= 3 ? q : question;
  }

  async makeTitle(model, q, a) {
    const out = stripThink(await this.chat(model, [{ role: 'user', content: `Write a 3 to 6 word title for this conversation. Reply with the title only, no quotes or punctuation at the end.\n\nUser: ${q.slice(0, 600)}\nAssistant: ${a.slice(0, 600)}` }], { keepAlive: '5m' }));
    const t = out.split('\n').map(s => s.trim()).find(Boolean)?.replace(/^title:\s*/i, '').replace(/^["'`*#\s]+|["'`*.\s]+$/g, '') || '';
    return t.length >= 3 && t.length <= 80 ? t : null;
  }

  /** Facts from one exchange that are worth remembering (the user picks which to keep). */
  async suggestMemory({ q, a }) {
    const st = await this.requireModel();
    const known = this.book.listMemory().slice(0, 40).map(m => `- ${m.text}`).join('\n');
    const out = await this.chat(st.model, [{ role: 'user', content:
      `From this exchange, list up to 3 short facts about the user, their projects, their setup or their preferences that would help answer future questions. Each fact must make sense on its own (include names, paths, versions). Skip small talk, anything temporary, and anything already known.${known ? `\n\nAlready known:\n${known}` : ''}\n\nUser: ${q.slice(0, 2000)}\nAssistant: ${a.slice(0, 4000)}` }], {
      format: { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } }, required: ['facts'] },
    });
    let facts = [];
    try { facts = JSON.parse(stripThink(out)).facts || []; } catch {}
    return [...new Set(facts.map(f => String(f).trim()).filter(f => f.length >= 5 && f.length <= 400))].slice(0, 3);
  }

  async ask({ question, chatId }, send, signal) {
    const st = await this.requireModel();
    let chat = chatId ? this.book.chat(chatId) : null;
    const isNew = !chat;
    if (!chat) chat = this.book.newChat(question);
    send({ type: 'chat', id: chat.id, title: chat.title, isNew });
    const reply = text => { send({ type: 'token', t: text }); this.book.addTurn(chat, { q: question, a: text, sources: [], model: null, kind: 'memory' }); send({ type: 'done', model: null, chatId: chat.id, memory: true }); };

    // "remember that …" / "forget …" are handled without the model.
    const isQuestion = /\?\s*$/.test(question);
    const rem = !isQuestion && question.match(/^\s*(?:please\s+)?remember(?:\s+that)?\s*[:,-]?\s+([\s\S]{3,})$/i);
    if (rem) {
      const m = this.book.addMemory({ text: rem[1].replace(/[.!\s]+$/, ''), source: 'chat', chatId: chat.id });
      this.emit('ai', { memory: true });
      return reply(`Got it. I'll remember:\n\n> ${m.text}\n\nYou can edit or remove it under **Memory**.`);
    }
    const fgt = !isQuestion && question.match(/^\s*(?:please\s+)?forget(?:\s+that|\s+about)?\s+([\s\S]{3,})$/i);
    if (fgt) {
      const m = this.book.findMemory(fgt[1]);
      if (m) { this.book.deleteMemory(m.id); this.emit('ai', { memory: true }); return reply(`Done. I've forgotten:\n\n> ${m.text}`); }
      return reply('I couldn\'t find a memory that matches that. Open **Memory** to see everything I remember.');
    }

    const history = chat.turns.filter(t => t.a && t.kind !== 'memory');
    let query = question;
    if (history.length) {
      send({ type: 'status', text: 'Working out what you mean…' });
      query = await this.rewriteQuery(st.model, history, question, signal).catch(e => { if (e.name === 'AbortError') throw e; return question; });
      if (query !== question) send({ type: 'query', text: query });
    }
    if (!this.chunks.length) { send({ type: 'status', text: 'Reading your vault for the first time…' }); await this.updateIndex(); }
    const hits = await this.search(query === question ? question : `${query}\n${question}`);
    const sources = hits.map((h, i) => this.sourceInfo(h, i));
    send({ type: 'sources', sources });
    const memories = this.book.relevantMemory(`${query} ${question}`);
    const context = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.text}`).join('\n\n---\n\n');
    const messages = [
      { role: 'system', content: this.systemPrompt(memories) },
      ...history.slice(-6).flatMap(t => [{ role: 'user', content: t.q }, { role: 'assistant', content: t.a.slice(0, 3000) }]),
      { role: 'user', content: `Sources:\n\n${context || '(nothing relevant found)'}\n\nQuestion: ${question}` },
    ];
    let full = '';
    const turn = () => ({ q: question, a: stripThink(full), sources, model: st.model, query: query !== question ? query : undefined });
    try {
      await this.chat(st.model, messages, { onToken: t => { full += t; send({ type: 'token', t }); }, signal });
    } catch (e) {
      if (e.name === 'AbortError' && full.trim()) this.book.addTurn(chat, { ...turn(), stopped: true });
      throw e;
    }
    this.book.addTurn(chat, turn());
    send({ type: 'done', model: st.model, chatId: chat.id, memories: memories.length });
    if (chat.autoTitle && chat.turns.length === 1) {
      this.makeTitle(st.model, question, full).then(t => {
        if (t && chat.autoTitle) { chat.title = t; this.book.save('chats'); this.emit('ai', { chats: true }); }
      }).catch(() => {});
    }
  }

  async summarize({ name, text, lang, kind, truncated }, send, signal) {
    const st = await this.requireModel();
    const isCode = kind === 'text' && lang && !['plaintext', 'markdown'].includes(lang);
    const body = text.length > 40000 ? text.slice(0, 40000) : text;
    const cut = truncated || text.length > 40000;
    const task = isCode
      ? `Explain what this ${lang} file does in plain English for someone who didn't write it. Start with a one-sentence overview, then the main parts as bullets, then anything risky or worth double-checking.`
      : 'Summarise this file. Start with one sentence saying what it is, then the key points as short bullets, then anything the reader should act on or remember (dates, numbers, to-dos).';
    const messages = [
      { role: 'system', content: 'You help the user understand their own files. Be accurate and brief. Use Markdown.' },
      { role: 'user', content: `${task}${cut ? '\n(Only the first part of the file is included.)' : ''}\n\nFile: ${name}\n\n\`\`\`\n${body}\n\`\`\`` },
    ];
    send({ type: 'start', model: st.model, isCode });
    await this.chat(st.model, messages, { onToken: t => send({ type: 'token', t }), signal });
    send({ type: 'done' });
  }

  async suggestTags(item, sample) {
    const st = await this.requireModel();
    const existing = [...new Set(this.store.items.flatMap(i => i.tags || []))].slice(0, 60);
    const prompt = `Suggest 2 to 4 short, lowercase tags for this item in a personal file organiser. Prefer reusing these existing tags when they fit: ${existing.join(', ') || '(none yet)'}.\n\n${this.baseText(item)}${sample ? `\n\nContent sample:\n${sample.slice(0, 3000)}` : ''}`;
    const out = await this.chat(st.model, [{ role: 'user', content: prompt }], {
      format: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'] },
    });
    let tags = [];
    try { tags = JSON.parse(out).tags || []; } catch {}
    return [...new Set(tags.map(t => String(t).toLowerCase().replace(/^#/, '').trim().replace(/\s+/g, '-')).filter(t => t && t.length <= 30))].slice(0, 4);
  }

  // ---------- housekeeping ----------
  async unload() {
    const st = await this.status();
    for (const m of st.loaded) await this.api('/api/generate', { model: m.name, keep_alive: 0 }, { timeout: 15000 }).catch(() => {});
    return { freed: st.loaded.reduce((s, m) => s + (m.vram || 0), 0) };
  }

  startPull(model) {
    if (this.pull?.state === 'running') throw new Error('A download is already running');
    const p = { model, state: 'running', status: 'starting', completed: 0, total: 0 };
    this.pull = p;
    (async () => {
      const res = await fetch(OLLAMA + '/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
      if (!res.ok) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', last = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const j = JSON.parse(line);
          if (j.error) throw new Error(j.error);
          p.status = j.status;
          if (j.total) { p.total = j.total; p.completed = j.completed || 0; }
          if (Date.now() - last > 300) { last = Date.now(); this.emit('ai', { pull: p }); }
        }
      }
      p.state = 'done';
      this.caps.delete(model);
    })().catch(e => { p.state = 'failed'; p.error = e.message; }).finally(() => { this.emit('ai', { pull: p }); if (p.state === 'done') this.scheduleIndex(2000); });
    return p;
  }
}
