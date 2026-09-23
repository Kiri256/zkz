'use strict';

const fs = require('fs');
const path = require('path');
const { clean } = require('./filter_core');
const { loadTable } = require('./enc_table');
const {
  slashRel, keilNativeRoot, keilStampPath, ensureZkz, isSourceExt,
  DEFAULT_SKIP_DIR, libTops, isLibRel, isReparse, atomicWriteJson
} = require('./paths');
const { currentHead, currentBranch, gitText, git } = require('./git_exec');
const { parsePorcelainZ } = require('./git_status');
const { inspectLibEncoding, formatLibWarning } = require('./lib_encoding');

const BUSINESS_FALLBACK = ['User', 'core', 'driver', 'application', 'fpga_motion', 'emWin'];
const SKIP_DIR = new Set(DEFAULT_SKIP_DIR);
const PROJECT_KEEP_EXT = ['.sct', '.ini', '.scf'];

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

function listTopDirs(repoRoot) {
  let ents = [];
  try { ents = fs.readdirSync(repoRoot, { withFileTypes: true }); } catch (_) { return []; }
  const libs = new Set(libTops(repoRoot).map((s) => s.toLowerCase()));
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

function walkFiles(root, relDir, acc) {
  const abs = path.join(root, relDir);
  let ents = [];
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
  for (const ent of ents) {
    if (skipDirName(ent.name)) continue;
    const rel = relDir ? relDir + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walkFiles(root, rel, acc);
    else if (ent.isFile()) acc.push(slashRel(rel));
  }
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
    return String(st.size) + '|' + String(Math.round(st.mtimeMs));
  } catch (_) {
    return '';
  }
}

function changedRels(repoRoot) {
  const out = gitText(repoRoot, ['status', '--porcelain', '-z'], { allowFail: true });
  return parsePorcelainZ(out);
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

function writeSourceOrCopy(repoRoot, kn, table, rel) {
  ensureRealParent(repoRoot, kn, rel);
  const src = path.join(repoRoot, rel);
  const dst = path.join(kn, rel);
  if (isSourceExt(rel)) {
    const wt = fs.readFileSync(src);
    const bytes = clean(rel, wt, table);
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

function syncOne(repoRoot, kn, table, stamp, nextStamp, rel, full, dirty) {
  // 库由 junction 统一挂载：绝不逐文件拷贝/删除（否则会写进 junction 目标即真实仓库，或把 junction 内容删空）。
  if (isLibRel(repoRoot, rel)) return 'skipped';
  const src = path.join(repoRoot, rel);
  const dst = path.join(kn, rel);
  const st = fileStamp(src);
  if (!st) {
    try { if (fs.existsSync(dst) && fs.statSync(dst).isFile()) fs.unlinkSync(dst); } catch (_) { /* ignore */ }
    return 'pruned';
  }
  nextStamp.files[rel] = st;
  const unchanged = !full && !dirty.has(rel) && stamp.files && stamp.files[rel] === st && fs.existsSync(dst);
  if (unchanged) return 'skipped';
  writeSourceOrCopy(repoRoot, kn, table, rel);
  return 'written';
}

function copyDebugAxf(repoRoot, emit) {
  const cands = [
    path.join(repoRoot, 'Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.axf'),
    path.join(repoRoot, 'H750', 'Projects', 'MDK-ARM', 'Flash', 'Obj', 'output.axf')
  ];
  const src = cands.filter((p) => fs.existsSync(p))[0];
  if (!src) throw new Error('Missing output.axf, build first');
  const dst = path.join(repoRoot, '.zkz', 'output.axf');
  ensureZkz(repoRoot);
  if (fs.existsSync(dst)) {
    try { if (fs.lstatSync(dst).isSymbolicLink()) fs.unlinkSync(dst); } catch (_) { /* ignore */ }
  }
  copyFile(src, dst);
  if (emit) emit('debug axf -> .zkz/output.axf');
  return dst;
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
  const log = (m) => { if (emit) emit(m); };
  const kn = keilNativeRoot(repoRoot);
  fs.mkdirSync(kn, { recursive: true });
  const table = loadTable(repoRoot);
  const stamp = readJson(keilStampPath(repoRoot), { files: {} });
  const dirty = changedRels(repoRoot);
  const head = currentHead(repoRoot);
  const branch = currentBranch(repoRoot);
  const full = stamp.head !== head || stamp.branch !== branch || !stamp.files;
  const clean = !full && dirty.size === 0;

  let junctioned = 0;
  for (const top of libTops(repoRoot)) {
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

  const nextStamp = { head: head, branch: branch, files: {} };
  let written = 0;
  let skipped = 0;
  let pruned = 0;

  const tally = (kind) => {
    if (kind === 'written') written += 1;
    else if (kind === 'skipped') skipped += 1;
    else if (kind === 'pruned') pruned += 1;
  };

  if (clean && stamp.files) {
    const rels = new Set(Object.keys(stamp.files));
    collectProjectRels(repoRoot).forEach((rel) => rels.add(rel));
    for (const rel of rels) {
      tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, false, dirty));
    }
  } else {
    for (const top of listTopDirs(repoRoot)) {
      const files = [];
      walkFiles(repoRoot, top, files);
      for (const rel of files) tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, full, dirty));
    }
    for (const rel of collectProjectRels(repoRoot)) {
      tally(syncOne(repoRoot, kn, table, stamp, nextStamp, rel, full, dirty));
    }
  }

  if (stamp.files) {
    for (const rel of Object.keys(stamp.files)) {
      if (nextStamp.files[rel]) continue;
      // 库路径由 junction 管理，绝不 prune（历史 stamp 里若残留库条目，prune 会把 junction/目录内容删空）。
      if (isLibRel(repoRoot, rel)) continue;
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
  for (const top of listTopDirs(repoRoot)) {
    removed += pruneMissing(repoRoot, kn, top);
  }
  pruned += removed;

  writeJson(keilStampPath(repoRoot), nextStamp);
  const libDirty = [];
  dirty.forEach((rel) => {
    if (isSourceExt(rel) && isLibRel(repoRoot, rel)) libDirty.push(rel);
  });
  let libWarnings = [];
  try {
    libWarnings = inspectLibEncoding(repoRoot, libDirty, { mode: 'worktree', persist: true });
  } catch (e) {
    log('lib encoding inspect failed: ' + String(e && e.message ? e.message : e));
  }
  if (libWarnings.length) {
    log('lib encoding warnings: ' + libWarnings.length);
    libWarnings.forEach((it) => log('  ' + formatLibWarning(it)));
  }
  const msg = 'keil-native synced: write ' + written + ', skip ' + skipped +
    ', prune ' + pruned + ', junction ' + junctioned;
  log(msg);
  return {
    written: written,
    skipped: skipped,
    pruned: pruned,
    junctioned: junctioned,
    root: kn,
    libWarnings: libWarnings
  };
}

module.exports = {
  syncKeilTree,
  copyDebugAxf,
  keilNativeRoot,
  ensureRealParent,
  pruneMissing
};
