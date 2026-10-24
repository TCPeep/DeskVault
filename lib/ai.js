// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Local AI through Ollama: ask questions about your own notes and files (with sources), summarize or
// explain a file, suggest tags. Everything stays on this PC. Locked items are never indexed or sent.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { kindOf, readText, extOf, langOf } from './files.js';

const OLLAMA = 'http://127.0.0.1:11434';
const CHUNK = 1200, OVERLAP = 150, MAX_FILE = 300 * 1024, MAX_CHUNKS = 8000;
const DOC_EXT = new Set(['md', 'markdown', 'txt', 'rst', 'org', 'adoc']);
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', 'dist', 'build', 'bin', 'obj', '.cache']);
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

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
        let n = 0;
        const walk = async (dir, rel, depth) => {
          let entries;
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (n >= 40) return;
            if (e.isSymbolicLink() || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { if (depth < 3 && !SKIP.has(e.name.toLowerCase())) await walk(full, r, depth + 1); continue; }
            if (!DOC_EXT.has(extOf(e.name)) && !/^readme/i.test(e.name)) continue;
            try {
              const st = await fsp.stat(full);
              if (st.size > MAX_FILE || st.size === 0) continue;
              n++;
              docs.push({ key: `${item.id}|${r}`, itemId: item.id, rel: r, title: `${item.name} › ${r}`, sig: `${st.size}:${st.mtimeMs}`, text: async () => (await readText(full, MAX_FILE)).text });
            } catch {}
          }
        };
        await walk(item.path, '', 0);
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
        const pieces = chunkText(text).slice(0, 60);
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

  async search(query, k = 6) {
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

  async ask({ question, history = [] }, send, signal) {
    const st = await this.requireModel();
    if (!this.chunks.length) { send({ type: 'status', text: 'Reading your Vault for the first time…' }); await this.updateIndex(); }
    const hits = await this.search(question);
    send({ type: 'sources', sources: hits.map((h, i) => ({ n: i + 1, itemId: h.itemId, rel: h.rel, title: h.title, snippet: h.text.slice(0, 220) })) });
    const sources = hits.map((h, i) => `[${i + 1}] ${h.title}${h.rel ? '' : ''}\n${h.text}`).join('\n\n---\n\n');
    const messages = [
      { role: 'system', content: 'You are the assistant inside Vault, a personal file organiser on the user\'s own PC. Answer from the numbered sources (their own notes, files and saved websites) and cite them like [1] or [2]. If the sources don\'t cover the question, say you couldn\'t find it in their Vault, then you may add a short general answer clearly marked as general knowledge. Be concise and practical. Use Markdown.' },
      ...history.slice(-4).flatMap(h => [{ role: 'user', content: h.q }, { role: 'assistant', content: h.a }]),
      { role: 'user', content: `Sources:\n\n${sources || '(nothing relevant found)'}\n\nQuestion: ${question}` },
    ];
    await this.chat(st.model, messages, { onToken: t => send({ type: 'token', t }), signal });
    send({ type: 'done', model: st.model });
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
