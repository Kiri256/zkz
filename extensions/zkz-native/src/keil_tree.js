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
const { currentHead, currentBranch, gitText, git, indexBlobOid, indexBlobFingerprint, indexIdentity } = require('./git_exec');
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

function commitOid(value) {
  const oid = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : '';
}

// 换提交的编烧树缓存已停用。同步时删掉残留，避免继续占磁盘。扩展宿主调用。
function removeKeilCache(repoRoot) {
  const dir = path.join(path.dirname(keilStampPath(repoRoot)), 'keil-cache');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 删不掉就留着，不再读取 */ }
}


// 内容已经对上索引时，把时间戳改回 blob。索引里没有这个路径则不动。无返回值。扩展宿主调用。
function rememberBlob(repoRoot, rel, files, libraryFiles) {
  const oid = indexBlobOid(repoRoot, rel);
  if (!oid) return;
  const blob = 'b:' + oid;
  if (files && Object.prototype.hasOwnProperty.call(files, rel)) files[rel] = blob;
  if (libraryFiles && Object.prototype.hasOwnProperty.call(libraryFiles, rel)) libraryFiles[rel] = blob;
}

// 上次已是 blob、这次提交也没改内容时，从脏集合拿掉。时间戳说明副本可能是未入库修改，检出丢掉后还要重写。无返回值。扩展宿主调用。
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
    if (!blobStamp(previous) || !blobStamp(current)) continue;
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

// 一次列出工作区改动和未跟踪文件。目录只记一行，需要时再展开。跳过的顶层目录不展开。git 失败返回 null。扩展宿主调用。
function listWorktreeChanges(repoRoot) {
  const started = process.hrtime.bigint();
  const r = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--no-renames'], { allowFail: true });
  if (!r || r.status !== 0) return null;
  const dirty = new Set();
  const untracked = [];
  const dirs = [];
  String(r.stdout || '').split('\0').forEach((rec) => {
    if (rec.length < 4) return;
    const x = rec.charAt(0);
    const y = rec.charAt(1);
    const name = rec.charAt(2) === ' ' ? rec.slice(3) : rec.slice(2);
    if (!name) return;
    const rel = slashRel(name);
    if (x === '?' && y === '?') {
      const top = rel.split('/')[0].replace(/\/$/, '');
      if (skipDirName(top)) return;
      if (rel.endsWith('/')) dirs.push(rel);
      else untracked.push(rel);
    } else if (y !== ' ') dirty.add(rel);
  });
  if (dirs.length) {
    const listed = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--'].concat(dirs), { allowFail: true });
    if (!listed || listed.status !== 0) {
      dirs.forEach((dir) => untracked.push(dir.replace(/\/$/, '')));
    } else {
      String(listed.stdout || '').split('\0').filter(Boolean).forEach((item) => {
        const rel = slashRel(item);
        if (!skipDirName(rel.split('/')[0])) untracked.push(rel);
      });
    }
  }
  return { dirty: dirty, untracked: untracked, ms: Number(process.hrtime.bigint() - started) / 1e6 };
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

// 被 Git 忽略的项目辅助文件不在 status 里。有新文件时不能走空闲快照。扩展宿主调用。
function missingProjectFile(repoRoot, stamp) {
  const projects = collectProjectRels(repoRoot);
  for (let i = 0; i < projects.length; i++) {
    if (!stamp.files || !stamp.files[projects[i]]) return true;
  }
  return false;
}

// 戳都是 blob、又没有点名改动时，源文件不用再扫。编烧副本仍由调用方逐个看。扩展宿主调用。
function idleSourceReady(stamp, isLibraryPath, skipped) {
  const files = stamp.files || {};
  for (const rel of Object.keys(files)) {
    if (isLibraryPath(rel) || !blobStamp(files[rel]) || skipped.has(rel)) return false;
  }
  const libs = stamp.libraryFiles || {};
  for (const rel of Object.keys(libs)) {
    if (!isLibraryPath(rel) || !blobStamp(libs[rel]) || skipped.has(rel)) return false;
  }
  return true;
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
  const extra = untracked || [];
  if (worktreeDirty instanceof Set && named.size === 0 && extra.length === 0 && idleSourceReady(stamp, isLibraryPath, skipped) && !missingProjectFile(repoRoot, stamp)) {
    return {
      files: Object.assign({}, stamp.files),
      libraryFiles: Object.assign({}, stamp.libraryFiles || {}),
      dirty: dirty,
      worktreeDirty: worktreeDirty,
      gitListMs: gitListMs || 0,
      sourceScanMs: Number(process.hrtime.bigint() - started) / 1e6,
      index: index,
      indexBlobs: indexBlobs || '',
      skipped: (stamp.skipped || []).slice(),
      sourceReuse: true
    };
  }
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
  removeKeilCache(repoRoot);
  const stamp = readJson(keilStampPath(repoRoot), { files: {} });
  const head = currentHead(repoRoot);
  const branch = currentBranch(repoRoot);
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
  // git diff 会刷新同秒写入的索引。戳记刷新之后的，下次同提交才能沿用。
  const indexSettled = indexIdentity(repoRoot);
  if (indexSettled) snapshot.index = indexSettled;
  if (!full && stamp.kinds) {
    for (const rel of Object.keys(stamp.files)) {
      if ((stamp.kinds[rel] || '') !== (table[rel] || '')) dirty.add(rel);
    }
  }
  const targetCheckStart = process.hrtime.bigint();
  // 编烧副本被外部盖过就要重写。
  if (!full) {
    for (const rel of Object.keys(stamp.files || {})) {
      if (isLibraryPath(rel)) continue;
      const current = fileStamp(path.join(kn, rel));
      if (!current || current !== stamp.targets[rel]) dirty.add(rel);
    }
  }
  const timings = {
    gitListMs: snapshot.gitListMs, sourceScanMs: snapshot.sourceScanMs,
    targetCheckMs: Number(process.hrtime.bigint() - targetCheckStart) / 1e6,
    sourceReuse: !!snapshot.sourceReuse
  };
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
