// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Ask AI page (questions about your own notes/files, answered by the local Ollama model with sources),
// with saved chats and a memory of facts you asked it to keep, plus the Summarize/Explain dialog and
// tag suggestions used elsewhere.
import { S, refresh, parseHash, openItem, itemById, load as loadPref, save as savePref } from './state.js';
import { get, post, stream } from './api.js';
import * as ui from './ui.js';
const { esc, icon } = ui;

const AI = { page: null, status: null, chat: [], chatId: null, chatTitle: '', chats: [], chatQ: '', memory: [], busy: null, railOpen: false };
const host = () => (parseHash().name === 'ai' ? AI.page?.querySelector('#aip') : null);

function md(text) {
  if (!window.marked || !window.DOMPurify) return `<p>${esc(text)}</p>`;
  return window.DOMPurify.sanitize(window.marked.parse(text || '', { gfm: true }));
}

/** Turn [1] in an answer into clickable citations. */
function linkCitations(el, sources) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (/\[\d+\]/.test(walker.currentNode.nodeValue) && !walker.currentNode.parentElement.closest('code, pre')) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    n.nodeValue.replace(/\[(\d+)\]/g, (m, num, i) => {
      frag.append(n.nodeValue.slice(last, i));
      const s = sources.find(x => x.n === +num);
      if (s) {
        const b = document.createElement('button');
        b.className = 'cite'; b.dataset.n = num; b.textContent = num; b.title = s.title;
        frag.append(b);
      } else frag.append(m);
      last = i + m.length;
    });
    frag.append(n.nodeValue.slice(last));
    n.replaceWith(frag);
  }
}

export async function renderAi(page) {
  AI.page = page;
  if (!page.querySelector('#aip')) page.innerHTML = `<div id="aip" class="ai-page"><div class="page-head"><h1>Ask AI</h1></div><div class="loading">${icon('loader', 'spin')}</div></div>`;
  await Promise.all([loadStatus(), loadChats(), loadMemory()]);
  const last = loadPref('aiChat', '');
  if (!AI.chat.length && !AI.chatId && last && AI.chats.some(c => c.id === last)) await openChat(last, false);
  draw();
}

async function loadStatus() {
  try { AI.status = await get('/api/ai/status'); } catch (e) { AI.status = { running: false, error: e.message }; }
}
async function loadChats() {
  try { AI.chats = await get('/api/ai/chats' + (AI.chatQ ? `?q=${encodeURIComponent(AI.chatQ)}` : '')); } catch { AI.chats = []; }
}
async function loadMemory() {
  try { AI.memory = await get('/api/ai/memory'); } catch { AI.memory = []; }
}

async function openChat(id, redraw = true) {
  if (AI.busy) AI.busy.abort();
  try {
    const c = await get(`/api/ai/chats/${encodeURIComponent(id)}`);
    AI.chatId = c.id; AI.chatTitle = c.title;
    AI.chat = c.turns.map(t => ({ ...t, done: true, error: null }));
    savePref('aiChat', c.id);
  } catch (e) { ui.toast(e.message, { type: 'warn' }); AI.chatId = null; AI.chat = []; savePref('aiChat', ''); }
  AI.railOpen = false;
  if (redraw) { draw(); AI.page.scrollTop = AI.page.scrollHeight; }
}

function newChat() {
  if (AI.busy) AI.busy.abort();
  AI.chat = []; AI.chatId = null; AI.chatTitle = '';
  savePref('aiChat', '');
  AI.railOpen = false;
  draw();
}

