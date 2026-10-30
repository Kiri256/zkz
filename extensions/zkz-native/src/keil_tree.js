'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clean } = require('./filter_core');
const { loadTable, setNoteDefer, flushDeferredNotes } = require('./enc_table');
const {
  slashRel, keilNativeRoot, keilStampPath, isSourceExt,
  DEFAULT_SKIP_DIR, libTops, libTopNames, createLibMatcher, isReparse, atomicWriteJson
} = require('./paths');
const { currentHead, currentBranch, gitText, git, indexBlobOid, indexBlobFingerprint, indexIdentity, catFileBatchSync } = require('./git_exec');
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

function keilCacheRoot(repoRoot) {
  return path.join(path.dirname(keilStampPath(repoRoot)), 'keil-cache');
}

function keilCacheSlot(repoRoot, oid) {
  return path.join(keilCacheRoot(repoRoot), oid);
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

function cachedStamp(repoRoot, oid) {
  return readJson(path.join(keilCacheSlot(repoRoot, oid), 'stamp.json'), null);
}

function fullTreeReady(repoRoot, oid) {
  const cached = cachedStamp(repoRoot, oid);
  if (!cached || cached.complete !== true || cached.version !== SYNC_VERSION) return false;
  // 整棵 tree 在，就按树换。戳上残留的 manifest 不能把这份树丢掉。
  return fs.existsSync(path.join(keilCacheSlot(repoRoot, oid), 'tree', SYNC_READY_FILE));
}

function manifestReady(repoRoot, oid) {
  const cached = cachedStamp(repoRoot, oid);
  return !!(cached && cached.manifest === true && cached.complete === true && cached.version === SYNC_VERSION);
}

function cacheFile(root, rel) {
  return path.join(root, ...slashRel(rel).split('/'));
}

// 不是 git blob 的编烧副本才需要另存。blob 以后用 git 取回。扩展宿主调用。
function parkKeilManifest(repoRoot, oid, kn, stamp, pin, isLibraryPath) {
  const slot = keilCacheSlot(repoRoot, oid);
  const tmp = slot + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const extras = [];
  try {
    Object.keys(stamp.files || {}).forEach((rel) => {
      if (blobStamp(stamp.files[rel]) || skipSyncPath(rel) || isLibraryPath(rel)) return;
      const src = cacheFile(kn, rel);
      let st = null;
      try { st = fs.statSync(src); } catch (_) { return; }
      if (!st.isFile()) return;
      const dst = cacheFile(path.join(tmp, 'extra'), rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      extras.push(rel);
    });
    writeJson(path.join(tmp, 'stamp.json'), Object.assign({}, stamp, { manifest: true, extras: extras }));
    fs.rmSync(slot, { recursive: true, force: true });
    fs.renameSync(tmp, slot);
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw err;
  }
  rememberKeilOrder(repoRoot, oid, pin);
}

function writeKeilBytes(repoRoot, kn, rel, bytes) {
  ensureRealParent(repoRoot, kn, rel);
  const dst = cacheFile(kn, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, bytes);
}

// 按清单把编烧树补成那个提交。相同的戳留着，变了的从 git 或 extra 取。成功返回清单。扩展宿主调用。
function applyKeilManifest(repoRoot, kn, fromStamp, oid, isLibraryPath) {
  const slot = keilCacheSlot(repoRoot, oid);
  const cached = cachedStamp(repoRoot, oid);
  if (!cached || cached.manifest !== true || cached.complete !== true || cached.version !== SYNC_VERSION) return null;
  const fromFiles = (fromStamp && fromStamp.files) || {};
  const toFiles = cached.files || {};
  Object.keys(fromFiles).forEach((rel) => {
    if (toFiles[rel] || skipSyncPath(rel) || isLibraryPath(rel)) return;
    const dst = cacheFile(kn, rel);
    try {
      if (fs.existsSync(dst) && fs.statSync(dst).isFile()) fs.unlinkSync(dst);
    } catch (_) { /* ignore */ }
  });
  const jobs = [];
  const copies = [];
  Object.keys(toFiles).forEach((rel) => {
    if (skipSyncPath(rel) || isLibraryPath(rel)) return;
    if (fromFiles[rel] && fromFiles[rel] === toFiles[rel]) {
      try {
        if (fs.statSync(cacheFile(kn, rel)).isFile()) return;
      } catch (_) { /* 目标不是文件，按缺失重新取出 */ }
    }
    if (blobStamp(toFiles[rel])) jobs.push({ rel: rel, oid: toFiles[rel].slice(2) });
    else copies.push(rel);
  });
  if (jobs.length) {
    const recs = catFileBatchSync(repoRoot, jobs.map((job) => job.oid));
    for (let i = 0; i < jobs.length; i++) {
      const rec = recs[i];
      if (!rec || rec.missing) return null;
      writeKeilBytes(repoRoot, kn, jobs[i].rel, rec.data);
    }
  }
  for (let i = 0; i < copies.length; i++) {
    const rel = copies[i];
    const src = cacheFile(path.join(slot, 'extra'), rel);
    if (!fs.existsSync(src)) continue;
    writeKeilBytes(repoRoot, kn, rel, fs.readFileSync(src));
  }
  return cached;
}

function parkKeilRename(repoRoot, oid, kn, stamp, pin) {
  const slot = keilCacheSlot(repoRoot, oid);
  fs.rmSync(slot, { recursive: true, force: true });
  fs.mkdirSync(slot, { recursive: true });
  fs.renameSync(kn, path.join(slot, 'tree'));
  // 整棵树自己就是正文。清掉清单标记，避免下次把 tree 当成没有副本的清单。
  const parked = Object.assign({}, stamp);
  delete parked.manifest;
  delete parked.extras;
  writeJson(path.join(slot, 'stamp.json'), parked);
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

// 换提交时留下清单。旧的整棵缓存仍改名换上。没有清单就只存非 blob 文件，当前树按差异改。返回换上的清单。扩展宿主调用。
function swapKeilCache(repoRoot, kn, stamp, head, isLibraryPath) {
  const fromOid = commitOid(stamp && stamp.head);
  const toOid = commitOid(head);
  if (!fromOid || !toOid || fromOid === toOid) return null;
  if (!stamp || stamp.complete !== true || stamp.version !== SYNC_VERSION) return null;
  if (!fs.existsSync(path.join(kn, SYNC_READY_FILE))) return null;
  const library = isLibraryPath || function () { return false; };
  if (fullTreeReady(repoRoot, toOid)) {
    parkKeilRename(repoRoot, fromOid, kn, stamp, toOid);
    try {
      const taken = takeKeilCache(repoRoot, toOid, kn);
      if (taken) return taken;
    } catch (_) { /* 换不上就把刚挪走的树搬回来 */ }
    const parked = path.join(keilCacheSlot(repoRoot, fromOid), 'tree');
    if (!fs.existsSync(kn) && fs.existsSync(parked)) fs.renameSync(parked, kn);
    return null;
  }
  parkKeilManifest(repoRoot, fromOid, kn, stamp, toOid, library);
  if (!manifestReady(repoRoot, toOid)) return null;
  return applyKeilManifest(repoRoot, kn, stamp, toOid, library);
}

// 内容已经对上索引时，把时间戳改回 blob。索引里没有这个路径则不动。无返回值。扩展宿主调用。
function rememberBlob(repoRoot, rel, files, libraryFiles) {
  const oid = indexBlobOid(repoRoot, rel);
  if (!oid) return;
  const blob = 'b:' + oid;
  if (files && Object.prototype.hasOwnProperty.call(files, rel)) files[rel] = blob;
  if (libraryFiles && Object.prototype.hasOwnProperty.call(libraryFiles, rel)) libraryFiles[rel] = blob;
}

function dropCleanWorktree(repoRoot, stamp, dirty, kn, files, libraryFiles) {
  const local = diffNameSet(repoRoot, ['HEAD']);
  if (!local) return;
  const skipped = skipWorktreeSet(repoRoot);
  for (const rel of Array.from(dirty)) {
    const previous = (stamp.files && stamp.files[rel]) || '';
    if (!previous) continue;
    if (skipped.has(rel) || local.has(rel)) continue;
    if (!fs.existsSync(path.join(kn, rel))) continue;
    dirty.delete(rel);
    rememberBlob(repoRoot, rel, files, libraryFiles);
  }
}

// 检出只改了时间戳、内容仍等于提交时，从脏集合拿掉，并把源戳改回 blob。无返回值。扩展宿主调用。
function relaxUnchangedBlobs(repoRoot, stamp, head, dirty, files, libraryFiles) {
  const from = String(stamp.head || '').trim().toLowerCase();
  const to = String(head || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(from) || !/^[0-9a-f]{40}$/.test(to) || from === to) return;
  const changed = diffNameSet(repoRoot, [from, to]);
  const local = diffNameSet(repoRoot, ['HEAD']);
  if (!changed || !local) return;
  const skipped = skipWorktreeSet(repoRoot);
  for (const rel of Array.from(dirty)) {
    const previous = (stamp.files && stamp.files[rel]) || (stamp.libraryFiles && stamp.libraryFiles[rel]) || '';
    const current = (files && files[rel]) || (libraryFiles && libraryFiles[rel]) || '';
    if (!previous || !current) continue;
    if (skipped.has(rel) || changed.has(rel) || local.has(rel)) continue;
    dirty.delete(rel);
    rememberBlob(repoRoot, rel, files, libraryFiles);
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

// 已入库且和工作区一致时用 blob。工作区改过、问不到工作区、skip-worktree 或还没入库时用文件时间。文件不存在返回空串。扩展宿主调用。
function sourceStamp(repoRoot, rel, worktreeDirty, forceStat) {
  const abs = path.join(repoRoot, rel);
  let st = null;
  try { st = fs.statSync(abs); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return '';
    throw err;
  }
  if (!st.isFile()) return '';
  const stat = [st.size, st.mtimeMs, st.ctimeMs, st.ino].join('|');
  // worktreeDirty 为 null 表示 git 没问成，不能当成没改过。
  if (forceStat || !worktreeDirty || worktreeDirty.has(rel)) return stat;
  const oid = indexBlobOid(repoRoot, rel);
  if (oid) return 'b:' + oid;
  return stat;
}

function blobStamp(value) {
  return typeof value === 'string' && value.indexOf('b:') === 0;
}

function sameStringList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 这条路径要不要进编烧树。库只收源文件。返回是否收录。扩展宿主调用。
function acceptSyncedRel(rel, stamp, isLibraryPath, tops) {
  if (isLibraryPath(rel)) return isSourceExt(rel);
  const top = rel.split('/')[0];
  const wasCopied = Object.prototype.hasOwnProperty.call(stamp.files || {}, rel);
  const atRootSource = rel.indexOf('/') < 0 && isSourceExt(rel);
  if (!(wasCopied || tops.has(top) || atRootSource || rel.startsWith('Project/') || rel.startsWith('H750/Projects/MDK-ARM/'))) return false;
  return !skipSyncPath(rel);
}

// 索引里 skip-worktree 的路径，已排序。git 失败返回 null。扩展宿主调用。
function listSkipped(repoRoot) {
  const r = git(repoRoot, ['ls-files', '-v', '-z'], { allowFail: true });
  if (!r || r.status !== 0) return null;
  const list = [];
  String(r.stdout || '').split('\0').filter(Boolean).forEach((rec) => {
    if (rec.charAt(0) !== 'S' && rec.charAt(0) !== 's') return;
    const name = rec.charAt(1) === ' ' ? rec.slice(2) : rec.slice(1);
    if (name) list.push(slashRel(name));
  });
  list.sort();
  return list;
}

// 一次列出工作区改动和未跟踪文件。只看相对索引的工作区列，已暂存但工作区一致的不在这里。git 失败返回 null。扩展宿主调用。
function listWorktreeChanges(repoRoot) {
  const started = process.hrtime.bigint();
  const r = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { allowFail: true });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (!r || r.status !== 0) return null;
  const dirty = new Set();
  const untracked = [];
  String(r.stdout || '').split('\0').forEach((rec) => {
    if (rec.length < 4) return;
    const x = rec.charAt(0);
    const y = rec.charAt(1);
    const name = rec.charAt(2) === ' ' ? rec.slice(3) : rec.slice(2);
    if (!name) return;
    const rel = slashRel(name);
    if (x === '?' && y === '?') untracked.push(rel);
    else if (y !== ' ') dirty.add(rel);
  });
  return { dirty: dirty, untracked: untracked, ms: ms };
}

// 供还没问过工作区的扫描使用。git 失败返回 null。扩展宿主调用。
function worktreeDirtySet(repoRoot) {
  const listed = listWorktreeChanges(repoRoot);
  return listed ? listed.dirty : null;
}

function noteSource(rel, current, previous, library, files, libraryFiles, dirty) {
  if (current) (library ? libraryFiles : files)[rel] = current;
  if (current !== ((previous && previous[rel]) || '')) dirty.add(rel);
}

// 已跟踪且没被点名的文件沿用 blob 戳。点名的改动、未跟踪、skip-worktree 和项目辅助文件仍读取。返回和全量扫描相同的快照。扩展宿主调用。
function reuseSourceSnapshot(repoRoot, stamp, isLibraryPath, topDirs, worktreeDirty, index, indexBlobs, untracked, gitListMs) {
  const started = process.hrtime.bigint();
  const tops = new Set(topDirs);
  const skipped = new Set(stamp.skipped || []);
  const files = {};
  const libraryFiles = {};
  const dirty = new Set();
  const paths = new Set();
  const named = worktreeDirty || new Set();
  const keep = (rel, stored) => blobStamp(stored) && !skipped.has(rel) && !named.has(rel);
  Object.keys(stamp.files || {}).forEach((rel) => {
    if (!isLibraryPath(rel) && keep(rel, stamp.files[rel])) files[rel] = stamp.files[rel];
    else paths.add(rel);
  });
  Object.keys(stamp.libraryFiles || {}).forEach((rel) => {
    if (isLibraryPath(rel) && keep(rel, stamp.libraryFiles[rel])) libraryFiles[rel] = stamp.libraryFiles[rel];
    else paths.add(rel);
  });
  named.forEach((rel) => paths.add(rel));
  (untracked || []).forEach((rel) => paths.add(rel));
  collectProjectRels(repoRoot).forEach((rel) => {
    if (!files[rel]) paths.add(rel);
  });
  for (const rel of paths) {
    if (!acceptSyncedRel(rel, stamp, isLibraryPath, tops)) continue;
    const library = isLibraryPath(rel);
    const previous = library ? stamp.libraryFiles : stamp.files;
    const current = sourceStamp(repoRoot, rel, worktreeDirty, skipped.has(rel));
    noteSource(rel, current, previous, library, files, libraryFiles, dirty);
  }
  return {
    files: files, libraryFiles: libraryFiles, dirty: dirty, worktreeDirty: worktreeDirty,
    gitListMs: gitListMs || 0,
    sourceScanMs: Number(process.hrtime.bigint() - started) / 1e6,
    index: index, indexBlobs: indexBlobs || '', skipped: stamp.skipped.slice(), sourceReuse: true
  };
}

function sourceSnapshot(repoRoot, stamp, isLibraryPath, topDirs, opts) {
  const opt = opts || {};
  if (opt.reuse) {
    return reuseSourceSnapshot(repoRoot, stamp, isLibraryPath, topDirs, opt.worktreeDirty, opt.index, opt.indexBlobs, opt.untracked, opt.gitListMs);
  }
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
  const worktreeDirty = (opt.worktreeDirty instanceof Set || opt.worktreeDirty === null)
    ? opt.worktreeDirty
    : worktreeDirtySet(repoRoot);
  const skippedList = listSkipped(repoRoot);
  const skipped = new Set(skippedList || []);
  for (const rel of paths) {
    if (!acceptSyncedRel(rel, stamp, isLibraryPath, tops)) continue;
    const library = isLibraryPath(rel);
    const previous = library ? stamp.libraryFiles : stamp.files;
    const current = sourceStamp(repoRoot, rel, worktreeDirty, skipped.has(rel));
    noteSource(rel, current, previous, library, files, libraryFiles, dirty);
  }
  return {
    files: files, libraryFiles: libraryFiles, dirty: dirty, worktreeDirty: worktreeDirty, gitListMs: gitListMs,
    sourceScanMs: Number(process.hrtime.bigint() - started) / 1e6 - gitListMs,
    index: opt.index || indexIdentity(repoRoot), indexBlobs: indexBlobFingerprint(repoRoot) || '',
    skipped: skippedList, sourceReuse: false
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

function syncOne(repoRoot, kn, table, stamp, nextStamp, rel, full, dirty, isLibraryPath, worktreeDirty, skipped) {
  if (skipSyncPath(rel)) return 'skipped';
  // 库由 junction 统一挂载：绝不逐文件拷贝/删除（否则会写进 junction 目标即真实仓库，或把 junction 内容删空）。
  // 原先抄进 files 的路径改成库之后，从文件戳里拿掉，下次不再当库时才会重新写出并拆掉 junction。
  if (isLibraryPath(rel)) {
    delete nextStamp.files[rel];
    delete nextStamp.targets[rel];
    if (nextStamp.kinds) delete nextStamp.kinds[rel];
    return 'skipped';
  }
  const src = path.join(repoRoot, rel);
  const dst = path.join(kn, rel);
  const st = sourceStamp(repoRoot, rel, worktreeDirty, skipped && skipped.has(rel));
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
  // 换分支时同步命令先写好编码表。这里只读一次，不再空等。
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
    const swapped = swapKeilCache(repoRoot, kn, stamp, head, isLibraryPath);
    if (swapped) {
      stamp = swapped;
      writeJson(keilStampPath(repoRoot), stamp);
      restored = true;
    }
  } catch (_) { /* 留不下缓存就按当前这棵树继续 */ }
  if (!fs.existsSync(kn)) fs.mkdirSync(kn, { recursive: true });
  const topDirs = listTopDirs(repoRoot, libraryTops);
  // 换分支只让 mtime 变了的文件变脏。整棵重写留给戳版本、缺清单这种结构破坏。
  const full = stamp.version !== SYNC_VERSION || stamp.complete !== true
    || !fs.existsSync(readyFile) || !stamp.files || !stamp.targets;
  // 先问工作区，再记索引戳。blob 没变时，点名的改动单独重写，其余已跟踪文件沿用戳。
  const listed = listWorktreeChanges(repoRoot);
  const knownDirty = listed ? listed.dirty : null;
  const indexNow = indexIdentity(repoRoot);
  const trackedSame = !full && !!knownDirty && Array.isArray(stamp.skipped)
    && commitOid(stamp.head) === commitOid(head);
  let reuse = trackedSame && !!stamp.index && stamp.index === indexNow;
  let indexBlobs = '';
  if (trackedSame && stamp.indexBlobs && !reuse) {
    indexBlobs = indexBlobFingerprint(repoRoot);
    reuse = !!indexBlobs && indexBlobs === stamp.indexBlobs;
  } else if (reuse && !stamp.indexBlobs) {
    indexBlobs = indexBlobFingerprint(repoRoot);
  } else if (reuse) {
    indexBlobs = stamp.indexBlobs;
  }
  const snapshot = sourceSnapshot(repoRoot, stamp, isLibraryPath, topDirs, {
    reuse: reuse, worktreeDirty: knownDirty, untracked: listed && listed.untracked,
    gitListMs: listed && listed.ms, index: indexNow, indexBlobs: indexBlobs
  });
  const dirty = snapshot.dirty;
  const worktreeDirty = snapshot.worktreeDirty;
  const skippedSet = new Set(snapshot.skipped || []);
  if (!full) relaxUnchangedBlobs(repoRoot, stamp, head, dirty, snapshot.files, snapshot.libraryFiles);
  // 清单换上时，非 blob 的副本可能和工作区不一致，不能因为工作区干净就跳过重写。
  if (!full && restored && !stamp.manifest && commitOid(stamp.head) === commitOid(head)) {
    dropCleanWorktree(repoRoot, stamp, dirty, kn, snapshot.files, snapshot.libraryFiles);
  }
  // git diff 会刷新同秒写入的索引。戳记刷新之后的，下次同提交才能沿用。
  const indexSettled = indexIdentity(repoRoot);
  if (indexSettled) snapshot.index = indexSettled;
  if (!full && stamp.kinds) {
    for (const rel of Object.keys(stamp.files)) {
      if ((stamp.kinds[rel] || '') !== (table[rel] || '')) dirty.add(rel);
    }
  }
  const targetCheckStart = process.hrtime.bigint();
  // 编烧副本被外部盖过就要重写。换树命中时这一遍记下新时间，不再扫第二遍。
  const refreshedTargets = {};
  if (!full) {
    for (const rel of Object.keys(stamp.files || {})) {
      if (isLibraryPath(rel)) continue;
      const current = fileStamp(path.join(kn, rel));
      if (!current) dirty.add(rel);
      else if (current !== stamp.targets[rel]) {
        if (restored) refreshedTargets[rel] = current;
        else dirty.add(rel);
      }
    }
  }
  const timings = {
    gitListMs: snapshot.gitListMs, sourceScanMs: snapshot.sourceScanMs,
    targetCheckMs: Number(process.hrtime.bigint() - targetCheckStart) / 1e6,
    sourceReuse: !!snapshot.sourceReuse
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
    Object.keys(refreshedTargets).forEach((rel) => {
      stamp.targets[rel] = refreshedTargets[rel];
      stampMoved = true;
    });
    if (snapshot.index && stamp.index !== snapshot.index) {
      stamp.index = snapshot.index;
      stampMoved = true;
    }
    if (snapshot.indexBlobs && stamp.indexBlobs !== snapshot.indexBlobs) {
      stamp.indexBlobs = snapshot.indexBlobs;
      stampMoved = true;
    }
    if (Array.isArray(snapshot.skipped) && !sameStringList(stamp.skipped, snapshot.skipped)) {
      stamp.skipped = snapshot.skipped;
      stampMoved = true;
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
      sourceReuse: !!snapshot.sourceReuse,
      timings
    };
  }

  try { fs.unlinkSync(readyFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const nextStamp = {
    version: SYNC_VERSION, head: head, branch: branch, files: {}, targets: {}, kinds: {},
    libraryFiles: snapshot.libraryFiles, index: snapshot.index || '', indexBlobs: snapshot.indexBlobs || ''
  };
  if (Array.isArray(snapshot.skipped)) nextStamp.skipped = snapshot.skipped;
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
        tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, false, dirty, isLibraryPath, worktreeDirty, skippedSet));
      }
    } else if (clean && stamp.files) {
      const rels = new Set(Object.keys(stamp.files));
      collectProjectRels(repoRoot).forEach((rel) => rels.add(rel));
      for (const rel of rels) {
        tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, false, dirty, isLibraryPath, worktreeDirty, skippedSet));
      }
    } else {
      const rels = new Set(Object.keys(snapshot.files));
      collectProjectRels(repoRoot).forEach((rel) => rels.add(rel));
      for (const rel of rels) {
        tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, full, dirty, isLibraryPath, worktreeDirty, skippedSet));
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
    sourceReuse: !!snapshot.sourceReuse,
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
