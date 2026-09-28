'use strict';

const fs = require('fs');
const { detectKind, encodeMapped, hasCrlf, parseMapped } = require('./encoding');
const { slashRel, tablePath, ensureZkz, isLibRel, formatLocalNow, atomicWriteJson } = require('./paths');
const { listSourceFiles, catFileBatch, currentHead, git } = require('./git_exec');
const { parseNameStatusZ } = require('./git_status');

function emptyTable() {
  return Object.create(null);
}

const gTableCache = { root: '', mtime: 0, map: null };

function loadTable(repoRoot) {
  const p = tablePath(repoRoot);
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch (_) { mtime = 0; }
  if (gTableCache.map && gTableCache.root === repoRoot && gTableCache.mtime === mtime) {
    return gTableCache.map;
  }
  const map = emptyTable();
  if (!fs.existsSync(p)) {
    gTableCache.root = repoRoot;
    gTableCache.mtime = mtime;
    gTableCache.map = map;
    return map;
  }
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    const src = (obj && obj.files && typeof obj.files === 'object') ? obj.files : obj;
    for (const k of Object.keys(src || {})) {
      const kind = String(src[k] || '');
      if (kind) map[slashRel(k)] = kind;
    }
  } catch (_) { /* ignore */ }
  gTableCache.root = repoRoot;
  gTableCache.mtime = mtime;
  gTableCache.map = map;
  return map;
}

function loadMeta(repoRoot) {
  const p = tablePath(repoRoot);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function saveTable(repoRoot, files, extra) {
  ensureZkz(repoRoot);
  const ordered = {};
  Object.keys(files).sort().forEach((k) => { ordered[slashRel(k)] = files[k]; });
  const obj = Object.assign({
    version: 1,
    head: currentHead(repoRoot),
    generatedAt: formatLocalNow(),
    files: ordered
  }, extra || {});
  atomicWriteJson(tablePath(repoRoot), obj);
  return obj;
}

function countByKind(files) {
  const c = { Ascii: 0, Utf8: 0, Utf8Bom: 0, Gbk: 0 };
  for (const k of Object.keys(files)) {
    const kind = files[k];
    if (c[kind] == null) c[kind] = 0;
    c[kind] += 1;
  }
  return c;
}

async function fillKinds(repoRoot, files, paths) {
  const batch = 200;
  for (let i = 0; i < paths.length; i += batch) {
    const slice = paths.slice(i, i + batch);
    const specs = slice.map((p) => 'HEAD:' + p);
    const blobs = await catFileBatch(repoRoot, specs);
    for (let j = 0; j < slice.length; j++) {
      const rec = blobs[j];
      if (!rec || rec.missing) {
        delete files[slice[j]];
        continue;
      }
      files[slice[j]] = encodeMapped(detectKind(rec.data), hasCrlf(rec.data));
    }
  }
}

async function buildTableIncremental(repoRoot, from, to, skipLib) {
  if (!from || !to || from === to) return null;
  const existing = loadTable(repoRoot);
  if (!Object.keys(existing).length) return null;
  const r = git(repoRoot, ['diff', '--name-status', '-z', from, to, '--', '*.c', '*.h'], { allowFail: true });
  if (r.status !== 0) return null;
  const parsed = parseNameStatusZ(r.stdout);
  const files = emptyTable();
  Object.keys(existing).forEach((k) => { files[k] = existing[k]; });
  parsed.removed.forEach((p) => { delete files[p]; });
  const add = parsed.added.filter((p) => !(skipLib && isLibRel(repoRoot, p)));
  if (add.length) await fillKinds(repoRoot, files, add);
  const meta = saveTable(repoRoot, files);
  return { files: files, meta: meta, counts: countByKind(files), incremental: true };
}

async function buildTable(repoRoot, opts) {
  const skipLib = !(opts && opts.includeLibs);
  const force = !!(opts && opts.force);
  if (!force && opts && opts.from && opts.to) {
    const hit = await buildTableIncremental(repoRoot, opts.from, opts.to, skipLib);
    if (hit) return hit;
  }
  const paths = listSourceFiles(repoRoot).map(slashRel).filter((p) => {
    if (skipLib && isLibRel(repoRoot, p)) return false;
    return true;
  });
  const files = emptyTable();
  await fillKinds(repoRoot, files, paths);
  const meta = saveTable(repoRoot, files);
  return { files: files, meta: meta, counts: countByKind(files) };
}

module.exports = {
  loadTable,
  loadMeta,
  saveTable,
  countByKind,
  buildTable
};
