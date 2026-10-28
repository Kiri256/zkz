'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clean } = require('./filter_core');
const { loadTable } = require('./enc_table');
const {
  slashRel, keilNativeRoot, keilStampPath, isSourceExt,
  DEFAULT_SKIP_DIR, libTops, libTopNames, createLibMatcher, isReparse, atomicWriteJson
} = require('./paths');
const { currentHead, currentBranch, gitText, git } = require('./git_exec');
const { inspectLibEncoding, formatLibWarning, loadLibWarnings, saveLibWarnings } = require('./lib_encoding');
const { record: recordPerf } = require('../../shared/perf');

const BUSINESS_FALLBACK = ['User', 'core', 'driver', 'application', 'fpga_motion', 'emWin'];
const SKIP_DIR = new Set(DEFAULT_SKIP_DIR);
const PROJECT_KEEP_EXT = ['.sct', '.ini', '.scf'];
const SYNC_READY_FILE = '.zkz-sync-ready';
const SYNC_VERSION = 4;

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
    const current = fileStamp(path.join(repoRoot, rel));
    if (current) (library ? libraryFiles : files)[rel] = current;
    if (current !== ((previous && previous[rel]) || '')) dirty.add(rel);
  }
  return { files, libraryFiles, dirty, gitListMs,
    sourceScanMs: Number(process.hrtime.bigint() - started) / 1e6 - gitListMs };
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

function syncOne(repoRoot, kn, table, stamp, nextStamp, rel, full, dirty, isLibraryPath) {
  if (skipSyncPath(rel)) return 'skipped';
  // 库由 junction 统一挂载：绝不逐文件拷贝/删除（否则会写进 junction 目标即真实仓库，或把 junction 内容删空）。
  if (isLibraryPath(rel)) return 'skipped';
  const src = path.join(repoRoot, rel);
  const dst = path.join(kn, rel);
  const st = fileStamp(src);
  if (!st) {
    delete nextStamp.files[rel];
    delete nextStamp.targets[rel];
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
  const table = loadTable(repoRoot);
  const isLibraryPath = createLibMatcher(repoRoot, true);
  const libraryTops = libTops(repoRoot);
  const libraries = [libTopNames(repoRoot).sort(), libraryTops.slice().sort()];
  const fingerprint = syncFingerprint(table, libraries);
  const readyFile = path.join(kn, SYNC_READY_FILE);
  const stamp = readJson(keilStampPath(repoRoot), { files: {} });
  const topDirs = listTopDirs(repoRoot, libraryTops);
  const snapshot = sourceSnapshot(repoRoot, stamp, isLibraryPath, topDirs);
  const dirty = snapshot.dirty;
  const head = currentHead(repoRoot);
  const branch = currentBranch(repoRoot);
  const full = stamp.version !== SYNC_VERSION || stamp.fingerprint !== fingerprint
    || stamp.complete !== true || !fs.existsSync(readyFile)
    || stamp.head !== head || stamp.branch !== branch || !stamp.files || !stamp.targets;
  const targetCheckStart = process.hrtime.bigint();
  // Check targets as well as sources: build tools can overwrite copied inputs.
  if (!full) {
    for (const rel of Object.keys(stamp.files || {})) {
      if (isLibraryPath(rel)) continue;
      const current = fileStamp(path.join(kn, rel));
      if (!current || current !== stamp.targets[rel]) dirty.add(rel);
    }
  }
  const timings = { gitListMs: snapshot.gitListMs, sourceScanMs: snapshot.sourceScanMs,
    targetCheckMs: Number(process.hrtime.bigint() - targetCheckStart) / 1e6 };
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
      timings
    };
  }

  try { fs.unlinkSync(readyFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const nextStamp = { version: SYNC_VERSION, head: head, branch: branch, files: {}, targets: {}, libraryFiles: snapshot.libraryFiles };
  const incremental = !full && dirty.size > 0;
  if (incremental && stamp.files) {
    Object.keys(stamp.files).forEach((rel) => { nextStamp.files[rel] = stamp.files[rel]; });
    Object.assign(nextStamp.targets, stamp.targets);
  }
  let written = 0;
  let skipped = 0;
  let pruned = 0;

  const tally = (kind) => {
    if (kind === 'written') written += 1;
    else if (kind === 'skipped') skipped += 1;
    else if (kind === 'pruned') pruned += 1;
  };

  if (incremental) {
    // Reuse entries whose current metadata matches the previous build.
    for (const rel of dirty) {
      tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, false, dirty, isLibraryPath));
    }
  } else if (clean && stamp.files) {
    const rels = new Set(Object.keys(stamp.files));
    collectProjectRels(repoRoot).forEach((rel) => rels.add(rel));
    for (const rel of rels) {
      tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, false, dirty, isLibraryPath));
    }
  } else {
    const rels = new Set(Object.keys(snapshot.files));
    collectProjectRels(repoRoot).forEach((rel) => rels.add(rel));
    for (const rel of rels) {
      tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, full, dirty, isLibraryPath));
    }
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
