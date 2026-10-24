// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Small UI toolkit: escaping, icons, formatting, menus, modals, toasts.
import { ICONS } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
export const layer = () => document.getElementById('layer');

// ---------- formatting ----------
export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

export function fmtDate(v, withTime = true) {
  if (!v) return '';
  const d = new Date(v);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) });
}

export function timeAgo(v) {
  if (!v) return '';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 30 * 86400) return `${Math.round(s / 86400)} days ago`;
  return fmtDate(v, false);
}

/** C:\Users\me\…\Project\file.txt */
export function shortPath(p, max = 70) {
  if (!p || p.length <= max) return p || '';
  const parts = p.split('\\');
  if (parts.length < 4) return '…' + p.slice(-max);
  let head = parts.slice(0, 2).join('\\'), tail = parts.slice(-2).join('\\');
  if (head.length + tail.length + 2 > max) return head + '\\…\\' + parts[parts.length - 1];
  for (let i = parts.length - 3; i >= 2; i--) {
    if (head.length + tail.length + parts[i].length + 3 > max) break;
    tail = parts[i] + '\\' + tail;
  }
  return head + '\\…\\' + tail;
}

export const basename = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
export const extOf = n => { const b = basename(n).toLowerCase(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1) : ''; };

const CODE_EXT = new Set('js mjs cjs jsx ts tsx py rb php java kt swift go rs c h cpp cc hpp cs vb lua r pl sql json jsonc xml xaml csproj sln yml yaml toml ini cfg conf ps1 psm1 psd1 sh bash bat cmd css scss less html htm vue svelte gradle dart dockerfile makefile mk env gitignore'.split(' '));
const CAT = [
  ['pdf', 'pdf', 'pdf'],
  ['md', 'md', 'md markdown mdx'],
  ['image', 'image', 'png jpg jpeg gif webp bmp ico avif svg jfif heic tif tiff psd'],
  ['audio', 'music', 'mp3 wav ogg oga flac m4a aac opus wma'],
  ['video', 'video', 'mp4 m4v webm mov mkv avi wmv ogv'],
  ['archive', 'archive', 'zip 7z rar gz tgz bz2 xz tar iso cab sdz sd7'],
  ['app', 'app', 'exe msi bat cmd lnk appx msix dll'],
  ['text', 'file-text', 'txt log rtf doc docx odt csv tsv xls xlsx ppt pptx nfo'],
];

/** -> { cat, icon } used for tile colours (c-<cat>) and glyphs */
export function categoryOf(nameOrItem, kindHint) {
  if (typeof nameOrItem === 'object' && nameOrItem) {
    const it = nameOrItem;
    if (it.kind === 'folder') return { cat: 'folder', icon: 'folder' };
    if (it.kind === 'link') return { cat: 'link', icon: 'link' };
    if (it.kind === 'note') return { cat: 'note', icon: 'note' };
    return categoryOf(it.path || it.name);
  }
  if (kindHint === 'folder') return { cat: 'folder', icon: 'folder' };
  const ext = extOf(nameOrItem);
  for (const [cat, ic, exts] of CAT) if (exts.split(' ').includes(ext)) {
    if (cat === 'app' && (ext === 'bat' || ext === 'cmd')) return { cat: 'code', icon: 'file-code' };
    return { cat, icon: ic };
  }
  if (CODE_EXT.has(ext) || CODE_EXT.has(basename(nameOrItem).toLowerCase())) return { cat: 'code', icon: 'file-code' };
  return { cat: 'file', icon: 'file' };
}

export function tile(itemOrName, size = '', kindHint) {
  if (itemOrName && typeof itemOrName === 'object') {
    if (itemOrName.hidden) return `<div class="tile ${size} c-lock">${icon('lock')}</div>`;
    const fav = itemOrName.kind === 'link' && itemOrName.meta?.icon;
    if (fav) return `<div class="tile ${size} c-link fav"><img src="/thumbs/${encodeURIComponent(fav)}" alt="" loading="lazy"></div>`;
  }
  const c = categoryOf(itemOrName, kindHint);
  return `<div class="tile ${size} c-${c.cat}">${icon(c.icon)}</div>`;
}
export function ficon(name, isDir) {
  const c = categoryOf(name, isDir ? 'folder' : null);
  return `<svg class="i ficon c-${c.cat}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[c.icon]}</svg>`;
}

// Broken website icons fall back to the plain link glyph (inline onerror is blocked by our CSP).
document.addEventListener('error', e => {
  const img = e.target;
  if (img?.tagName !== 'IMG') return;
  if (img.parentElement?.classList.contains('fav')) img.parentElement.innerHTML = icon('link');
  else if (img.closest('.card-cover, .link-card .cover')) img.closest('.card-cover, .cover').remove();
}, true);

