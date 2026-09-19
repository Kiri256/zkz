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

function nativeLogPath(repoRoot) {
  return path.join(zkzDir(repoRoot), 'zkz-native.log');
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

function libTops(repoRoot) {
  const hit = gLibCache.get(repoRoot);
  if (hit && hit.names) return hit.names;
  const set = new Set(DEFAULT_LIB_TOPS.map((s) => s.toLowerCase()));
  for (const n of listJunctionTops(repoRoot)) set.add(n.toLowerCase());
  const names = [];
  let ents = [];
  try { ents = fs.readdirSync(repoRoot, { withFileTypes: true }); } catch (_) { return DEFAULT_LIB_TOPS.slice(); }
  for (const ent of ents) {
    if (set.has(ent.name.toLowerCase())) names.push(ent.name);
  }
  gLibCache.set(repoRoot, { names: names, set: new Set(names.map((s) => s.toLowerCase())) });
  return names;
}

function isLibRel(repoRoot, rel) {
  const top = slashRel(rel).split('/')[0];
  if (!top) return false;
  let hit = gLibCache.get(repoRoot);
  if (!hit || !hit.set) {
    libTops(repoRoot);
    hit = gLibCache.get(repoRoot);
  }
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

function appendLog() {
  /* 不再写 .zkz/zkz-native.log */
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
  nativeLogPath,
  isSourceExt,
  DEFAULT_LIB_TOPS,
  DEFAULT_SKIP_DIR,
  isReparse,
  listJunctionTops,
  libTops,
  isLibRel,
  findRepoRoot,
  appendLog
};
