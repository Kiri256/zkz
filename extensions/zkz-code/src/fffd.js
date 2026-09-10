'use strict';
const path = require('path');
const fs = require('fs');
const { loadWorkspaceLists } = require('./lists');

function textExtSet() {
  const L = loadWorkspaceLists();
  return new Set(L.fffdTextExtensions || L.textExtensions || []);
}
function skipTopSet() {
  return new Set((loadWorkspaceLists().fffdSkipTop || []).map((s) => String(s).toLowerCase()));
}

function countFffd(buf) {
  let n = 0;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) n++;
  }
  return n;
}

function shouldCheckFffd(fsPath, sandbox) {
  if (!sandbox || !fsPath) return false;
  const rel = path.relative(sandbox, fsPath);
  if (!rel || rel.startsWith('..')) return false;
  const top = rel.split(/[/\\]/)[0].toLowerCase();
  if (skipTopSet().has(top)) return false;
  if (!textExtSet().has(path.extname(fsPath).toLowerCase())) return false;
  try { if (fs.statSync(fsPath).size > 2 * 1024 * 1024) return false; } catch (_) { return false; }
  return true;
}

function isSkippedSandboxTop(relOrTop) {
  const top = String(relOrTop || '').split(/[/\\]/)[0].toLowerCase();
  return skipTopSet().has(top);
}

module.exports = {
  get TEXT_EXT() { return textExtSet(); },
  get SKIP_TOP() { return skipTopSet(); },
  countFffd,
  shouldCheckFffd,
  isSkippedSandboxTop
};