// ---------- toasts ----------
export function toast(msg, { type = 'info', action, actionLabel, timeout = 4500, sticky = false } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = { ok: 'check-circle', error: 'alert', warn: 'alert', info: 'info', busy: 'loader' }[type] || 'info';
  el.innerHTML = `${icon(ic, type === 'busy' ? 'spin' : '')}<div class="msg"></div>${action ? `<button class="btn sm">${esc(actionLabel || 'Undo')}</button>` : ''}<button class="icon-btn" aria-label="Dismiss">${icon('x')}</button>`;
  el.querySelector('.msg').textContent = msg;
  document.getElementById('toasts').appendChild(el);
  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  el.querySelector('.icon-btn').onclick = close;
  if (action) el.querySelector('.btn').onclick = () => { close(); action(); };
  if (!sticky) timer = setTimeout(close, timeout);
  return { close, update(m) { el.querySelector('.msg').textContent = m; } };
}

// ---------- menus ----------
let openMenuEl = null;
export function closeMenus() { openMenuEl?.remove(); openMenuEl = null; }

/** items: [{label, icon, onClick, danger, disabled, divider, header, sub:[...], color}] */
export function menu(anchor, items, opts = {}) {
  closeMenus();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = items.filter(Boolean).map((it, i) => {
    if (it.divider) return '<div class="menu-sep"></div>';
    if (it.header) return `<div class="menu-head">${esc(it.header)}</div>`;
    const lead = it.color ? `<span class="dot" style="background:${esc(it.color)}"></span>` : it.icon ? icon(it.icon) : '<span class="i"></span>';
    return `<button class="menu-item ${it.danger ? 'danger' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''} role="menuitem">${lead}<span>${esc(it.label)}</span>${it.sub ? icon('chevron-right', 'sub') : ''}${it.check ? icon('check') : ''}</button>`;
  }).join('');
  const list = items.filter(Boolean);
  layer().appendChild(el);
  openMenuEl = el;
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = el.offsetWidth, mh = el.offsetHeight;
  let x = opts.align === 'right' ? r.right - mw : r.left;
  let y = r.bottom + 4;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  x = Math.max(8, Math.min(x, innerWidth - mw - 8));
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const it = list[+b.dataset.i];
    if (it.sub) { menu({ x, y: y }, it.sub, opts); return; }
    closeMenus();
    it.onClick?.();
  });
  el.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
  return el;
}
document.addEventListener('pointerdown', e => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenus(); }, true);
addEventListener('blur', closeMenus);
addEventListener('resize', closeMenus);
document.addEventListener('keydown', e => {
  if (!openMenuEl) return;
  if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const btns = $$('.menu-item:not(:disabled)', openMenuEl);
    const i = btns.indexOf(document.activeElement);
    btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
  }
}, true);

// ---------- modals ----------
export function isModalOpen() { return !!layer().querySelector('.modal-wrap'); }

/**
 * actions: [{label, kind:'primary'|'danger'|'ghost', value, icon, left, onClick(modalEl) -> value | false to keep open}]
 * Resolves with the chosen value, or null when dismissed.
 */
export function modal({ title, body = '', actions = [], wide = false, onOpen, dismissable = true }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">${body}<div class="err" hidden></div></div>
      ${actions.length ? `<div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.kind || ''} ${a.left ? 'left' : ''}" data-a="${i}">${a.icon ? icon(a.icon) : ''}${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    layer().appendChild(wrap);
    const m = wrap.querySelector('.modal');
    const errEl = wrap.querySelector('.err');
    const close = v => { wrap.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const run = async i => {
      const a = actions[i];
      const btn = wrap.querySelector(`[data-a="${i}"]`);
      errEl.hidden = true;
      if (!a.onClick) return close(a.value ?? true);
      btn.disabled = true;
      try {
        const r = await a.onClick(m, close);
        if (r === false) { btn.disabled = false; return; }
        close(r === undefined ? (a.value ?? true) : r);
      } catch (err) { btn.disabled = false; errEl.textContent = err.message; errEl.hidden = false; }
    };
    let downOnBackdrop = false;
    wrap.addEventListener('pointerdown', e => { downOnBackdrop = e.target === wrap; });
    wrap.addEventListener('click', e => {
      if (e.target === wrap && downOnBackdrop && dismissable) return close(null);
      if (e.target.closest('[data-close]')) return close(null);
      const b = e.target.closest('[data-a]');
      if (b) run(+b.dataset.a);
    });
    const onKey = e => {
      if (e.key === 'Escape' && dismissable && !document.querySelector('.menu')) { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'INPUT' && wrap.contains(e.target)) {
        const primary = actions.findIndex(a => a.kind === 'primary' || a.kind === 'danger');
        if (primary >= 0) { e.preventDefault(); run(primary); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    onOpen?.(m, close);
    (m.querySelector('[autofocus]') || m.querySelector('input:not([type=checkbox]), textarea, select') || m.querySelector('.modal-foot .primary, .modal-foot .danger'))?.focus();
  });
}

export async function confirm({ title, message = '', html = '', confirmLabel = 'OK', danger = false, cancelLabel = 'Cancel' }) {
  const r = await modal({
    title,
    body: (message ? `<p>${esc(message)}</p>` : '') + html,
    actions: [{ label: cancelLabel, value: false }, { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true }],
  });
  return r === true;
}

export async function copyText(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(`${what} to clipboard`, { type: 'ok', timeout: 2000 }); }
  catch { toast('Could not copy', { type: 'error' }); }
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export const COLORS = ['#818cf8', '#a78bfa', '#f472b6', '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#60a5fa', '#94a3b8'];