function draw() {
  const el = host();
  if (!el) return;
  el.innerHTML = `
    <div class="page-head"><h1>${icon('sparkle')} Ask AI</h1><span class="sub">Answers from your own notes, project docs, files and saved sites, using the AI on this PC. Nothing leaves your computer.</span>
      <div class="grow"></div>
      <button class="btn sm ai-rail-toggle" data-act="rail">${icon('history')}Chats</button>
      <button class="btn sm" data-act="memory" title="Facts the AI keeps in mind for every answer">${icon('bookmark')}Memory${AI.memory.length ? ` <span class="count">${AI.memory.length}</span>` : ''}</button>
      ${AI.chat.length ? `<button class="btn sm" data-act="new-chat">${icon('plus')}New chat</button>` : ''}</div>
    <section class="panel ai-status" id="aiStatus">${statusHtml()}</section>
    <div class="ai-layout">
      <aside class="ai-rail ${AI.railOpen ? 'open' : ''}" id="aiRail">${railHtml()}</aside>
      <div class="ai-main">
        ${AI.chatId ? `<div class="ai-chat-head"><span class="ai-chat-title" title="${esc(AI.chatTitle)}">${esc(AI.chatTitle)}</span><button class="icon-btn" data-act="rename" title="Rename chat">${icon('edit')}</button></div>` : ''}
        <div class="ai-thread" id="aiThread">${threadHtml()}</div>
        <form class="ai-compose" id="aiCompose">${composeHtml()}</form>
      </div>
    </div>`;
  for (const t of AI.chat) paintTurn(t);
  const q = el.querySelector('#aiq');
  if (q && !AI.busy) q.focus();
}

