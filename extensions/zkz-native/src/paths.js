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

function tablePath(repoRoot) {
  return path.join(zkzDir(repoRoot), '.workspace_source_encodings.json');
}

function configPathsFile(repoRoot) {
  return path.join(zkzDir(repoRoot), 'config_paths.json');
}

function keilNativeRoot(repoRoot) {
  return path.join(zkzDir(repoRoot), 'keil-native');
}

function keilStampPath(repoRoot) {
  return path.join(zkzDir(repoRoot), 'keil-native-stamp.json');
}

function skipWorktreeStampPath(repoRoot) {
  return path.join(zkzDir(repoRoot), 'skip-worktree-stamp.json');
}

function configOverlayRoot(repoRoot) {
  return path.join(zkzDir(repoRoot), 'config-overlay');
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

function workspaceListsFile(repoRoot) {
  if (!repoRoot) return '';
  const json = path.join(repoRoot, '.zkz', 'workspace_lists.json');
  const jsonc = path.join(repoRoot, '.zkz', 'workspace_lists.jsonc');
  try { if (fs.existsSync(json) && fs.statSync(json).isFile()) return json; } catch (_) { /* ignore */ }
  try { if (fs.existsSync(jsonc) && fs.statSync(jsonc).isFile()) return jsonc; } catch (_) { /* ignore */ }
  return '';
}

function listsStamp(p) {
  if (!p) return 'missing';
  try {
    const st = fs.statSync(p);
    return p + '|' + st.mtimeMs + '|' + st.size;
  } catch (_) {
    return p + '|missing';
  }
}

function stripJsonc(text) {
  let t = String(text || '');
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  t = t.replace(/^\s*\/\/.*$/gm, '');
  t = t.replace(/\s+\/\/.*$/gm, '');
  t = t.replace(/,(\s*[}\]])/g, '$1');
  return t.trim();
}

function configuredLibNames(repoRoot) {
  const p = workspaceListsFile(repoRoot);
  if (!p) return null;
  try {
    const data = JSON.parse(stripJsonc(fs.readFileSync(p, 'utf8')));
    if (!data || !Array.isArray(data.libraryDirNames)) return null;
    const out = [];
    const seen = new Set();
    for (let i = 0; i < data.libraryDirNames.length; i++) {
      const name = String(data.libraryDirNames[i] || '').trim().replace(/\\/g, '/').split('/')[0];
      if (!name || name === '.' || name === '..') continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  } catch (_) {
    return null;
  }
}

function rememberLibTops(repoRoot) {
  const file = workspaceListsFile(repoRoot);
  const stamp = listsStamp(file);
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
  return path.join(zkzDir(repoRoot), 'roundtrip-failures.json');
}

function filterFailPath(repoRoot) {
  return path.join(zkzDir(repoRoot), 'filter-fail.json');
}

function handshakeRejectPath(repoRoot) {
  return path.join(zkzDir(repoRoot), 'handshake-reject.json');
}

function libEncodingWarnPath(repoRoot) {
  return path.join(zkzDir(repoRoot), 'lib-encoding-warnings.json');
}

function nativeLogFile(repoRoot) {
  return path.join(zkzDir(repoRoot), 'zkz-native.log');
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
  ensureZkz,
  formatLocalNow,
  tablePath,
  configPathsFile,
  keilNativeRoot,
  keilStampPath,
  skipWorktreeStampPath,
  configOverlayRoot,
  isSourceExt,
  DEFAULT_LIB_TOPS,
  libTopNames,
  DEFAULT_SKIP_DIR,
  isReparse,
  listJunctionTops,
  libTops,
  isLibRel,
  findRepoRoot,
  sleepSync,
  atomicWriteFile,
  atomicWriteJson,
  roundtripFailPath,
  filterFailPath,
  handshakeRejectPath,
  libEncodingWarnPath,
  nativeLogFile,
  appendLog
};
