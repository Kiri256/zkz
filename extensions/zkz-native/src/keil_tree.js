'use strict';

const fs = require('fs');
const path = require('path');
const { clean } = require('./filter_core');
const { loadTable } = require('./enc_table');
const {
  slashRel, keilNativeRoot, keilStampPath, ensureZkz, isSourceExt,
  DEFAULT_SKIP_DIR, libTops, isReparse, appendLog
} = require('./paths');
const { currentHead, currentBranch, gitText } = require('./git_exec');

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
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
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
  const set = new Set();
  if (!out) return set;
  const parts = out.split('\0').filter(Boolean);
  for (const rec of parts) {
    const pathPart = rec.length > 3 ? rec.slice(3) : rec;
    if (pathPart) set.add(slashRel(pathPart.split(' -> ').pop()));
  }
  return set;
}

function writeSourceOrCopy(repoRoot, kn, table, rel) {
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

function copyArtifactsBack(repoRoot, emit) {
  const kn = keilNativeRoot(repoRoot);
  const pairs = [
    ['Project/MDK-ARM(uV4)/Flash/Obj/output.axf', 'Project/MDK-ARM(uV4)/Flash/Obj/output.axf'],
    ['Project/MDK-ARM(uV4)/Flash/Obj/output.hex', 'Project/MDK-ARM(uV4)/Flash/Obj/output.hex'],
    ['H750/Projects/MDK-ARM/Flash/Obj/output.axf', 'H750/Projects/MDK-ARM/Flash/Obj/output.axf'],
    ['H750/Projects/MDK-ARM/Flash/Obj/output.hex', 'H750/Projects/MDK-ARM/Flash/Obj/output.hex']
  ];
  let n = 0;
  for (const [rel] of pairs) {
    const src = path.join(kn, rel);
    const dst = path.join(repoRoot, rel);
    if (!fs.existsSync(src)) continue;
    copyFile(src, dst);
    n += 1;
    if (emit) emit('  artifact -> ' + rel);
  }
  return n;
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

function syncKeilTree(repoRoot, emit) {
  const log = (m) => { if (emit) emit(m); appendLog(repoRoot, m); };
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
    if (fs.existsSync(dst) && !isReparse(dst)) continue;
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
      const dst = path.join(kn, rel);
      try {
        if (fs.existsSync(dst) && fs.statSync(dst).isFile()) {
          fs.unlinkSync(dst);
          pruned += 1;
        }
      } catch (_) { /* ignore */ }
    }
  }

  writeJson(keilStampPath(repoRoot), nextStamp);
  const msg = 'keil-native synced: write ' + written + ', skip ' + skipped +
    ', prune ' + pruned + ', junction ' + junctioned;
  log(msg);
  return { written: written, skipped: skipped, pruned: pruned, junctioned: junctioned, root: kn };
}

module.exports = {
  syncKeilTree,
  copyArtifactsBack,
  copyDebugAxf,
  keilNativeRoot
};
