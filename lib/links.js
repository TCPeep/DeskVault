// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// Website previews for saved links: title, description, site name, preview image and icon.
// Images are downloaded into data/thumbs so cards work offline and don't ping the site each time.
import fsp from 'node:fs/promises';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
export const THUMB_RE = /^[\w-]+\.(png|jpg|gif|webp|ico|svg|avif)$/;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = s => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
}).replace(/\s+/g, ' ').trim();

async function readLimited(res, limit) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, limit);
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}

export function parseMeta(html, baseUrl) {
  const head = html.slice(0, 600000);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content != null && !(key in meta)) meta[key] = a.content;
  }
  const icons = [];
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel || '').toLowerCase();
    if (a.href && /\bicon\b|apple-touch-icon/.test(rel)) icons.push({ href: a.href, size: parseInt((a.sizes || '').split('x')[0], 10) || (rel.includes('apple') ? 180 : 16) });
  }
  const abs = u => { try { return u ? new URL(decode(u), baseUrl).href : null; } catch { return null; } };
  const title = decode(meta['og:title'] || meta['twitter:title'] || (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) || [])[1] || '');
  // Prefer an icon around 32-64px; fall back to /favicon.ico
  icons.sort((x, y) => Math.abs(x.size - 48) - Math.abs(y.size - 48));
  return {
    title: title.slice(0, 300) || null,
    description: decode(meta['og:description'] || meta['twitter:description'] || meta.description || '').slice(0, 600) || null,
    siteName: decode(meta['og:site_name'] || meta['application-name'] || '').slice(0, 120) || null,
    image: abs(meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src']),
    icon: abs(icons[0]?.href) || abs('/favicon.ico'),
  };
}

async function download(url, file, maxBytes) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, signal: AbortSignal.timeout(10000), redirect: 'follow' });
  if (!res.ok) return null;
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = IMG_EXT[type];
  if (!ext) return null;
  const buf = await readLimited(res, maxBytes + 1);
  if (buf.length > maxBytes || buf.length < 50) return null;
  const name = `${file}.${ext}`;
  return { name, buf };
}

/** Fetch a page's preview info. Never throws; errors are recorded on the result. */
export async function fetchPreview(url, thumbsDir, id) {
  const out = { fetchedAt: new Date().toISOString() };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    out.finalUrl = res.url;
    out.status = res.status;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    let info = { icon: new URL('/favicon.ico', res.url).href };
    if (type.includes('html')) info = parseMeta((await readLimited(res, 1.5e6)).toString('utf8'), res.url);
    else res.body?.cancel().catch(() => {});
    Object.assign(out, { title: info.title || null, description: info.description || null, siteName: info.siteName || null });
    await fsp.mkdir(thumbsDir, { recursive: true });
    for (const [kind, src, max] of [['image', info.image, 3e6], ['icon', info.icon, 5e5]]) {
      if (!src || !/^https?:/i.test(src)) continue;
      try {
        const d = await download(src, `${id}-${kind}`, max);
        if (d) { await fsp.writeFile(path.join(thumbsDir, d.name), d.buf); out[kind] = d.name; }
      } catch {}
    }
    if (!res.ok && !out.title) out.error = `The site answered ${res.status}`;
  } catch (e) {
    out.error = e.name === 'TimeoutError' ? 'The site took too long to answer' : `Couldn't reach the site (${e.cause?.code || e.message})`;
  }
  return out;
}

export async function removeThumbs(thumbsDir, meta) {
  for (const f of [meta?.image, meta?.icon]) if (f && THUMB_RE.test(f)) await fsp.rm(path.join(thumbsDir, f), { force: true }).catch(() => {});
}
