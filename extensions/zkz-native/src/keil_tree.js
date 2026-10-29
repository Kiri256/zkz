'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clean } = require('./filter_core');
const { loadTable, loadMeta, setNoteDefer, flushDeferredNotes } = require('./enc_table');
const {
  slashRel, keilNativeRoot, keilStampPath, isSourceExt,
  DEFAULT_SKIP_DIR, libTops, libTopNames, createLibMatcher, isReparse, atomicWriteJson
} = require('./paths');
const { currentHead, currentBranch, gitText, git, indexBlobOid } = require('./git_exec');
const { acquireLock, releaseLock } = require('./lock');
const { inspectLibEncoding, formatLibWarning, loadLibWarnings, saveLibWarnings } = require('./lib_encoding');
const loadShared = require('./load_shared');
const { record: recordPerf } = loadShared('perf');

const BUSINESS_FALLBACK = ['User', 'core', 'driver', 'application', 'fpga_motion', 'emWin'];
const SKIP_DIR = new Set(DEFAULT_SKIP_DIR);
const PROJECT_KEEP_EXT = ['.sct', '.ini', '.scf'];
const SYNC_READY_FILE = '.zkz-sync-ready';
// 5：分支或 HEAD 变化不再整棵重写。kinds 记下每个文件当时的编码，编码变了才重写那一个。
const SYNC_VERSION = 5;

function syncFingerprint(table, libraries) {
  return crypto.createHash('sha256').update(JSON.stringify([
    libraries, Object.keys(table).sort().map((key) => [key, table[key]])
  ])).digest('hex');
}

function skipSyncPath(rel) {
  const parts = slashRel(rel).split('/');
  const inProject = parts[0] === 'Project' || parts.slice(0, 3).join('/') === 'H750/Projects/MDK-ARM';
  return parts.slice(0, -1).some(skipDirName) && !(inProject && keepProjectFile(rel));
}

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(p, obj) {
  atomicWriteJson(p, obj);
}

function skipDirName(name) {
  return SKIP_DIR.has(name);
}

function keepProjectFile(name) {
  const ext = path.extname(name).toLowerCase();
  return PROJECT_KEEP_EXT.indexOf(ext) >= 0;
}

function listTopDirs(repoRoot, libraryTops) {
  let ents = [];
  try { ents = fs.readdirSync(repoRoot, { withFileTypes: true }); } catch (_) { return []; }
  const libs = new Set(libraryTops.map((s) => s.toLowerCase()));
  const out = [];
  for (const ent of ents) {
    if (skipDirName(ent.name) || ent.name === 'Project' || ent.name === 'H750') continue;
    const full = path.join(repoRoot, ent.name);
    if (libs.has(ent.name.toLowerCase())) continue;
    if (ent.isDirectory() || ent.isSymbolicLink()) {
      if (isReparse(full) && libs.has(ent.name.toLowerCase())) continue;
      out.push(ent.name);
    }
  }
  if (!out.length) return BUSINESS_FALLBACK.filter((n) => fs.existsSync(path.join(repoRoot, n)));
  return out;
}

function walkProjectFiles(srcRoot, relDir, acc) {
  const abs = path.join(srcRoot, relDir);
  let ents = [];
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
  for (const ent of ents) {
    const childRel = relDir + '/' + ent.name;
    if (ent.isDirectory()) {
      if (skipDirName(ent.name)) {
        walkKeepUnder(srcRoot, childRel, acc);
        continue;
      }
      walkProjectFiles(srcRoot, childRel, acc);
    } else if (ent.isFile()) {
      acc.push(slashRel(childRel));
    }
  }
}

function walkKeepUnder(srcRoot, relDir, acc) {
  const abs = path.join(srcRoot, relDir);
  let ents = [];
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
  for (const ent of ents) {
    const childRel = relDir + '/' + ent.name;
    if (ent.isDirectory()) walkKeepUnder(srcRoot, childRel, acc);
    else if (ent.isFile() && keepProjectFile(ent.name)) acc.push(slashRel(childRel));
  }
}

