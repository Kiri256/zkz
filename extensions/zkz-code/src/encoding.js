'use strict';
let iconv = null;
try { iconv = require('iconv-lite'); } catch (_) { iconv = null; }

function detectBufferEncoding(buf) {
  if (!buf || !buf.length) return 'utf8';
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf8';
  } catch (_) {
    return 'gbk';
  }
}

function bufferToText(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    if (iconv) {
      try { return iconv.decode(buf, 'gb18030'); } catch (_2) { /* fall */ }
      try { return iconv.decode(buf, 'gbk'); } catch (_3) { /* fall */ }
    }
    try { return new TextDecoder('gbk').decode(buf); } catch (_4) { /* fall */ }
    return buf.toString('latin1');
  }
}

/** Sync encode; callers may await (thenable not required). */
function encodeTextBuffer(text, encoding) {
  const enc = encoding === 'utf8' ? 'utf-8' : (encoding || 'gbk');
  if (enc === 'utf-8' || enc === 'utf8') {
    return Buffer.from(String(text), 'utf8');
  }
  const name = enc === 'gb18030' ? 'gb18030' : 'gbk';
  if (iconv && iconv.encodingExists(name)) {
    return iconv.encode(String(text), name);
  }
  // last resort: keep utf8 rather than corrupt silently with wrong bytes
  throw new Error('iconv-lite unavailable, cannot encode ' + name);
}

function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function hasUtf8Bom(buf) {
  return buf && buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
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
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 127) return true;
  }
  return false;
}

/** 与脚本 Get-TextEncodingKind 对齐：Utf8Bom / Utf8 / Ascii / Gbk */
function getTextEncodingKind(buf) {
  if (!buf || !buf.length) return 'Ascii';
  if (hasUtf8Bom(buf)) return isStrictUtf8(buf) ? 'Utf8Bom' : 'Gbk';
  if (isStrictUtf8(buf)) return hasNonAscii(buf) ? 'Utf8' : 'Ascii';
  return 'Gbk';
}

function bytesToUtf8Text(buf) {
  const kind = getTextEncodingKind(buf);
  if (kind === 'Utf8Bom') return Buffer.from(buf).slice(3).toString('utf8');
  if (kind === 'Utf8' || kind === 'Ascii') return Buffer.from(buf).toString('utf8');
  return bufferToText(buf);
}

function encodeTextByKind(text, kind) {
  const k = kind || 'Gbk';
  if (k === 'Utf8Bom') {
    return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(String(text), 'utf8')]);
  }
  if (k === 'Utf8' || k === 'Ascii') return Buffer.from(String(text), 'utf8');
  return encodeTextBuffer(String(text), 'gbk');
}

module.exports = {
  detectBufferEncoding,
  bufferToText,
  encodeTextBuffer,
  looksBinary,
  getTextEncodingKind,
  bytesToUtf8Text,
  encodeTextByKind
};
