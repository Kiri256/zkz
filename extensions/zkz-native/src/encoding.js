'use strict';

let iconv = null;
try { iconv = require('iconv-lite'); } catch (_) { iconv = null; }

const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

function requireIconv() {
  if (!iconv) {
    try { iconv = require('iconv-lite'); } catch (_) { /* fall */ }
  }
  if (!iconv) throw new Error('iconv-lite unavailable, cannot use cp936/GBK');
  return iconv;
}

function hasUtf8Bom(buf) {
  return !!(buf && buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
}

function isStrictUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch (_) {
    return false;
  }
}

function hasNonAscii(buf) {
  if (!buf) return false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 127) return true;
  }
  return false;
}

/** Utf8Bom / Utf8 / Ascii / Gbk */
function detectKind(buf) {
  if (!buf || !buf.length) return 'Ascii';
  if (hasUtf8Bom(buf)) return isStrictUtf8(buf) ? 'Utf8Bom' : 'Gbk';
  if (isStrictUtf8(buf)) return hasNonAscii(buf) ? 'Utf8' : 'Ascii';
  return 'Gbk';
}

function decodeCp936(buf) {
  if (!buf || !buf.length) return '';
  return requireIconv().decode(Buffer.from(buf), 'gbk');
}

function encodeCp936(text) {
  return Buffer.from(requireIconv().encode(String(text), 'gbk'));
}

function roundtripOk(text) {
  const t = String(text);
  try {
    return decodeCp936(encodeCp936(t)) === t;
  } catch (_) {
    return false;
  }
}

function wtToText(buf) {
  if (!buf || !buf.length) return '';
  if (hasUtf8Bom(buf)) return Buffer.from(buf).slice(3).toString('utf8');
  return Buffer.from(buf).toString('utf8');
}

function applySmudge(kind, blobBytes) {
  const k = kind || 'Ascii';
  const buf = blobBytes ? Buffer.from(blobBytes) : Buffer.alloc(0);
  if (k === 'Ascii' || k === 'Utf8') return buf;
  if (k === 'Utf8Bom') return hasUtf8Bom(buf) ? buf.slice(3) : buf;
  if (k === 'Gbk') return Buffer.from(decodeCp936(buf), 'utf8');
  throw new Error('unknown encoding kind: ' + k);
}

function firstUnencodable(text) {
  const t = String(text);
  for (let i = 0; i < t.length; i++) {
    const cp = t.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (decodeCp936(encodeCp936(ch)) !== ch) {
      return 'U+' + cp.toString(16).toUpperCase() + ' at ' + i;
    }
    if (cp > 0xFFFF) i += 1;
  }
  return '';
}

function stripCr(buf) {
  const src = buf ? Buffer.from(buf) : Buffer.alloc(0);
  if (!src.includes(0x0d)) return src;
  const out = Buffer.allocUnsafe(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x0d && src[i + 1] === 0x0a) continue;
    if (src[i] === 0x0d) {
      out[n++] = 0x0a;
      continue;
    }
    out[n++] = src[i];
  }
  return out.subarray(0, n);
}

function hasCrlf(buf) {
  const src = buf ? Buffer.from(buf) : Buffer.alloc(0);
  for (let i = 0; i < src.length - 1; i++) {
    if (src[i] === 0x0d && src[i + 1] === 0x0a) return true;
  }
  return false;
}

function encodeMapped(kind, crlf) {
  const k = String(kind || 'Ascii');
  return crlf ? k + '+crlf' : k;
}

function parseMapped(mapped) {
  const s = String(mapped || '');
  if (s.length > 5 && s.slice(-5) === '+crlf') return { kind: s.slice(0, -5), crlf: true };
  return { kind: s, crlf: false };
}

function applyClean(kind, wtBytes, opts) {
  const k = kind || 'Utf8';
  const keepCrlf = !!(opts && opts.crlf);
  const raw = wtBytes ? Buffer.from(wtBytes) : Buffer.alloc(0);
  const buf = keepCrlf ? raw : stripCr(raw);
  if (k === 'Ascii' || k === 'Utf8') return buf;
  if (k === 'Utf8Bom') {
    if (hasUtf8Bom(buf)) return buf;
    return Buffer.concat([UTF8_BOM, buf]);
  }
  if (k === 'Gbk') {
    // 尚未 smudge 的磁盘 GBK 原字节：git 不会自动再转。
    // 若仍按 UTF-8 解码会变成 U+FFFD，往返失败。
    if (!isStrictUtf8(buf)) return buf;
    const text = wtToText(buf);
    const encoded = encodeCp936(text);
    if (decodeCp936(encoded) !== text) {
      const hint = firstUnencodable(text);
      const err = new Error('cp936 roundtrip failed' + (hint ? ' (' + hint + ')' : ''));
      err.code = 'ZKZ_ROUNDTRIP';
      // git status 也会走 clean；required=true 时抛错会让整条 status 失败。
      // 往返失败时原样交回工作区字节，提交仍由 pre-commit 拦。
      if (process.env.ZKZ_NATIVE_STRICT === '1') throw err;
      err.soft = true;
      return buf;
    }
    return encoded;
  }
  throw new Error('unknown encoding kind: ' + k);
}

function kindForNewFile(wtBytes) {
  const kind = detectKind(wtBytes);
  if (kind === 'Gbk') {
    const err = new Error('new file is not UTF-8/ASCII');
    err.code = 'ZKZ_NEW_NOT_UTF8';
    throw err;
  }
  return kind === 'Utf8Bom' ? 'Utf8' : kind;
}

module.exports = {
  UTF8_BOM,
  requireIconv,
  hasUtf8Bom,
  isStrictUtf8,
  hasNonAscii,
  detectKind,
  decodeCp936,
  encodeCp936,
  roundtripOk,
  wtToText,
  applySmudge,
  applyClean,
  kindForNewFile,
  firstUnencodable,
  stripCr,
  hasCrlf,
  encodeMapped,
  parseMapped
};