function railHtml() {
  const day = v => { const d = new Date(v), now = new Date(); const diff = Math.floor((now.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5); return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'This week' : diff < 31 ? 'This month' : 'Older'; };
  let lastGroup = null;
  const rows = AI.chats.map(c => {
    const g = c.pinned ? 'Pinned' : day(c.updatedAt);
    const head = g !== lastGroup ? `<div class="ai-rail-group">${g}</div>` : '';
    lastGroup = g;
    return `${head}<div class="ai-chat-row ${c.id === AI.chatId ? 'active' : ''}" data-chat="${esc(c.id)}" title="${esc(c.preview)}">
      <span class="t">${c.pinned ? icon('pin') : ''}${esc(c.title)}</span>
      <button class="icon-btn" data-chat-menu="${esc(c.id)}" aria-label="Chat options">${icon('more')}</button></div>`;
  }).join('');
  return `<div class="ai-rail-head"><input class="input" id="aiChatSearch" placeholder="Search chats" value="${esc(AI.chatQ)}"></div>
    <div class="ai-rail-list">${rows || `<p class="muted ai-rail-empty">${AI.chatQ ? 'No chats match.' : 'Your chats are saved here.'}</p>`}</div>`;
}
function redrawRail() { const r = host()?.querySelector('#aiRail'); if (!r) return; const had = document.activeElement?.id === 'aiChatSearch'; r.innerHTML = railHtml(); if (had) { const i = r.querySelector('#aiChatSearch'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }

function statusHtml() {
  const st = AI.status;
  if (!st) return '';
  if (!st.enabled) return `<div class="ai-row">${icon('power')}<span class="grow">Local AI is turned off.</span><button class="btn sm primary" data-act="enable">Turn on</button></div>`;
  if (!st.running) return `<div class="ai-row">${icon('alert')}<span class="grow"><b>Ollama isn't running.</b> It powers the AI. Start it and this page connects by itself.</span><button class="btn sm primary" data-act="start">${icon('power')}Start Ollama</button></div>`;
  const gpu = (st.loaded || []).reduce((s, m) => s + (m.vram || 0), 0);
  const job = st.job, pull = st.pull;
  const idx = st.index;
  return `<div class="ai-row">
      <span class="badge ok">${icon('check')}Running on your PC</span>
      <label class="ai-field">Model <select class="input" data-ai="model">${st.chatModels.map(m => `<option value="${esc(m.name)}" ${m.name === st.model ? 'selected' : ''}>${esc(m.name)}${m.params ? ` (${esc(m.params)})` : ''}</option>`).join('') || '<option>None installed</option>'}</select></label>
      <span class="grow"></span>
      ${gpu ? `<span class="muted">Using ${ui.fmtBytes(gpu)} of GPU memory</span><button class="btn sm" data-act="unload" title="Do this before gaming">${icon('power')}Free GPU memory</button>` : `<span class="muted">${icon('check')} GPU memory is free</span>`}
    </div>
    <div class="ai-row">
      ${st.embedModel
        ? `<span>${icon('search')} Knows <b>${idx.chunks.toLocaleString()}</b> passages from <b>${idx.items}</b> item${idx.items === 1 ? '' : 's'}${idx.at ? ` · updated ${esc(ui.timeAgo(idx.at))}` : ''}</span>`
        : `<span>${icon('info')} For much better answers, download the <b>search helper</b> (270 MB, goes next to your other models).</span>`}
      <span class="grow"></span>
      ${job?.state === 'running' ? `<span class="muted">${icon('loader', 'spin')} Reading your vault… ${job.done}/${job.total}</span>`
        : pull?.state === 'running' ? `<span class="muted">${icon('loader', 'spin')} Downloading ${esc(pull.model)}… ${pull.total ? Math.floor(pull.completed / pull.total * 100) + '%' : esc(pull.status)}</span>`
        : st.embedModel ? `<button class="btn sm ghost" data-act="reindex">${icon('refresh')}Update</button>` : `<button class="btn sm primary" data-act="pull-embed">${icon('import')}Download search helper</button>`}
    </div>
    ${pull?.state === 'failed' ? `<div class="ai-row" style="color:var(--danger)">${icon('alert')} Download failed: ${esc(pull.error)}</div>` : ''}
    ${job?.state === 'failed' ? `<div class="ai-row" style="color:var(--danger)">${icon('alert')} ${esc(job.error)}</div>` : ''}`;
}

function examples() {
  const ex = [];
  const cols = S.collections.filter(c => !c.locked && S.items.some(i => i.collection === c.id));
  const tags = [...new Set(S.items.filter(i => !i.hidden).flatMap(i => i.tags || []))];
  const proj = S.items.find(i => i.kind === 'folder' && !i.hidden && i.collection === 'projects');
  if (proj) ex.push(`How do I run ${proj.name}?`);
  if (cols[0]) ex.push(`What's in my ${cols[0].name} collection?`);
  if (S.items.some(i => i.kind === 'note' && !i.hidden)) ex.push('Summarise my notes');
  if (tags[0]) ex.push(`What do I have about ${tags[0]}?`);
  ex.push('Which of my projects have no git remote?');
  ex.push('What did I write down that I still need to do?');
  return ex.slice(0, 5);
}

function threadHtml() {
  if (!AI.chat.length) return `<div class="empty ai-empty"><div class="tile xl c-video">${icon('sparkle')}</div>
    <h2>Ask about your stuff</h2>
    <p>The AI reads your notes, saved sites, project READMEs and docs, and the text files inside your vault, then answers with links to where it found things. Locked items are never shown to it.</p>
    <p class="muted" style="font-size:13px">Tip: start a message with <b>remember that…</b> to teach it something for every future answer, or <b>forget…</b> to take it back.</p>
    <div class="ai-examples">${examples().map(e => `<button class="chip" data-example="${esc(e)}">${esc(e)}</button>`).join('')}</div></div>`;
  return AI.chat.map((t, i) => `<div class="msg user">${esc(t.q)}</div><div class="msg ai" data-turn="${i}"></div>`).join('');
}

function sourceChip(s) {
  if (s.locked) return `<span class="chip muted"><b>${s.n}</b>${icon('lock')}Locked item</span>`;
  const label = s.overview ? `${esc(s.project || s.title.replace(/ \(project overview\)$/, ''))} <span class="ai-src-tag">overview</span>` : esc(s.title);
  const where = s.collection ? `${s.collection}: ` : '';
  return `<button class="chip" data-src="${s.n}" title="${esc(where + s.title + (s.snippet ? '\n\n' + s.snippet : ''))}"><b>${s.n}</b>${label}</button>`;
}

function paintTurn(t) {
  const i = AI.chat.indexOf(t);
  const el = host()?.querySelector(`.msg.ai[data-turn="${i}"]`);
  if (!el) return;
  const body = t.a ? md(t.a) : t.error ? '' : `<p class="muted">${icon('loader', 'spin')} ${esc(t.status || (t.sources ? 'Thinking…' : 'Looking through your vault…'))}</p>`;
  const memoryTurn = t.kind === 'memory';
  el.innerHTML = `${t.query && !memoryTurn ? `<div class="ai-query muted" title="What the AI searched your vault for">${icon('search')} ${esc(t.query)}</div>` : ''}
    <div class="md">${body}${t.done || !t.a ? '' : '<span class="caret"></span>'}</div>
    ${t.stopped ? `<p class="muted" style="font-size:12px;margin:6px 0 0">Stopped early.</p>` : ''}
    ${t.error ? `<p class="ai-err">${icon('alert')} ${esc(t.error)}</p>` : ''}
    ${t.sources?.length && t.done ? `<div class="ai-sources"><span class="muted">Sources</span>${t.sources.map(sourceChip).join('')}</div>` : ''}
    ${t.done && !t.error && !memoryTurn ? `<div class="ai-tools"><button class="icon-btn" data-act="copy" title="Copy answer">${icon('copy')}</button>${AI.chatId ? `<button class="btn sm ghost" data-act="remember" title="Pick facts from this answer for the AI to keep in mind">${icon('bookmark')}Remember…</button>` : ''}<span class="muted">Local AI can be wrong. Check the sources for anything important.</span></div>` : ''}`;
  linkCitations(el.querySelector('.md'), t.sources || []);
}

function composeHtml() {
  return `<textarea id="aiq" class="input" rows="1" placeholder="${AI.chat.length ? 'Ask a follow-up…' : 'Ask about your notes, projects, files and saved sites…'}" ${AI.status?.running && AI.status?.model ? '' : 'disabled'}></textarea>
    ${AI.busy ? `<button class="btn" type="button" data-act="stop">${icon('x')}Stop</button>` : `<button class="btn primary" type="submit">${icon('sparkle')}Ask</button>`}`;
}

function redrawCompose() {
  const f = host()?.querySelector('#aiCompose');
  if (!f) return;
  const val = f.querySelector('#aiq')?.value || '';
  f.innerHTML = composeHtml();
  f.querySelector('#aiq').value = val;
}

let paintQueued = null;
function schedulePaint(t) {
  if (paintQueued) return;
  paintQueued = requestAnimationFrame(() => {
    paintQueued = null;
    const page = AI.page;
    const nearBottom = page.scrollHeight - page.scrollTop - page.clientHeight < 160;
    paintTurn(t);
    if (nearBottom) page.scrollTop = page.scrollHeight;
  });
}

async function ask(question) {
  if (AI.busy || !question.trim()) return;
  const turn = { q: question.trim(), a: '', sources: null, status: '', error: null, done: false };
  AI.chat.push(turn);
  AI.busy = new AbortController();
  const th = host()?.querySelector('#aiThread');
  if (th) th.innerHTML = threadHtml();
  for (const t of AI.chat) paintTurn(t);
  redrawCompose();
  AI.page.scrollTop = AI.page.scrollHeight;
  let isNew = false;
  try {
    await stream('/api/ai/ask', { question: turn.q, chatId: AI.chatId }, line => {
      if (line.type === 'chat') { isNew = line.isNew; AI.chatId = line.id; if (line.isNew) AI.chatTitle = line.title; savePref('aiChat', line.id); }
      else if (line.type === 'sources') turn.sources = line.sources;
      else if (line.type === 'query') turn.query = line.text;
      else if (line.type === 'token') turn.a += line.t;
      else if (line.type === 'status') turn.status = line.text;
      else if (line.type === 'error') turn.error = line.message;
      else if (line.type === 'done' && line.memory) { turn.kind = 'memory'; loadMemory().then(drawMemoryCount); }
      schedulePaint(turn);
    }, AI.busy.signal);
  } catch (e) { if (e.name !== 'AbortError') turn.error = e.message; else if (turn.a) turn.stopped = true; }
  turn.done = true;
  AI.busy = null;
  if (isNew) { draw(); } else { paintTurn(turn); redrawCompose(); }
  await loadChats(); redrawRail();
  host()?.querySelector('#aiq')?.focus();
  loadStatus().then(() => { const s = host()?.querySelector('#aiStatus'); if (s) s.innerHTML = statusHtml(); });
}

function drawMemoryCount() {
  const b = host()?.querySelector('[data-act="memory"]');
  if (b) b.innerHTML = `${icon('bookmark')}Memory${AI.memory.length ? ` <span class="count">${AI.memory.length}</span>` : ''}`;
}

// ---------- memory ----------
async function memoryDialog() {
  await loadMemory();
  const list = () => AI.memory.length
    ? AI.memory.map(m => `<div class="mem-row" data-mem="${esc(m.id)}"><span class="mem-text">${esc(m.text)}</span>
        <span class="muted mem-meta">${m.source === 'chat' ? 'from a chat' : 'added by you'} · ${esc(ui.timeAgo(m.updatedAt || m.createdAt))}</span>
        <button class="icon-btn" data-mem-edit title="Edit">${icon('edit')}</button><button class="icon-btn" data-mem-del title="Forget this">${icon('trash')}</button></div>`).join('')
    : `<p class="muted">Nothing yet. Add facts the AI should always keep in mind, such as "My website's deploy script is in Projects\\site\\deploy.ps1" or "I use Windows 11 with an AMD GPU".</p>`;
  await ui.modal({
    title: 'What the AI remembers',
    wide: true,
    body: `<p class="muted" style="margin-top:0">These go into every Ask AI answer, on this PC only. Add one here, say <b>remember that…</b> in a chat, or click <b>Remember…</b> under an answer.</p>
      <div class="mem-add"><input class="input" id="memNew" placeholder="Something to remember…" maxlength="600"><button class="btn primary" data-mem-add>${icon('plus')}Add</button></div>
      <div class="mem-list" id="memList">${list()}</div>`,
    onOpen: m => {
      const repaint = () => { m.querySelector('#memList').innerHTML = list(); drawMemoryCount(); };
      const add = async () => {
        const inp = m.querySelector('#memNew');
        if (!inp.value.trim()) return;
        try { await post('/api/ai/memory/add', { text: inp.value }); inp.value = ''; await loadMemory(); repaint(); } catch (e) { ui.toast(e.message, { type: 'error' }); }
      };
      m.querySelector('#memNew').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(); } });
      m.addEventListener('click', async e => {
        if (e.target.closest('[data-mem-add]')) return add();
        const row = e.target.closest('[data-mem]');
        if (!row) return;
        const id = row.dataset.mem, mem = AI.memory.find(x => x.id === id);
        if (e.target.closest('[data-mem-del]')) { await post('/api/ai/memory/delete', { id }); await loadMemory(); return repaint(); }
        if (e.target.closest('[data-mem-edit]') && mem) {
          row.innerHTML = `<input class="input mem-edit" value="${esc(mem.text)}" maxlength="600"><button class="btn sm primary" data-mem-save>Save</button>`;
          const inp = row.querySelector('input');
          inp.focus();
          const saveIt = async () => { try { await post('/api/ai/memory/update', { id, text: inp.value }); await loadMemory(); repaint(); } catch (err) { ui.toast(err.message, { type: 'error' }); } };
          inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); saveIt(); } });
          row.querySelector('[data-mem-save]').addEventListener('click', saveIt);
        }
      });
    },
    actions: [{ label: 'Done', kind: 'primary' }],
  });
}