function ensureJunction(link, target) {
  if (isReparse(link)) return;
  if (fs.existsSync(link)) return;
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link, 'junction');
  } catch (e) {
    try { fs.symlinkSync(target, link, 'dir'); } catch (_2) {
      throw e;
    }
  }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  try {
    const st = fs.statSync(src);
    fs.utimesSync(dst, st.atime, st.mtime);
  } catch (_) { /* ignore */ }
}

function diffNameSet(repoRoot, spec) {
  const r = git(repoRoot, ['diff', '--name-only', '--no-renames', '-z'].concat(spec), { allowFail: true });
  if (!r || r.status !== 0) return null;
  const set = new Set();
  String(r.stdout || '').split('\0').filter(Boolean).forEach((name) => set.add(slashRel(name)));
  return set;
}

function skipWorktreeSet(repoRoot) {
  const out = gitText(repoRoot, ['ls-files', '-v', '-z'], { allowFail: true });
  const set = new Set();
  String(out || '').split('\0').filter(Boolean).forEach((rec) => {
    if (rec.charAt(0) !== 'S' && rec.charAt(0) !== 's') return;
    const name = rec.charAt(1) === ' ' ? rec.slice(2) : rec.slice(1);
    if (name) set.add(slashRel(name));
  });
  return set;
}

const KEIL_CACHE_LIMIT = 4;
// 哪些提交已有编烧树。本进程的顺序；文件只在顺序变化时写。
const gKeilOrder = { root: '', text: '', order: null };

function commitOid(value) {
  const oid = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : '';
}

// 检出后编码表可能晚到。目录比对期间等到这份提交的表落盘，再拿来用。
function loadSettledTable(repoRoot, head) {
  const want = commitOid(head);
  const started = Date.now();
  let table = null;
  for (; ;) {
    const held = acquireLock(repoRoot, 'encoding-table');
    try {
      table = loadTable(repoRoot);
      const meta = loadMeta(repoRoot);
      const got = meta && commitOid(meta.head);
      if (!want || !got || got === want) return table;
    } finally {
      releaseLock(held);
    }
    if (Date.now() - started >= 2000) return table;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  }
}

function keilCacheRoot(repoRoot) {
  return path.join(path.dirname(keilStampPath(repoRoot)), 'keil-cache');
}

function keilCacheSlot(repoRoot, oid) {
  return path.join(keilCacheRoot(repoRoot), oid);
}

// 库是 junction，拷进缓存会把库本体再复制一份。Flash 等编译产物也不进缓存，留在当前这棵树上。
function copyTreeFiles(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const ents = fs.readdirSync(src, { withFileTypes: true });
  for (let i = 0; i < ents.length; i++) {
    const ent = ents[i];
    if (skipDirName(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (isReparse(from)) continue;
    let st = null;
    try { st = fs.lstatSync(from); } catch (_) { continue; }
    if (st.isDirectory()) copyTreeFiles(from, to);
    else if (st.isFile()) fs.copyFileSync(from, to);
  }
}

// 读本进程里的编烧缓存顺序。没有就读文件。返回提交号数组。扩展宿主调用。
function loadKeilOrder(repoRoot) {
  if (gKeilOrder.root === repoRoot && Array.isArray(gKeilOrder.order)) return gKeilOrder.order.slice();
  const file = path.join(keilCacheRoot(repoRoot), 'order.json');
  let order = [];
  try { order = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { order = []; }
  if (!Array.isArray(order)) order = [];
  gKeilOrder.root = repoRoot;
  gKeilOrder.order = order.slice();
  gKeilOrder.text = JSON.stringify(order);
  return order;
}

// 记下编烧缓存顺序。没变不写文件。扩展宿主调用。
function storeKeilOrder(repoRoot, order) {
  const text = JSON.stringify(order);
  gKeilOrder.root = repoRoot;
  gKeilOrder.order = order.slice();
  if (gKeilOrder.text === text) return;
  const root = keilCacheRoot(repoRoot);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'order.json'), text, 'utf8');
  gKeilOrder.text = text;
}

function rememberKeilOrder(repoRoot, oid, pin) {
  const root = keilCacheRoot(repoRoot);
  let order = loadKeilOrder(repoRoot);
  order = order.filter((item) => item !== oid);
  order.push(oid);
  while (order.length > KEIL_CACHE_LIMIT) {
    let dropped = false;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === oid || order[i] === pin) continue;
      const drop = order.splice(i, 1)[0];
      try { fs.rmSync(path.join(root, drop), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      dropped = true;
      break;
    }
    if (!dropped) break;
  }
  storeKeilOrder(repoRoot, order);
}

function keilCacheReady(repoRoot, oid) {
  const slot = keilCacheSlot(repoRoot, oid);
  return fs.existsSync(path.join(slot, 'tree', SYNC_READY_FILE))
    && fs.existsSync(path.join(slot, 'stamp.json'));
}

function parkKeilCopy(repoRoot, oid, kn, stamp, pin) {
  const slot = keilCacheSlot(repoRoot, oid);
  const tmp = slot + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'tree'), { recursive: true });
  try {
    copyTreeFiles(kn, path.join(tmp, 'tree'));
    writeJson(path.join(tmp, 'stamp.json'), stamp);
    fs.rmSync(slot, { recursive: true, force: true });
    fs.renameSync(tmp, slot);
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw err;
  }
  rememberKeilOrder(repoRoot, oid, pin);
}

