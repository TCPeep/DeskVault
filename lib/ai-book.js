// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Saved Ask AI chats and the AI's memory (facts the user asked it to keep). Both live in data\ as JSON,
// written atomically, and never leave this PC.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const newId = () => crypto.randomBytes(6).toString('base64url');
const words = s => (String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
const STOP = new Set('the and for that this with you your are was were have has had what when where which who how about from into they them then than there their will would could should just like does did not can all any our out get got its'.split(' '));
const MAX_CHATS = 500, MAX_TURNS = 200, MAX_MEMORY = 300;

export class AiBook {
  constructor(dataDir) {
    this.chatsFile = path.join(dataDir, 'ai-chats.json');
    this.memFile = path.join(dataDir, 'ai-memory.json');
    this.chats = this.read(this.chatsFile, 'chats');
    this.memory = this.read(this.memFile, 'memory');
    this.timers = {};
  }

  read(file, key) {
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d[key]) ? d[key] : []; } catch { return []; }
  }
  save(which) {
    clearTimeout(this.timers[which]);
    this.timers[which] = setTimeout(() => this.flush(which).catch(() => {}), 300);
  }
  async flush(which) {
    const [file, key] = which === 'chats' ? [this.chatsFile, 'chats'] : [this.memFile, 'memory'];
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, [key]: this[key] }));
    await fsp.rename(tmp, file);
  }
  flushAll() {
    for (const w of ['chats', 'memory']) {
      clearTimeout(this.timers[w]);
      const [file, key] = w === 'chats' ? [this.chatsFile, 'chats'] : [this.memFile, 'memory'];
      try { fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, [key]: this[key] })); fs.renameSync(file + '.tmp', file); } catch {}
    }
  }

  // ---------- chats ----------
  listChats(q = '') {
    const needle = String(q).trim().toLowerCase();
    return this.chats
      .filter(c => !needle || c.title.toLowerCase().includes(needle) || c.turns.some(t => t.q.toLowerCase().includes(needle) || t.a.toLowerCase().includes(needle)))
      .sort((a, b) => (b.pinned - a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
      .map(c => ({ id: c.id, title: c.title, pinned: !!c.pinned, createdAt: c.createdAt, updatedAt: c.updatedAt, turns: c.turns.length,
        preview: (c.turns.at(-1)?.q || '').slice(0, 120) }));
  }
  chat(id) { return this.chats.find(c => c.id === id) || null; }
  newChat(firstQuestion) {
    const at = new Date().toISOString();
    const c = { id: newId(), title: titleFrom(firstQuestion), autoTitle: true, pinned: false, createdAt: at, updatedAt: at, turns: [] };
    this.chats.push(c);
    if (this.chats.length > MAX_CHATS) {
      const drop = this.chats.filter(x => !x.pinned).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (drop) this.chats.splice(this.chats.indexOf(drop), 1);
    }
    this.save('chats');
    return c;
  }
  addTurn(chat, turn) {
    chat.turns.push({ at: new Date().toISOString(), ...turn });
    if (chat.turns.length > MAX_TURNS) chat.turns.splice(0, chat.turns.length - MAX_TURNS);
    chat.updatedAt = new Date().toISOString();
    this.save('chats');
  }
  updateChat(id, { title, pinned }) {
    const c = this.chat(id);
    if (!c) return null;
    if (typeof title === 'string' && title.trim()) { c.title = title.trim().slice(0, 120); c.autoTitle = false; }
    if (pinned !== undefined) c.pinned = !!pinned;
    this.save('chats');
    return c;
  }
  deleteChat(id) {
    const i = this.chats.findIndex(c => c.id === id);
    if (i < 0) return false;
    this.chats.splice(i, 1);
    this.save('chats');
    return true;
  }

  // ---------- memory ----------
  listMemory() { return [...this.memory].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  addMemory({ text, source = 'manual', chatId = null }) {
    const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 600);
    if (t.length < 3) throw new Error('That memory is too short');
    const dupe = this.memory.find(m => m.text.toLowerCase() === t.toLowerCase());
    if (dupe) return dupe;
    if (this.memory.length >= MAX_MEMORY) throw new Error(`Memory is full (${MAX_MEMORY}). Remove a few first.`);
    const at = new Date().toISOString();
    const m = { id: newId(), text: t, source, chatId, createdAt: at, updatedAt: at };
    this.memory.push(m);
    this.save('memory');
    return m;
  }
  updateMemory(id, text) {
    const m = this.memory.find(x => x.id === id);
    if (!m) return null;
    const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 600);
    if (t.length < 3) throw new Error('That memory is too short');
    m.text = t; m.updatedAt = new Date().toISOString();
    this.save('memory');
    return m;
  }
  deleteMemory(id) {
    const i = this.memory.findIndex(m => m.id === id);
    if (i < 0) return false;
    this.memory.splice(i, 1);
    this.save('memory');
    return true;
  }
  /** Memory closest to a "forget …" request, by shared words. */
  findMemory(text) {
    const q = new Set(words(text).filter(w => !STOP.has(w)));
    let best = null, bestScore = 0;
    for (const m of this.memory) {
      const s = words(m.text).filter(w => q.has(w)).length / Math.max(1, q.size);
      if (s > bestScore) { best = m; bestScore = s; }
    }
    return bestScore >= 0.5 ? best : null;
  }
  /** Memory worth putting in front of the model: all of it while it's small, else the most related plus the newest. */
  relevantMemory(question, budget = 3500) {
    const all = this.listMemory();
    const total = all.reduce((s, m) => s + m.text.length + 3, 0);
    if (total <= budget) return all;
    const q = new Set(words(question).filter(w => !STOP.has(w)));
    const scored = all.map((m, i) => ({ m, s: words(m.text).filter(w => q.has(w)).length * 10 - i * 0.01 })).sort((a, b) => b.s - a.s);
    const out = [];
    let used = 0;
    for (const { m } of scored) { if (used + m.text.length > budget) continue; out.push(m); used += m.text.length + 3; }
    return out;
  }
}

export function titleFrom(q) {
  const t = String(q || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 57).replace(/\s+\S*$/, '') + '…' : t || 'New chat';
}