async function rememberFrom(turnIndex) {
  let facts = [];
  await ui.modal({
    title: 'Remember from this answer',
    wide: true,
    body: `<div id="memSug"><p class="muted">${icon('loader', 'spin')} Picking out facts worth keeping…</p></div>`,
    onOpen: async m => {
      const box = m.querySelector('#memSug');
      try { facts = (await post('/api/ai/memory/suggest', { chatId: AI.chatId, turn: turnIndex })).facts; }
      catch (e) { box.innerHTML = `<p class="ai-err">${icon('alert')} ${esc(e.message)}</p>`; return; }
      box.innerHTML = `${facts.length ? '<p class="muted" style="margin-top:0">Tick the ones to keep. You can edit them first.</p>' : '<p class="muted" style="margin-top:0">Nothing stood out. Write your own below.</p>'}
        ${facts.map((f, i) => `<label class="mem-sug"><input type="checkbox" checked data-i="${i}"><input class="input" data-f="${i}" value="${esc(f)}" maxlength="600"></label>`).join('')}
        <label class="mem-sug"><input type="checkbox" data-i="own"><input class="input" data-f="own" placeholder="Or write your own…" maxlength="600"></label>`;
      box.querySelector('[data-f="own"]').addEventListener('input', e => { box.querySelector('[data-i="own"]').checked = !!e.target.value.trim(); });
    },
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Remember', kind: 'primary', onClick: async m => {
        const texts = [...m.querySelectorAll('.mem-sug')].filter(l => l.querySelector('input[type=checkbox]').checked).map(l => l.querySelector('input.input').value.trim()).filter(Boolean);
        if (!texts.length) return true;
        await post('/api/ai/memory/add', { texts, chatId: AI.chatId });
        await loadMemory(); drawMemoryCount();
        ui.toast(`Remembered ${texts.length} thing${texts.length === 1 ? '' : 's'}`, { type: 'ok' });
      } },
    ],
  });
}

