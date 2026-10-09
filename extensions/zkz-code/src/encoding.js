'use strict';
let iconv = null;
try { iconv = require('iconv-lite'); } catch (_) { iconv = null; }

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

module.exports = { bufferToText };
