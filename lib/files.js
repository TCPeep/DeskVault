// DeskVault - Copyright (C) 2026 TCPeep - https://github.com/TCPeep/DeskVault
// Licensed under GPL-3.0 with attribution terms (keep the credit). See LICENSE and NOTICE.
// File-type detection, safe path joining, text decoding, raw streaming and fingerprints.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const EXT_KIND = {};
const add = (kind, exts) => exts.split(' ').forEach(e => { EXT_KIND[e] = kind; });
add('pdf', 'pdf');
add('markdown', 'md markdown mdx mkd');
add('image', 'png jpg jpeg gif webp bmp ico avif svg jfif');
add('audio', 'mp3 wav ogg oga flac m4a aac opus weba');
add('video', 'mp4 m4v webm ogv mov');
add('html', 'html htm xhtml');
add('binary', 'exe dll sys msi zip 7z rar gz tgz bz2 xz iso img bin dat db sqlite pak vpk docx doc xlsx xls pptx ppt odt ods psd blend fbx obj glb gltf unitypackage jar class pyc o obj lib a so dylib woff woff2 ttf otf eot sdd sd7 lnk');

// extension -> highlight.js language
const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', pyw: 'python', rb: 'ruby', php: 'php', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', go: 'go', rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', csx: 'csharp', vb: 'vbnet', fs: 'plaintext',
  lua: 'lua', r: 'r', pl: 'perl', sql: 'sql', graphql: 'graphql', gql: 'graphql', dart: 'dart',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', ipynb: 'json',
  xml: 'xml', xaml: 'xml', csproj: 'xml', vbproj: 'xml', props: 'xml', targets: 'xml', resx: 'xml', config: 'xml', plist: 'xml', svg: 'xml', html: 'xml', htm: 'xml', xhtml: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini', editorconfig: 'ini', gitconfig: 'ini',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', sh: 'bash', bash: 'bash', zsh: 'bash', bat: 'dos', cmd: 'dos',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', diff: 'diff', patch: 'diff', makefile: 'makefile', mk: 'makefile',
  dockerfile: 'dockerfile', gradle: 'plaintext', txt: 'plaintext', log: 'plaintext', csv: 'plaintext', tsv: 'plaintext', sln: 'plaintext',
  gitignore: 'plaintext', gitattributes: 'plaintext', nfo: 'plaintext', srt: 'plaintext', vtt: 'plaintext',
};
const NAME_LANG = { makefile: 'makefile', dockerfile: 'dockerfile', '.gitignore': 'plaintext', '.env': 'ini', license: 'plaintext', readme: 'plaintext' };

const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xhtml: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

export const extOf = name => {
  const base = path.basename(name).toLowerCase();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : (base.startsWith('.') ? base.slice(1) : '');
};

export function kindOf(name) {
  return EXT_KIND[extOf(name)] || (LANG[extOf(name)] || NAME_LANG[path.basename(name).toLowerCase()] ? 'text' : null);
}

export function langOf(name) {
  const base = path.basename(name).toLowerCase();
  return NAME_LANG[base] || LANG[extOf(name)] || 'plaintext';
}

export const mimeOf = name => MIME[extOf(name)] || 'application/octet-stream';

/** Join rel onto root, refusing anything that escapes root. Returns null when unsafe. */
export function safeJoin(root, rel) {
  if (!rel) return root;
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  if (parts.some(p => p === '..' || p.includes(':'))) return null;
  const abs = path.resolve(root, ...parts);
  const r = path.resolve(root);
  const rootWithSep = r.endsWith(path.sep) ? r : r + path.sep;
  if (abs.toLowerCase() !== r.toLowerCase() && !abs.toLowerCase().startsWith(rootWithSep.toLowerCase())) return null;
  return abs;
}