function parkKeilRename(repoRoot, oid, kn, stamp, pin) {
  const slot = keilCacheSlot(repoRoot, oid);
  fs.rmSync(slot, { recursive: true, force: true });
  fs.mkdirSync(slot, { recursive: true });
  fs.renameSync(kn, path.join(slot, 'tree'));
  writeJson(path.join(slot, 'stamp.json'), stamp);
  rememberKeilOrder(repoRoot, oid, pin);
}

function takeKeilCache(repoRoot, oid, kn) {
  const slot = keilCacheSlot(repoRoot, oid);
  const tree = path.join(slot, 'tree');
  const stampFile = path.join(slot, 'stamp.json');
  if (!fs.existsSync(tree) || !fs.existsSync(stampFile)) return null;
  const cached = readJson(stampFile, null);
  if (!cached || cached.complete !== true || cached.version !== SYNC_VERSION) return null;
  fs.renameSync(tree, kn);
  try { fs.rmSync(slot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  try {
    storeKeilOrder(repoRoot, loadKeilOrder(repoRoot).filter((item) => item !== oid));
  } catch (_) { /* ignore */ }
  return cached;
}

// 换提交时把当前编烧树留下。目标提交已有缓存就整棵换上，否则复制一份再在原地增量同步。
function swapKeilCache(repoRoot, kn, stamp, head) {
  const fromOid = commitOid(stamp && stamp.head);
  const toOid = commitOid(head);
  if (!fromOid || !toOid || fromOid === toOid) return null;
  if (!stamp || stamp.complete !== true || stamp.version !== SYNC_VERSION) return null;
  if (!fs.existsSync(path.join(kn, SYNC_READY_FILE))) return null;
  if (keilCacheReady(repoRoot, toOid)) {
    parkKeilRename(repoRoot, fromOid, kn, stamp, toOid);
    try {
      const taken = takeKeilCache(repoRoot, toOid, kn);
      if (taken) return taken;
    } catch (_) { /* 换不上就把刚挪走的树搬回来 */ }
    const parked = path.join(keilCacheSlot(repoRoot, fromOid), 'tree');
    if (!fs.existsSync(kn) && fs.existsSync(parked)) fs.renameSync(parked, kn);
    return null;
  }
  parkKeilCopy(repoRoot, fromOid, kn, stamp, toOid);
  return null;
}

// 树已经是这个提交的。工作区相对 HEAD 没改的文件只刷新时间戳。
function dropCleanWorktree(repoRoot, stamp, dirty, kn) {
  const local = diffNameSet(repoRoot, ['HEAD']);
  if (!local) return;
  const skipped = skipWorktreeSet(repoRoot);
  for (const rel of Array.from(dirty)) {
    const previous = (stamp.files && stamp.files[rel]) || '';
    if (!previous) continue;
    if (skipped.has(rel) || local.has(rel)) continue;
    if (!fs.existsSync(path.join(kn, rel))) continue;
    dirty.delete(rel);
  }
}

// 检出会改时间戳。提交和工作区内容都没变的文件只更新戳，不重写编烧副本。
function relaxUnchangedBlobs(repoRoot, stamp, head, dirty, files) {
  const from = String(stamp.head || '').trim().toLowerCase();
  const to = String(head || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(from) || !/^[0-9a-f]{40}$/.test(to) || from === to) return;
  const changed = diffNameSet(repoRoot, [from, to]);
  const local = diffNameSet(repoRoot, ['HEAD']);
  if (!changed || !local) return;
  const skipped = skipWorktreeSet(repoRoot);
  for (const rel of Array.from(dirty)) {
    const previous = (stamp.files && stamp.files[rel]) || (stamp.libraryFiles && stamp.libraryFiles[rel]) || '';
    const current = (files && files[rel]) || '';
    if (!previous || !current) continue;
    if (skipped.has(rel) || changed.has(rel) || local.has(rel)) continue;
    dirty.delete(rel);
  }
}

function fileStamp(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return '';
    return [st.size, st.mtimeMs, st.ctimeMs, st.ino].join('|');
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    return '';
  }
}

// 已入库且和工作区一致时用 blob。工作区改过或还没入库时用文件时间。文件不存在返回空串。扩展宿主调用。
function sourceStamp(repoRoot, rel, worktreeDirty) {
  const abs = path.join(repoRoot, rel);
  let st = null;
  try { st = fs.statSync(abs); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return '';
    throw err;
  }
  if (!st.isFile()) return '';
  const stat = [st.size, st.mtimeMs, st.ctimeMs, st.ino].join('|');
  if (worktreeDirty && worktreeDirty.has(rel)) return stat;
  const oid = indexBlobOid(repoRoot, rel);
  if (oid) return 'b:' + oid;
  return stat;
}

// 工作区相对索引改过的路径。检出后内容没变则是空集。扩展宿主调用。
function worktreeDirtySet(repoRoot) {
  const out = gitText(repoRoot, ['diff-files', '--name-only', '-z'], { allowFail: true });
  const set = new Set();
  String(out || '').split('\0').filter(Boolean).forEach((name) => set.add(slashRel(name)));
  return set;
}

function sourceSnapshot(repoRoot, stamp, isLibraryPath, topDirs) {
  const started = process.hrtime.bigint();
  // Enumerate names without Git's index/worktree comparison and clean filters.
  // Compare against the last build, since staging alone does not change inputs.
  const out = gitText(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const gitListMs = Number(process.hrtime.bigint() - started) / 1e6;
  const paths = new Set(out.split('\0').filter(Boolean).map(slashRel));
  Object.keys(stamp.files || {}).forEach((rel) => paths.add(rel));
  Object.keys(stamp.libraryFiles || {}).forEach((rel) => paths.add(rel));
  collectProjectRels(repoRoot).forEach((rel) => paths.add(rel));
  const tops = new Set(topDirs);
  const files = {};
  const libraryFiles = {};
  const dirty = new Set();
  const worktreeDirty = worktreeDirtySet(repoRoot);
  for (const rel of paths) {
    const library = isLibraryPath(rel);
    if (library) {
      if (!isSourceExt(rel)) continue;
    } else {
      const top = rel.split('/')[0];
      const wasCopied = Object.prototype.hasOwnProperty.call(stamp.files || {}, rel);
      const atRootSource = rel.indexOf('/') < 0 && isSourceExt(rel);
      if (!(wasCopied || tops.has(top) || atRootSource || rel.startsWith('Project/') || rel.startsWith('H750/Projects/MDK-ARM/'))) continue;
      if (skipSyncPath(rel)) continue;
    }
    const previous = library ? stamp.libraryFiles : stamp.files;
    const current = sourceStamp(repoRoot, rel, worktreeDirty);
    if (current) (library ? libraryFiles : files)[rel] = current;
    if (current !== ((previous && previous[rel]) || '')) dirty.add(rel);
  }
  return {
    files, libraryFiles, dirty, worktreeDirty, gitListMs,
    sourceScanMs: Number(process.hrtime.bigint() - started) / 1e6 - gitListMs
  };
}

function insideRepo(repoRoot, target) {
  if (!target) return '';
  const abs = path.resolve(repoRoot, target);
  const rel = path.relative(path.resolve(repoRoot), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return slashRel(rel);
}

function restoreSmudged(repoRoot, relDir) {
  const out = gitText(repoRoot, ['ls-files', '-z', '--', relDir], { allowFail: true });
  const files = String(out || '').split('\0').filter(Boolean);
  const chunk = 80;
  for (let i = 0; i < files.length; i += chunk) {
    git(repoRoot, ['checkout-index', '-f', '--'].concat(files.slice(i, i + chunk)), { allowFail: true });
  }
}

// 编烧树里若有指回真源的符号链接，写文件会穿透，把 GBK 盖掉工作区 UTF-8。
function ensureRealParent(repoRoot, kn, rel) {
  const parts = slashRel(rel).split('/');
  let cur = kn;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    let st = null;
    try { st = fs.lstatSync(cur); } catch (_) { st = null; }
    if (st && st.isSymbolicLink()) {
      let target = '';
      try { target = fs.readlinkSync(cur); } catch (_) { target = ''; }
      const inside = insideRepo(repoRoot, target);
      try { fs.unlinkSync(cur); } catch (_) { fs.rmdirSync(cur); }
      fs.mkdirSync(cur);
      if (inside) restoreSmudged(repoRoot, inside);
      st = null;
    }
    if (!st) fs.mkdirSync(cur, { recursive: true });
  }
}

function writeSourceOrCopy(repoRoot, kn, table, rel, isLibraryPath) {
  ensureRealParent(repoRoot, kn, rel);
  const src = path.join(repoRoot, rel);
  const dst = path.join(kn, rel);
  if (isSourceExt(rel)) {
    const wt = fs.readFileSync(src);
    // 未入表的新文件按当前编码登记，编译树保留原字节。
    const bytes = clean(rel, wt, table, repoRoot, isLibraryPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, bytes);
    try {
      const s = fs.statSync(src);
      fs.utimesSync(dst, s.atime, s.mtime);
    } catch (_) { /* ignore */ }
  } else {
    copyFile(src, dst);
  }
}

// 换树之后目标文件的时间都变了。只写了其中几个时，其余也记下新时间，否则下次同提交会整批重写。无返回值。扩展宿主线程调用。
function refreshRestoredTargets(kn, nextStamp) {
  Object.keys(nextStamp.files || {}).forEach((rel) => {
    const cur = fileStamp(path.join(kn, rel));
    if (cur) nextStamp.targets[rel] = cur;
  });
}

function syncOne(repoRoot, kn, table, stamp, nextStamp, rel, full, dirty, isLibraryPath, worktreeDirty) {
  if (skipSyncPath(rel)) return 'skipped';
  // 库由 junction 统一挂载：绝不逐文件拷贝/删除（否则会写进 junction 目标即真实仓库，或把 junction 内容删空）。
  if (isLibraryPath(rel)) return 'skipped';
  const src = path.join(repoRoot, rel);
  const dst = path.join(kn, rel);
  const st = sourceStamp(repoRoot, rel, worktreeDirty);
  if (!st) {
    delete nextStamp.files[rel];
    delete nextStamp.targets[rel];
    if (nextStamp.kinds) delete nextStamp.kinds[rel];
    try { if (fs.existsSync(dst) && fs.statSync(dst).isFile()) fs.unlinkSync(dst); } catch (_) { /* ignore */ }
    return 'pruned';
  }
  nextStamp.files[rel] = st;
  const unchanged = !full && !dirty.has(rel) && stamp.files && stamp.files[rel] === st && fs.existsSync(dst);
  if (unchanged) {
    nextStamp.targets[rel] = stamp.targets[rel];
    return 'skipped';
  }
  writeSourceOrCopy(repoRoot, kn, table, rel, isLibraryPath);
  // clean 会把识别出的编码写回这份 table。拷贝前 table 还是空的，提前记会变成空串，下次同步就把没改过的文件当成编码变了。
  if (nextStamp.kinds) nextStamp.kinds[rel] = table[rel] || '';
  nextStamp.targets[rel] = fileStamp(dst);
  return 'written';
}

function collectProjectRels(repoRoot) {
  const files = [];
  if (fs.existsSync(path.join(repoRoot, 'Project'))) walkProjectFiles(repoRoot, 'Project', files);
  if (fs.existsSync(path.join(repoRoot, 'H750', 'Projects', 'MDK-ARM'))) {
    walkProjectFiles(repoRoot, 'H750/Projects/MDK-ARM', files);
  }
  return files;
}

function pruneMissing(repoRoot, kn, relDir) {
  const abs = path.join(kn, relDir);
  let st = null;
  try { st = fs.lstatSync(abs); } catch (_) { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return 0;
  let n = 0;
  let ents = [];
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return 0; }
  for (let i = 0; i < ents.length; i++) {
    const name = ents[i].name;
    const rel = relDir ? relDir + '/' + name : name;
    const child = path.join(abs, name);
    let cst = null;
    try { cst = fs.lstatSync(child); } catch (_) { continue; }
    if (cst.isSymbolicLink()) continue;
    if (cst.isDirectory()) {
      n += pruneMissing(repoRoot, kn, rel);
      continue;
    }
    if (!cst.isFile()) continue;
    if (fs.existsSync(path.join(repoRoot, rel))) continue;
    try { fs.unlinkSync(child); n += 1; } catch (_) { /* ignore */ }
  }
  return n;
}

function syncKeilTree(repoRoot, emit) {
  const perfStart = process.hrtime.bigint();
  const log = (m) => { if (emit) emit(m); };
  const kn = keilNativeRoot(repoRoot);
  fs.mkdirSync(kn, { recursive: true });
  // 等编码表刷新结束再读。读到旧表时，每个缺表文件都会再去问一次原来的 blob。
  const tableLock = acquireLock(repoRoot, 'encoding-table');
  let table;
  try {
    table = loadTable(repoRoot);
  } finally {
    releaseLock(tableLock);
  }
  const isLibraryPath = createLibMatcher(repoRoot, true);
  const libraryTops = libTops(repoRoot);
  const libraries = [libTopNames(repoRoot).sort(), libraryTops.slice().sort()];
  const readyFile = path.join(kn, SYNC_READY_FILE);
  let stamp = readJson(keilStampPath(repoRoot), { files: {} });
  const head = currentHead(repoRoot);
  const branch = currentBranch(repoRoot);
  let restored = false;
  try {
    const swapped = swapKeilCache(repoRoot, kn, stamp, head);
    if (swapped) {
      stamp = swapped;
      writeJson(keilStampPath(repoRoot), stamp);
      restored = true;
    }
  } catch (_) { /* 留不下缓存就按当前这棵树继续 */ }
  if (!fs.existsSync(kn)) fs.mkdirSync(kn, { recursive: true });
  const topDirs = listTopDirs(repoRoot, libraryTops);
  const snapshot = sourceSnapshot(repoRoot, stamp, isLibraryPath, topDirs);
  const dirty = snapshot.dirty;
  const worktreeDirty = snapshot.worktreeDirty;
  // 换分支只让 mtime 变了的文件变脏。整棵重写留给戳版本、缺清单这种结构破坏。
  const full = stamp.version !== SYNC_VERSION || stamp.complete !== true
    || !fs.existsSync(readyFile) || !stamp.files || !stamp.targets;
  if (!full) relaxUnchangedBlobs(repoRoot, stamp, head, dirty, Object.assign({}, snapshot.libraryFiles, snapshot.files));
  if (!full && restored && commitOid(stamp.head) === commitOid(head)) dropCleanWorktree(repoRoot, stamp, dirty, kn);
  // 检出后的编码表可能还在写。目录比对期间等它落盘，再拿这份表，避免每个缺表文件单独去读 blob。
  table = loadSettledTable(repoRoot, head);
  if (!full && stamp.kinds) {
    for (const rel of Object.keys(stamp.files)) {
      if ((stamp.kinds[rel] || '') !== (table[rel] || '')) dirty.add(rel);
    }
  }
  const targetCheckStart = process.hrtime.bigint();
  // Check targets as well as sources: build tools can overwrite copied inputs.
  if (!full) {
    for (const rel of Object.keys(stamp.files || {})) {
      if (isLibraryPath(rel)) continue;
      const current = fileStamp(path.join(kn, rel));
      if (!current) dirty.add(rel);
      else if (current !== stamp.targets[rel] && !restored) dirty.add(rel);
    }
  }
  const timings = {
    gitListMs: snapshot.gitListMs, sourceScanMs: snapshot.sourceScanMs,
    targetCheckMs: Number(process.hrtime.bigint() - targetCheckStart) / 1e6
  };
  // 换上来的树里，库和时间戳目录不会重写。留在 dirty 里会挡住整棵命中。
  if (restored) {
    for (const rel of Array.from(dirty)) {
      if (isLibraryPath(rel) || skipSyncPath(rel)) dirty.delete(rel);
    }
  }
  const clean = !full && dirty.size === 0;

  let junctioned = 0;
  if (!clean) {
    try { fs.unlinkSync(readyFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const top of libraryTops) {
    const src = path.join(repoRoot, top);
    const dst = path.join(kn, top);
    if (!fs.existsSync(src)) continue;
    if (isReparse(dst)) { junctioned += 1; continue; }
    if (fs.existsSync(dst)) {
      // 旧版把库拷成真实目录、或 prune 后残留空目录，会永久挡住 junction。
      // 删掉真实目录、重建 junction，令 copy→junction 的迁移自愈。
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    ensureJunction(dst, src);
    junctioned += 1;
  }

  // Matching source and target snapshots permit the fast path.
  if (clean && stamp.complete === true && fs.existsSync(readyFile)) {
    let stampMoved = false;
    if (stamp.head !== head || stamp.branch !== branch) {
      stamp.head = head;
      stamp.branch = branch;
      stampMoved = true;
    }
    Object.keys(snapshot.files).forEach((rel) => {
      if (!stamp.files || !stamp.files[rel] || stamp.files[rel] === snapshot.files[rel]) return;
      stamp.files[rel] = snapshot.files[rel];
      stampMoved = true;
    });
    if (restored && stamp.targets) {
      Object.keys(stamp.targets).forEach((rel) => {
        const cur = fileStamp(path.join(kn, rel));
        if (!cur || cur === stamp.targets[rel]) return;
        stamp.targets[rel] = cur;
        stampMoved = true;
      });
    }
    if (stampMoved) writeJson(keilStampPath(repoRoot), stamp);
    const skippedAll = Object.keys(stamp.files || {}).length;
    const msg = 'keil-native synced: cache hit, skip ' + skippedAll + ', junction ' + junctioned;
    log(msg);
    recordPerf(repoRoot, 'zkz-native.syncKeilTree', {
      ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
      written: 0,
      skipped: skippedAll,
      pruned: 0,
      junctioned: junctioned,
      dirty: dirty.size,
      full: false,
      cacheHit: true,
      treeCacheHit: restored,
      ...timings
    });
    return {
      written: 0,
      skipped: skippedAll,
      pruned: 0,
      junctioned: junctioned,
      root: kn,
      libWarnings: loadLibWarnings(repoRoot),
      cacheHit: true,
      timings
    };
  }

  try { fs.unlinkSync(readyFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const nextStamp = {
    version: SYNC_VERSION, head: head, branch: branch, files: {}, targets: {}, kinds: {},
    libraryFiles: snapshot.libraryFiles
  };
  const incremental = !full && dirty.size > 0;
  if (incremental && stamp.files) {
    Object.keys(stamp.files).forEach((rel) => { nextStamp.files[rel] = stamp.files[rel]; });
    Object.assign(nextStamp.targets, stamp.targets);
    if (stamp.kinds) Object.assign(nextStamp.kinds, stamp.kinds);
    Object.keys(snapshot.files).forEach((rel) => {
      if (!dirty.has(rel) && snapshot.files[rel]) nextStamp.files[rel] = snapshot.files[rel];
    });
  }
  let written = 0;
  let skipped = 0;
  let pruned = 0;

  const tally = (kind) => {
    if (kind === 'written') written += 1;
    else if (kind === 'skipped') skipped += 1;
    else if (kind === 'pruned') pruned += 1;
  };

  setNoteDefer(true);
  try {
    if (incremental) {
      // Reuse entries whose current metadata matches the previous build.
      for (const rel of dirty) {
        tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, false, dirty, isLibraryPath, worktreeDirty));
      }
    } else if (clean && stamp.files) {
      const rels = new Set(Object.keys(stamp.files));
      collectProjectRels(repoRoot).forEach((rel) => rels.add(rel));
      for (const rel of rels) {
        tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, false, dirty, isLibraryPath, worktreeDirty));
      }
    } else {
      const rels = new Set(Object.keys(snapshot.files));
      collectProjectRels(repoRoot).forEach((rel) => rels.add(rel));
      for (const rel of rels) {
        tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, full, dirty, isLibraryPath, worktreeDirty));
      }
    }
  } finally {
    try { flushDeferredNotes(); } finally { setNoteDefer(false); }
  }

  if (stamp.files) {
    for (const rel of Object.keys(stamp.files)) {
      if (nextStamp.files[rel]) continue;
      // 增量同步已按 dirty 路径处理删除；其它路径可继续保留。
      if (incremental) continue;
      // 库路径由 junction 管理，绝不 prune（历史 stamp 里若残留库条目，prune 会把 junction/目录内容删空）。
      if (isLibraryPath(rel)) continue;
      const dst = path.join(kn, rel);
      try {
        if (fs.existsSync(dst) && fs.statSync(dst).isFile()) {
          fs.unlinkSync(dst);
          pruned += 1;
        }
      } catch (_) { /* ignore */ }
    }
  }

  let removed = 0;
  if (!incremental) {
    for (const top of topDirs) {
      removed += pruneMissing(repoRoot, kn, top);
    }
  }
  pruned += removed;

  if (restored) refreshRestoredTargets(kn, nextStamp);
  nextStamp.complete = true;
  nextStamp.fingerprint = syncFingerprint(table, libraries);
  const libDirty = [];
  dirty.forEach((rel) => {
    if (isSourceExt(rel) && isLibraryPath(rel)) libDirty.push(rel);
  });
  let libWarnings = [];
  try {
    const checked = new Set(libDirty);
    const previous = loadLibWarnings(repoRoot).filter((item) => snapshot.libraryFiles[item.rel] && !checked.has(item.rel));
    libWarnings = previous.concat(inspectLibEncoding(repoRoot, libDirty, { mode: 'worktree', persist: false }));
    saveLibWarnings(repoRoot, libWarnings);
  } catch (e) {
    // Keep the previous library metadata so a failed check is retried.
    nextStamp.libraryFiles = stamp.libraryFiles || {};
    libWarnings = loadLibWarnings(repoRoot);
    log('lib encoding inspect failed: ' + String(e && e.message ? e.message : e));
  }
  if (libWarnings.length) {
    log('lib encoding warnings: ' + libWarnings.length);
    libWarnings.forEach((it) => log('  ' + formatLibWarning(it)));
  }
  writeJson(keilStampPath(repoRoot), nextStamp);
  try { fs.writeFileSync(readyFile, String(Date.now()) + '\n', 'utf8'); } catch (_) { /* cache marker is optional */ }
  const msg = 'keil-native synced: write ' + written + ', skip ' + skipped +
    ', prune ' + pruned + ', junction ' + junctioned;
  log(msg);
  recordPerf(repoRoot, 'zkz-native.syncKeilTree', {
    ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
    written: written,
    skipped: skipped,
    pruned: pruned,
    junctioned: junctioned,
    dirty: dirty.size,
    full: full,
    incremental: incremental,
    ...timings
  });
  return {
    written: written,
    skipped: skipped,
    pruned: pruned,
    junctioned: junctioned,
    root: kn,
    libWarnings: libWarnings,
    timings
  };
}

module.exports = {
  syncKeilTree,
  keilNativeRoot,
  ensureRealParent,
  pruneMissing,
  writeSourceOrCopy
};
