// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Shared app state + hash routing.  #/<page>[/<arg>][?v=<itemId>&p=<path inside item>]
import { get } from './api.js';

export function load(key, def) { try { return localStorage.getItem('vault.' + key) ?? def; } catch { return def; } }
export function save(key, val) { try { localStorage.setItem('vault.' + key, val); } catch {} }

export const S = {
  items: [], collections: [], settings: {}, tracker: { searching: [] }, jobs: [], app: {},
  selected: new Set(), query: '', kind: 'all', sort: load('sort', 'added'),
  loaded: false, backupScope: null,
};

export const hooks = { render() {} };

let inflight = null, again = false;
/** Re-fetch everything from the server and re-render. Coalesces bursts of calls. */
export function refresh() {
  if (inflight) { again = true; return inflight; }
  inflight = (async () => {
    do {
      again = false;
      const st = await get('/api/state');
      Object.assign(S, st);
      S.loaded = true;
      for (const id of [...S.selected]) if (!S.items.some(i => i.id === id)) S.selected.delete(id);
      hooks.render();
    } while (again);
  })().finally(() => { inflight = null; });
  return inflight;
}

export function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/all';
  const qi = h.indexOf('?');
  const p = qi < 0 ? h : h.slice(0, qi), qs = qi < 0 ? '' : h.slice(qi + 1);
  const parts = p.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  return { name: parts[0] || 'all', arg: parts[1] ? decodeURIComponent(parts[1]) : null, view: q.get('v'), rel: q.get('p') || '' };
}

export function hashFor(r) {
  let h = '#/' + r.name + (r.arg ? '/' + encodeURIComponent(r.arg) : '');
  const q = new URLSearchParams();
  if (r.view) q.set('v', r.view);
  if (r.rel) q.set('p', r.rel);
  const qs = q.toString();
  return h + (qs ? '?' + qs : '');
}

export function go(name, arg = null) { location.hash = hashFor({ name, arg }); }
export function openItem(id, rel = '') { const r = parseHash(); location.hash = hashFor({ name: r.name, arg: r.arg, view: id, rel }); }
export function closeViewer() { const r = parseHash(); location.hash = hashFor({ name: r.name, arg: r.arg }); }

export const itemById = id => S.items.find(i => i.id === id);
export const collectionById = id => S.collections.find(c => c.id === id);
export const isUnavailable = it => (it.kind === 'file' || it.kind === 'folder') && it.status && it.status !== 'ok';
