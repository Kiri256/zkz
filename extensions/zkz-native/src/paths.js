'use strict';

const path = require('path');
const fs = require('fs');

function slashRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function zkzDir(repoRoot) {
  return path.join(repoRoot, '.zkz');
}

function ensureZkz(repoRoot) {
  const dir = zkzDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runDir(repoRoot) {
  return path.join(zkzDir(repoRoot), 'run');
}

function runFile(repoRoot, name) {
  return path.join(runDir(repoRoot), name);
}

function tablePath(repoRoot) {
  return runFile(repoRoot, 'encoding-table.json');
}

function keilNativeRoot(repoRoot) {
  return path.join(zkzDir(repoRoot), 'keil-native');
}

function keilStampPath(repoRoot) {
  return runFile(repoRoot, 'keil-stamp.json');
}

// 这次命令的临时副本，目录是 .zkz/local。命令结束就删。
function localKeepRoot(repoRoot) {
  return path.join(zkzDir(repoRoot), 'local');
}

function isSourceExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.c' || ext === '.h';
}

const DEFAULT_LIB_TOPS = [
  'Libraries',
  'FreeRTOS',
  'Modbus_zlg',
  'FPU_DSP',
  'RL-ARM',
  'emWin',
  'fatfs',
  'USB'
];

const DEFAULT_SKIP_DIR = [
  '.git', '.svn', '.hg', '.zkz', '.vscode', '.cursor', '.codex', '.claude',
  '.continue', '.windsurf', '.idea', '.vs', '.cache', '.clangd',
  '.clangd-index', '.clangd-cache', 'node_modules', '__pycache__',
  'Flash', 'Obj', 'Listings', 'DebugConfig', 'ai_dialog', 'tools', 'zkz'
];

function isReparse(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink();
  } catch (_) {
    return false;
  }
}

function listJunctionTops(repoRoot) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(repoRoot, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of ents) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const full = path.join(repoRoot, ent.name);
    if (isReparse(full)) out.push(ent.name);
  }
  return out;
}

const gLibCache = new Map();

function listsStamp(p) {
  if (!p) return 'missing';
  try {
    const st = fs.statSync(p);
    return p + '|' + st.mtimeMs + '|' + st.ctimeMs + '|' + st.size;
  } catch (_) {
    return p + '|missing';
  }
}

function normalizeLibNames(names) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < names.length; i++) {
    const name = String(names[i] || '').trim().replace(/\\/g, '/').split('/')[0];
    if (!name || name === '.' || name === '..') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** 读 settings.json 的 lists.libraryDirNames。没有这项返回 null，调用方用内置默认。扩展宿主或过滤进程调用。 */
function configuredLibNames(repoRoot) {
  if (!repoRoot) return null;
  let names = null;
  try {
    names = require('./load_shared')('zkz_settings').get(repoRoot, 'lists', 'libraryDirNames', null);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(names)) return null;
  return normalizeLibNames(names);
}

function rememberLibTops(repoRoot) {
  const stamp = listsStamp(repoRoot ? path.join(repoRoot, '.zkz', 'settings.json') : '');
  const hit = gLibCache.get(repoRoot);
  if (hit && hit.stamp === stamp && hit.all) return hit;
  const configured = configuredLibNames(repoRoot);
  const base = configured || DEFAULT_LIB_TOPS.slice();
  const seen = new Set();
  const all = [];
  const push = (name) => {
    const n = String(name || '').trim();
    if (!n) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    all.push(n);
  };
  for (let i = 0; i < base.length; i++) push(base[i]);
  const junctions = listJunctionTops(repoRoot);
  for (let i = 0; i < junctions.length; i++) push(junctions[i]);
  const onDisk = new Set();
  let ents = [];
  try { ents = fs.readdirSync(repoRoot, { withFileTypes: true }); } catch (_) { ents = []; }
  for (let i = 0; i < ents.length; i++) {
    if (ents[i].isDirectory() || ents[i].isSymbolicLink()) onDisk.add(ents[i].name.toLowerCase());
  }
  const names = [];
  for (let i = 0; i < all.length; i++) {
    if (onDisk.has(all[i].toLowerCase())) names.push(all[i]);
  }
  const next = { stamp: stamp, all: all, names: names, set: new Set(all.map((s) => s.toLowerCase())) };
  gLibCache.set(repoRoot, next);
  if (gLibCache.size > 8) gLibCache.delete(gLibCache.keys().next().value);
  return next;
}

function libTopNames(repoRoot) {
  return rememberLibTops(repoRoot).all.slice();
}

function libTops(repoRoot) {
  return rememberLibTops(repoRoot).names.slice();
}

function isLibRel(repoRoot, rel) {
  const top = slashRel(rel).split('/')[0];
  if (!top) return false;
  const hit = rememberLibTops(repoRoot);
  if (hit && hit.set) return hit.set.has(top.toLowerCase());
  return DEFAULT_LIB_TOPS.map((s) => s.toLowerCase()).indexOf(top.toLowerCase()) >= 0;
}

function createLibMatcher(repoRoot, refresh) {
  if (refresh) gLibCache.delete(repoRoot);
  const set = new Set(rememberLibTops(repoRoot).set);
  return (rel) => set.has(slashRel(rel).split('/')[0].toLowerCase());
}

function findRepoRoot(startDir) {
  let cur = startDir || process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(cur, '.git')) || fs.existsSync(path.join(cur, '.zkz'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return startDir || process.cwd();
}

function sleepSync(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  } catch (_) {
    const end = Date.now() + n;
    while (Date.now() < end) { /* spin */ }
  }
}

function tmpSibling(file) {
  return file + '.' + process.pid + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp';
}

function atomicWriteFile(file, data, encoding) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tmpSibling(file);
  try {
    fs.writeFileSync(tmp, data, encoding || 'utf8');
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        lastErr = e;
        try {
          fs.copyFileSync(tmp, file);
          return;
        } catch (e2) {
          lastErr = e2;
          if (i < 2) sleepSync(20 * (i + 1));
        }
      }
    }
    if (lastErr) throw lastErr;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

