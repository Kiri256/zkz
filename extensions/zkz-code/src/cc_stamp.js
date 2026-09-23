'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function isOid(s) {
  return /^[0-9a-f]{40}$/i.test(s);
}

function gitDirOf(repoRoot) {
  if (!repoRoot) return '';
  const dot = path.join(repoRoot, '.git');
  let st = null;
  try { st = fs.statSync(dot); } catch (_) { return ''; }
  if (st.isDirectory()) return dot;
  try {
    const text = fs.readFileSync(dot, 'utf8');
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (!m) return '';
    return path.resolve(repoRoot, m[1].trim());
  } catch (_) {
    return '';
  }
}

function readPackedOid(gitDir, ref) {
  let text = '';
  try { text = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8'); } catch (_) { return ''; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.charAt(0) === '#' || line.charAt(0) === '^') continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const oid = line.slice(0, sp).trim();
    const name = line.slice(sp + 1).trim();
    if (name === ref && isOid(oid)) return oid.toLowerCase();
  }
  return '';
}

/** 读 .git/HEAD 得到当前 oid，不启动 git 进程。 */
function readHeadOid(repoRoot) {
  const gitDir = gitDirOf(repoRoot);
  if (!gitDir) return '';
  let head = '';
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch (_) { return ''; }
  if (isOid(head)) return head.toLowerCase();
  const m = head.match(/^ref:\s*(.+)$/);
  if (!m) return '';
  const ref = m[1].trim();
  try {
    const oid = fs.readFileSync(path.join(gitDir, ...ref.split('/')), 'utf8').trim();
    if (isOid(oid)) return oid.toLowerCase();
  } catch (_) { /* loose ref 不存在时查 packed-refs */ }
  return readPackedOid(gitDir, ref);
}

function gitHead(root) {
  if (!root) return '';
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true
    });
    if (r.status !== 0) return '';
    return String(r.stdout || '').trim();
  } catch (_) {
    return '';
  }
}

function compileCommandsStampPath(root) {
  return path.join(root, '.zkz', 'compile-commands-stamp.json');
}

function readCompileCommandsStamp(root) {
  try {
    return JSON.parse(fs.readFileSync(compileCommandsStampPath(root), 'utf8'));
  } catch (_) {
    return null;
  }
}

function formatLocalNow(d) {
  const x = d || new Date();
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const offMin = -x.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate())
    + ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes()) + ':' + pad(x.getSeconds())
    + ' ' + sign + pad(Math.floor(abs / 60)) + pad(abs % 60);
}

function writeCompileCommandsStamp(root, head) {
  if (!root) return;
  fs.mkdirSync(path.join(root, '.zkz'), { recursive: true });
  fs.writeFileSync(compileCommandsStampPath(root), JSON.stringify({
    version: 1,
    head: String(head || ''),
    at: formatLocalNow()
  }, null, 2) + '\n', 'utf8');
}

function isCompileCommandsStale(root, head) {
  if (!root) return false;
  const cc = path.join(root, 'compile_commands.json');
  if (!fs.existsSync(cc)) return true;
  const h = head || gitHead(root);
  if (!h) return false;
  const stamp = readCompileCommandsStamp(root);
  if (!stamp || !stamp.head) return true;
  return stamp.head !== h;
}

module.exports = {
  gitHead,
  readHeadOid,
  gitDirOf,
  compileCommandsStampPath,
  readCompileCommandsStamp,
  writeCompileCommandsStamp,
  isCompileCommandsStale
};