/** Peek at the first bytes: does this look like text? */
export async function sniffText(abs) {
  let fh;
  try {
    fh = await fsp.open(abs, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);
    if (bytesRead === 0) return true;
    if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return true; // UTF-16 BOM
    if (b.includes(0)) return false;
    let ctrl = 0;
    for (const c of b) if (c < 9 || (c > 13 && c < 32)) ctrl++;
    return ctrl / b.length < 0.02;
  } catch { return false; } finally { await fh?.close(); }
}

/** Read up to `limit` bytes as text, handling UTF-8/UTF-16 BOMs (PowerShell loves UTF-16). */
export async function readText(abs, limit = 2 * 1024 * 1024) {
  const st = await fsp.stat(abs);
  const len = Math.min(st.size, limit);
  const fh = await fsp.open(abs, 'r');
  let buf;
  try {
    buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
  } finally { await fh.close(); }
  let text, encoding = 'utf-8';
  if (buf[0] === 0xff && buf[1] === 0xfe) { text = new TextDecoder('utf-16le').decode(buf.subarray(2)); encoding = 'utf-16le'; }
  else if (buf[0] === 0xfe && buf[1] === 0xff) { text = new TextDecoder('utf-16be').decode(buf.subarray(2)); encoding = 'utf-16be'; }
  else {
    const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(start)); }
    catch { text = new TextDecoder('windows-1252').decode(buf.subarray(start)); encoding = 'windows-1252'; }
  }
  return { text, truncated: st.size > limit, size: st.size, encoding };
}

/** Stream a file with Range support (seeking in audio/video, PDF viewers). */
export function sendFile(req, res, abs, st, extraHeaders = {}) {
  const type = mimeOf(abs);
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
    ...extraHeaders,
  };
  const ext = extOf(abs);
  // Never let a tracked HTML/SVG file run script on this origin.
  if (ext === 'svg') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  else if (EXT_KIND[ext] === 'html') headers['Content-Security-Policy'] = 'sandbox allow-same-origin; script-src \'none\'';
  let start = 0, end = st.size - 1, status = 200;
  const range = req.headers.range;
  if (range && st.size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Cheap content fingerprint: size + first and last 64 KB. */
export async function quickHash(abs, size) {
  const h = crypto.createHash('sha1');
  h.update(String(size));
  const fh = await fsp.open(abs, 'r');
  try {
    const n = Math.min(65536, size);
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 0);
    h.update(buf);
    if (size > 65536) {
      const tail = Buffer.alloc(Math.min(65536, size - 65536));
      await fh.read(tail, 0, tail.length, size - tail.length);
      h.update(tail);
    }
  } finally { await fh.close(); }
  return h.digest('hex').slice(0, 20);
}

/** A folder's "signature" for recognising it after a move: some of its direct children. */
export async function folderSignature(abs) {
  const names = (await fsp.readdir(abs)).sort((a, b) => a.localeCompare(b));
  return { count: names.length, children: names.slice(0, 60) };
}

/** Recursive walk used by backups and size estimates. Skips junctions/symlinks and excluded names. */
export async function walk(root, { exclude = [], onFile, onError, signal } = {}) {
  const ex = new Set(exclude.map(e => e.toLowerCase()));
  const stack = [''];
  while (stack.length) {
    if (signal?.aborted) return;
    const rel = stack.pop();
    const dir = rel ? path.join(root, rel) : root;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { onError?.(dir, e); continue; }
    if (rel) await onFile?.({ rel, dir: true });
    for (const d of entries) {
      if (ex.has(d.name.toLowerCase())) continue;
      if (d.isSymbolicLink()) continue;
      const childRel = rel ? path.join(rel, d.name) : d.name;
      if (d.isDirectory()) stack.push(childRel);
      else if (d.isFile()) {
        try {
          const st = await fsp.stat(path.join(root, childRel));
          await onFile?.({ rel: childRel, size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
        } catch (e) { onError?.(path.join(root, childRel), e); }
      }
    }
  }
}