// ---------- chat menu ----------
async function renameChat(id) {
  const c = AI.chats.find(x => x.id === id) || { title: AI.chatTitle };
  const title = await ui.modal({
    title: 'Rename chat',
    body: `<input class="input" id="chatTitle" value="${esc(c.title)}" maxlength="120">`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', onClick: m => m.querySelector('#chatTitle').value.trim() || false }],
  });
  if (!title || typeof title !== 'string') return;
  await post('/api/ai/chats/update', { id, title });
  if (id === AI.chatId) { AI.chatTitle = title; const h = host()?.querySelector('.ai-chat-title'); if (h) h.textContent = title; }
  await loadChats(); redrawRail();
}

function chatMenu(anchor, id) {
  const c = AI.chats.find(x => x.id === id);
  if (!c) return;
  ui.menu(anchor, [
    { label: 'Rename', icon: 'edit', onClick: () => renameChat(id) },
    { label: c.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onClick: async () => { await post('/api/ai/chats/update', { id, pinned: !c.pinned }); await loadChats(); redrawRail(); } },
    { label: 'Delete', icon: 'trash', danger: true, onClick: async () => {
      if (!(await ui.confirm({ title: 'Delete this chat?', message: `"${c.title}" will be removed for good. Memories it created stay until you remove them.`, confirmLabel: 'Delete', danger: true }))) return;
      await post('/api/ai/chats/delete', { id });
      if (id === AI.chatId) newChat();
      await loadChats(); redrawRail();
    } },
  ]);
}

