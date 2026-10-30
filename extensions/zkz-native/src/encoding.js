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

// 从 start 起判断是不是严格 UTF-8。非法序列返回 Gbk，纯 ASCII 返回 Ascii，否则 Utf8。不分配字符串。
function utf8Class(buf, start) {
  let i = start || 0;
  let nonAscii = false;
  while (i < buf.length) {
    const b = buf[i];
    if (b <= 0x7F) { i += 1; continue; }
    nonAscii = true;
    let need = 0;
    if (b >= 0xC2 && b <= 0xDF) need = 1;
    else if (b === 0xE0) need = 2;
    else if (b >= 0xE1 && b <= 0xEC) need = 2;
    else if (b === 0xED) need = 2;
    else if (b >= 0xEE && b <= 0xEF) need = 2;
    else if (b === 0xF0) need = 3;
    else if (b >= 0xF1 && b <= 0xF3) need = 3;
    else if (b === 0xF4) need = 3;
    else return 'Gbk';
    if (i + need >= buf.length) return 'Gbk';
    const b1 = buf[i + 1];
    if ((b1 & 0xC0) !== 0x80) return 'Gbk';
    if (b === 0xE0 && b1 < 0xA0) return 'Gbk';
    if (b === 0xED && b1 >= 0xA0) return 'Gbk';
    if (b === 0xF0 && b1 < 0x90) return 'Gbk';
    if (b === 0xF4 && b1 >= 0x90) return 'Gbk';
    for (let k = 2; k <= need; k++) {
      if ((buf[i + k] & 0xC0) !== 0x80) return 'Gbk';
    }
    i += 1 + need;
  }
  return nonAscii ? 'Utf8' : 'Ascii';
}

function isStrictUtf8(buf) {
  if (!buf || !buf.length) return true;
  return utf8Class(buf, 0) !== 'Gbk';
}

function hasNonAscii(buf) {
  if (!buf) return false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 127) return true;
  }
  return false;
}

// 一次扫描判断编码。非法 UTF-8 立刻当 GBK，不把整文件解码成字符串。返回种类。过滤进程和扩展宿主调用。
function detectKind(buf) {
  if (!buf || !buf.length) return 'Ascii';
  if (hasUtf8Bom(buf)) {
    const rest = utf8Class(buf, 3);
    return rest === 'Gbk' ? 'Gbk' : 'Utf8Bom';
  }
  return utf8Class(buf, 0);
}

function normalizeCp936Text(text) {
  return String(text).replace(/\uFFFD/g, '');
}

function sentinelChar(byte) {
  return String.fromCharCode(0xE000 + byte);
}

function decodeCp936Bytes(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const iconv = requireIconv();
  let out = '';
  let i = 0;
  while (i < src.length) {
    const b0 = src[i];
    if (b0 >= 0x81 && b0 <= 0xFE && i + 1 < src.length) {
      const pair = iconv.decode(src.slice(i, i + 2), 'gbk');
      if (pair.indexOf('\uFFFD') < 0) {
        out += pair;
        i += 2;
        continue;
      }
    }
    const one = iconv.decode(src.slice(i, i + 1), 'gbk');
    if (one.indexOf('\uFFFD') < 0) {
      out += one;
      i += 1;
      continue;
    }
    out += sentinelChar(b0);
    i += 1;
  }
  return out;
}

function decodeCp936Raw(buf) {
  if (!buf || !buf.length) return '';
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const text = requireIconv().decode(src, 'gbk');
  if (text.indexOf('\uFFFD') < 0) return text;
  return decodeCp936Bytes(src);
}

function cp936DropInfo(text, stage) {
  const t = String(text);
  if (t.indexOf('\uFFFD') < 0) return { stage: stage, count: 0, positions: [], message: '' };
  const positions = [];
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) === 0xFFFD) positions.push(i);
  }
  const shown = positions.slice(0, 8);
  let message = '';
  if (positions.length) {
    message = stage + ' dropped ' + positions.length + ' U+FFFD at ' + shown.join(', ');
    if (positions.length > shown.length) message += ', ...';
  }
  return { stage: stage, count: positions.length, positions: shown, message: message };
}

function reportCp936Drop(opts, info) {
  if (opts && typeof opts.onDrop === 'function') {
    try { opts.onDrop(info); } catch (_) { /* ignore */ }
  }
}

function decodeCp936(buf) {
  return normalizeCp936Text(decodeCp936Raw(buf));
}

function encodeCp936(text) {
  const iconv = requireIconv();
  const s = String(text);
  const chunks = [];
  let plain = '';
  const flush = () => {
    if (!plain) return;
    chunks.push(Buffer.from(iconv.encode(plain, 'gbk')));
    plain = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xE000 && c <= 0xE0FF) {
      flush();
      chunks.push(Buffer.from([c - 0xE000]));
    } else {
      plain += s.charAt(i);
    }
  }
  flush();
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function roundtripOk(text) {
  const t = normalizeCp936Text(text);
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

function applySmudge(kind, blobBytes, opts) {
  const k = kind || 'Ascii';
  const buf = !blobBytes ? Buffer.alloc(0) : (Buffer.isBuffer(blobBytes) ? blobBytes : Buffer.from(blobBytes));
  if (k === 'Ascii' || k === 'Utf8') return buf;
  if (k === 'Utf8Bom') return hasUtf8Bom(buf) ? buf.slice(3) : buf;
  if (k === 'Gbk') {
    const decoded = decodeCp936Raw(buf);
    reportCp936Drop(opts, cp936DropInfo(decoded, 'smudge'));
    return Buffer.from(normalizeCp936Text(decoded), 'utf8');
  }
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
    // 磁盘上仍是 GBK 原字节时，不要按 UTF-8 再编一次。
    // 工作区里已有的 U+FFFD 丢掉并记下。解不开的原字节用私用区字符原样带回，避免状态消不掉。
    if (!isStrictUtf8(buf)) return buf;
    const rawText = wtToText(buf);
    const drop = cp936DropInfo(rawText, 'clean');
    const text = normalizeCp936Text(rawText);
    const encoded = encodeCp936(text);
    if (decodeCp936(encoded) !== text) {
      const hint = firstUnencodable(text);
      const err = new Error('cp936 roundtrip failed' + (hint ? ' (' + hint + ')' : ''));
      err.code = 'ZKZ_ROUNDTRIP';
      // git status 也会跑 clean；required=true 时抛错会让整个 status 失败。
      // 往返失败时原样交回工作区字节，提交仍由 pre-commit 拦住。
      if (process.env.ZKZ_NATIVE_STRICT === '1') throw err;
      if (opts && typeof opts.onSoftFail === 'function') {
        try { opts.onSoftFail(err); } catch (_) { /* ignore */ }
      }
      return buf;
    }
    reportCp936Drop(opts, drop);
    return encoded;
  }
  throw new Error('unknown encoding kind: ' + k);
}

function planNewFile(wtBytes) {
  const buf = Buffer.from(wtBytes || []);
  const kind = detectKind(buf);
  return { blob: buf, mapped: encodeMapped(kind, hasCrlf(buf)), worktree: null };
}

function kindForNewFile(wtBytes) {
  return parseMapped(planNewFile(wtBytes).mapped).kind;
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
  planNewFile,
  kindForNewFile,
  firstUnencodable,
  stripCr,
  hasCrlf,
  encodeMapped,
  parseMapped
};
