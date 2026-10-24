// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
export async function request(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}
export const get = path => request(path);
export const post = (path, body = {}) => request(path, body);

/** POST and read a newline-delimited JSON stream (AI answers). Calls onLine(obj) per line. */
export async function stream(path, body, onLine, signal) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch {}
    throw new Error(data?.error || `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(JSON.parse(line));
    }
  }
}

/** Server-sent events; reconnects automatically. onStatus(connected:boolean) */
export function connectEvents(handlers, onStatus) {
  const es = new EventSource('/api/events');
  for (const [type, fn] of Object.entries(handlers)) {
    es.addEventListener(type, e => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
  }
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false);
  return es;
}