export function onAiEvent(d) {
  if (!host()) return;
  if (d.chats) { loadChats().then(() => { redrawRail(); const cur = AI.chats.find(c => c.id === AI.chatId); if (cur && cur.title !== AI.chatTitle) { AI.chatTitle = cur.title; const h = host()?.querySelector('.ai-chat-title'); if (h) h.textContent = cur.title; } }); }
  if (d.memory) loadMemory().then(drawMemoryCount);
  if (!d.pull && !d.job) return;
  if (d.pull) AI.status.pull = d.pull;
  if (d.job) AI.status.job = d.job;
  const s = host().querySelector('#aiStatus');
  if (s) s.innerHTML = statusHtml();
  if (d.pull?.state && d.pull.state !== 'running' || d.job?.state && d.job.state !== 'running') {
    loadStatus().then(() => { const x = host()?.querySelector('#aiStatus'); if (x) x.innerHTML = statusHtml(); redrawCompose(); });
  }
}

async function act(name, el) {
  try {
    if (name === 'start') {
      await post('/api/ai/start');
      ui.toast('Starting Ollama…', { type: 'busy', timeout: 4000 });
      for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 1000)); await loadStatus(); if (AI.status.running) break; }
      return draw();
    }
    if (name === 'enable') { AI.status = await post('/api/ai/settings', { enabled: true }); refresh(); return draw(); }
    if (name === 'unload') { const r = await post('/api/ai/unload'); ui.toast(`Freed ${ui.fmtBytes(r.freed)} of GPU memory`, { type: 'ok' }); }
    if (name === 'reindex') { await post('/api/ai/index', {}); }
    if (name === 'pull-embed') { await post('/api/ai/pull', { model: 'nomic-embed-text' }); }
    if (name === 'new-chat') return newChat();
    if (name === 'rail') { AI.railOpen = !AI.railOpen; host()?.querySelector('#aiRail')?.classList.toggle('open', AI.railOpen); return; }
    if (name === 'memory') return memoryDialog();
    if (name === 'rename') return renameChat(AI.chatId);
    if (name === 'stop') { AI.busy?.abort(); return; }
    if (name === 'copy') { const i = +el.closest('[data-turn]').dataset.turn; return ui.copyText(AI.chat[i].a, 'Answer copied'); }
    if (name === 'remember') return rememberFrom(+el.closest('[data-turn]').dataset.turn);
  } catch (e) { ui.toast(e.message, { type: 'error' }); }
  await loadStatus();
  const s = host()?.querySelector('#aiStatus');
  if (s) s.innerHTML = statusHtml();
}