function atomicWriteJson(file, obj) {
  atomicWriteFile(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function roundtripFailPath(repoRoot) {
  return runFile(repoRoot, 'encoding-roundtrip.json');
}

function filterFailPath(repoRoot) {
  return runFile(repoRoot, 'filter-failures.json');
}

function handshakeRejectPath(repoRoot) {
  return runFile(repoRoot, 'handshake-reject.json');
}

function libEncodingWarnPath(repoRoot) {
  return runFile(repoRoot, 'encoding-lib-warnings.json');
}

function nativeLogFile(repoRoot) {
  return runFile(repoRoot, 'zkz-native.log');
}

function nativeStatusPath(repoRoot) {
  return runFile(repoRoot, 'native-status.json');
}

function commitRejectPath(repoRoot) {
  return runFile(repoRoot, 'commit-reject.json');
}

function appendLog(repoRoot, msg) {
  if (process.env.ZKZ_NATIVE_LOG !== '1') return;
  try {
    ensureZkz(repoRoot);
    fs.appendFileSync(nativeLogFile(repoRoot), formatLocalNow() + ' ' + String(msg == null ? '' : msg) + '\n', 'utf8');
  } catch (_) { /* ignore */ }
}

/** 本地墙钟 + 时区偏移，避免 toISOString() 的 UTC/Z 看起来像快慢 8 小时 */
function formatLocalNow(d) {
  const x = d || new Date();
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const y = x.getFullYear();
  const mo = pad(x.getMonth() + 1);
  const day = pad(x.getDate());
  const h = pad(x.getHours());
  const mi = pad(x.getMinutes());
  const s = pad(x.getSeconds());
  const offMin = -x.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return y + '-' + mo + '-' + day + ' ' + h + ':' + mi + ':' + s + ' ' + sign + oh + om;
}

module.exports = {
  slashRel,
  zkzDir,
  runDir,
  ensureZkz,
  formatLocalNow,
  tablePath,
  keilNativeRoot,
  keilStampPath,
  localKeepRoot,
  isSourceExt,
  DEFAULT_LIB_TOPS,
  libTopNames,
  DEFAULT_SKIP_DIR,
  isReparse,
  listJunctionTops,
  libTops,
  isLibRel,
  createLibMatcher,
  findRepoRoot,
  sleepSync,
  atomicWriteFile,
  atomicWriteJson,
  roundtripFailPath,
  filterFailPath,
  handshakeRejectPath,
  libEncodingWarnPath,
  nativeLogFile,
  nativeStatusPath,
  commitRejectPath,
  appendLog
};
