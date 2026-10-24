// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Ask AI page (questions about your own notes/files, answered by the local Ollama model with sources),
// plus the Summarize/Explain dialog and tag suggestions used elsewhere.
import { S, refresh, parseHash, openItem, itemById } from './state.js';
import { get, post, stream } from './api.js';
import * as ui from './ui.js';
const { esc, icon } = ui;

const AI = { page: null, status: null, chat: [], busy: null };
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
  await loadStatus();
  draw();
}

async function loadStatus() {
  try { AI.status = await get('/api/ai/status'); } catch (e) { AI.status = { running: false, error: e.message }; }
}

function draw() {
  const el = host();
  if (!el) return;
  el.innerHTML = `
    <div class="page-head"><h1>${icon('sparkle')} Ask AI</h1><span class="sub">Answers from your own notes, files and saved sites, using the AI on this PC. Nothing leaves your computer.</span>
      <div class="grow"></div>${AI.chat.length ? `<button class="btn sm" data-act="new-chat">${icon('plus')}New chat</button>` : ''}</div>
    <section class="panel ai-status" id="aiStatus">${statusHtml()}</section>
    <div class="ai-thread" id="aiThread">${threadHtml()}</div>
    <form class="ai-compose" id="aiCompose">${composeHtml()}</form>`;
  for (const t of AI.chat) paintTurn(t);
  const q = el.querySelector('#aiq');
  if (q && !AI.busy) q.focus();
}

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
      ${job?.state === 'running' ? `<span class="muted">${icon('loader', 'spin')} Reading your Vault… ${job.done}/${job.total}</span>`
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
  if (cols[0]) ex.push(`What's in my ${cols[0].name} collection?`);
  if (S.items.some(i => i.kind === 'note' && !i.hidden)) ex.push('Summarise my notes');
  if (S.items.some(i => i.kind === 'link' && !i.hidden)) ex.push('Which saved sites should I look at again?');
  if (tags[0]) ex.push(`What do I have about ${tags[0]}?`);
  ex.push('What did I write down that I still need to do?');
  return ex.slice(0, 4);
}

function threadHtml() {
  if (!AI.chat.length) return `<div class="empty ai-empty"><div class="tile xl c-video">${icon('sparkle')}</div>
    <h2>Ask about your stuff</h2>
    <p>The AI reads your notes, saved sites, and the text and Markdown files inside your Vault, then answers with links to where it found things. Locked items are never shown to it.</p>
    <div class="ai-examples">${examples().map(e => `<button class="chip" data-example="${esc(e)}">${esc(e)}</button>`).join('')}</div></div>`;
  return AI.chat.map((t, i) => `<div class="msg user">${esc(t.q)}</div><div class="msg ai" data-turn="${i}"></div>`).join('');
}

function paintTurn(t) {
  const el = host()?.querySelector(`.msg.ai[data-turn="${AI.chat.indexOf(t)}"]`);
  if (!el) return;
  const body = t.a ? md(t.a) : t.error ? '' : `<p class="muted">${icon('loader', 'spin')} ${esc(t.status || (t.sources ? 'Thinking…' : 'Looking through your Vault…'))}</p>`;
  el.innerHTML = `<div class="md">${body}${t.done || !t.a ? '' : '<span class="caret"></span>'}</div>
    ${t.error ? `<p class="ai-err">${icon('alert')} ${esc(t.error)}</p>` : ''}
    ${t.sources?.length && t.done ? `<div class="ai-sources"><span class="muted">Sources</span>${t.sources.map(s => `<button class="chip" data-src="${s.n}" title="${esc(s.snippet)}"><b>${s.n}</b>${esc(s.title)}</button>`).join('')}</div>` : ''}
    ${t.done && !t.error ? `<div class="ai-tools"><button class="icon-btn" data-act="copy" title="Copy answer">${icon('copy')}</button><span class="muted">Local AI can be wrong. Check the sources for anything important.</span></div>` : ''}`;
  linkCitations(el.querySelector('.md'), t.sources || []);
}

function composeHtml() {
  return `<textarea id="aiq" class="input" rows="1" placeholder="Ask about your notes, files and saved sites…" ${AI.status?.running && AI.status?.model ? '' : 'disabled'}></textarea>
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
  const history = AI.chat.filter(t => t.done && !t.error).map(t => ({ q: t.q, a: t.a }));
  AI.chat.push(turn);
  AI.busy = new AbortController();
  const th = host()?.querySelector('#aiThread');
  if (th) th.innerHTML = threadHtml();
  for (const t of AI.chat) paintTurn(t);
  redrawCompose();
  AI.page.scrollTop = AI.page.scrollHeight;
  try {
    await stream('/api/ai/ask', { question: turn.q, history }, line => {
      if (line.type === 'sources') turn.sources = line.sources;
      else if (line.type === 'token') turn.a += line.t;
      else if (line.type === 'status') turn.status = line.text;
      else if (line.type === 'error') turn.error = line.message;
      schedulePaint(turn);
    }, AI.busy.signal);
  } catch (e) { if (e.name !== 'AbortError') turn.error = e.message; }
  turn.done = true;
  AI.busy = null;
  paintTurn(turn);
  redrawCompose();
  host()?.querySelector('#aiq')?.focus();
  loadStatus().then(() => { const s = host()?.querySelector('#aiStatus'); if (s) s.innerHTML = statusHtml(); });
}

export function onAiEvent(d) {
  if (!host()) return;
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
    if (name === 'new-chat') { if (AI.busy) AI.busy.abort(); AI.chat = []; return draw(); }
    if (name === 'stop') { AI.busy?.abort(); return; }
    if (name === 'copy') { const i = +el.closest('[data-turn]').dataset.turn; return ui.copyText(AI.chat[i].a, 'Answer copied'); }
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
  const cite = e.target.closest('.cite, [data-src]');
  if (cite) {
    const t = AI.chat[+cite.closest('[data-turn]').dataset.turn];
    const s = t.sources.find(x => x.n === +(cite.dataset.n || cite.dataset.src));
    if (s && itemById(s.itemId)) openItem(s.itemId, s.rel);
    else ui.toast('That item is no longer in Vault', { type: 'warn' });
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
document.addEventListener('input', e => {
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