document.addEventListener('click', e => {
  const el = host();
  if (!el || !el.contains(e.target)) return;
  const ex = e.target.closest('[data-example]');
  if (ex) return ask(ex.dataset.example);
  const cm = e.target.closest('[data-chat-menu]');
  if (cm) { e.stopPropagation(); return chatMenu(cm, cm.dataset.chatMenu); }
  const row = e.target.closest('[data-chat]');
  if (row) return openChat(row.dataset.chat);
  const cite = e.target.closest('.cite, [data-src]');
  if (cite) {
    const t = AI.chat[+cite.closest('[data-turn]').dataset.turn];
    const s = t.sources.find(x => x.n === +(cite.dataset.n || cite.dataset.src));
    if (s && !s.locked && itemById(s.itemId)) openItem(s.itemId, s.rel);
    else ui.toast(s?.locked ? 'That item is locked' : 'That item is no longer in your vault', { type: 'warn' });
    return;
  }
  const a = e.target.closest('[data-act]');
  if (a) act(a.dataset.act, a);
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'aiCompose') return;
  e.preventDefault();
  const q = e.target.querySelector('#aiq');
  const v = q.value;
  q.value = '';
  ask(v);
});
document.addEventListener('keydown', e => {
  if (e.target.id !== 'aiq') return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); }
});
const searchChats = ui.debounce(async () => { await loadChats(); redrawRail(); }, 200);
document.addEventListener('input', e => {
  if (e.target.id === 'aiChatSearch') { AI.chatQ = e.target.value; return searchChats(); }
  if (e.target.id !== 'aiq') return;
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(200, e.target.scrollHeight) + 'px';
});
document.addEventListener('change', async e => {
  const el = host();
  if (!el || !el.contains(e.target) || e.target.dataset.ai !== 'model') return;
  AI.status = await post('/api/ai/settings', { model: e.target.value });
  ui.toast(`Using ${e.target.value}`, { type: 'ok', timeout: 2000 });
});

// ---------- used from the viewer and the edit dialog ----------
export async function summarize(item, rel, fileName, isCode) {
  let text = '', model = '';
  const ctrl = new AbortController();
  const label = isCode ? 'Explain' : 'Summary';
  await ui.modal({
    title: `${isCode ? 'Explaining' : 'Summary of'} ${fileName}`,
    wide: true,
    body: `<div class="ai-sum"><div class="md"><p class="muted">${icon('loader', 'spin')} Reading the file…</p></div></div><p class="muted ai-foot" style="font-size:12px;margin:12px 0 0"></p>`,
    onOpen: m => {
      const box = m.querySelector('.ai-sum .md');
      let queued = false;
      const paint = () => { queued = false; box.innerHTML = md(text) + '<span class="caret"></span>'; box.parentElement.scrollTop = box.parentElement.scrollHeight; };
      stream('/api/ai/summarize', { itemId: item.id, rel }, line => {
        if (line.type === 'start') model = line.model;
        if (line.type === 'token') { text += line.t; if (!queued) { queued = true; requestAnimationFrame(paint); } }
        if (line.type === 'error') box.innerHTML = `<p class="ai-err">${icon('alert')} ${esc(line.message)}</p>`;
        if (line.type === 'done') {
          box.innerHTML = md(text);
          m.querySelector('.ai-foot').textContent = `Written by ${model} on this PC. Local AI can make mistakes.`;
        }
      }, ctrl.signal).catch(err => { if (err.name !== 'AbortError') box.innerHTML = `<p class="ai-err">${icon('alert')} ${esc(err.message)}</p>`; });
    },
    actions: [
      { label: 'Copy', icon: 'copy', left: true, onClick: () => { if (text) ui.copyText(text, `${label} copied`); return false; } },
      { label: 'Save as note', icon: 'note', onClick: async () => {
        if (!text) return false;
        await post('/api/items/add-note', { name: `${label}: ${fileName}`, body: `${text}\n\n---\n*${label} of ${fileName}, written by ${model || 'local AI'}.*`, collection: item.collection });
        ui.toast('Saved as a note', { type: 'ok' });
        refresh();
      } },
      { label: 'Close', kind: 'primary' },
    ],
  });
  ctrl.abort();
}

export async function suggestTags(itemId) {
  return (await post('/api/ai/tags', { itemId })).tags || [];
}
