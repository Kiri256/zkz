'use strict';

const fs = require('fs');
const { detectKind, encodeMapped, hasCrlf, parseMapped } = require('./encoding');
const { slashRel, tablePath, ensureZkz, isLibRel, formatLocalNow, atomicWriteJson } = require('./paths');
const { acquireLock, releaseLock } = require('./lock');
const { listSourceFiles, catFileBatch, currentHead, readHeadName, git } = require('./git_exec');
const { parseNameStatusZ } = require('./git_status');
const { record: recordPerf } = require('../../shared/perf');

function emptyTable() {
  return Object.create(null);
}

const gTableCache = { root: '', mtime: 0, map: null, meta: null };

function tableStamp(file) {
  try {
    const st = fs.statSync(file);
    return [st.mtimeMs, st.ctimeMs, st.size].join('|');
  } catch (_) { return 'missing'; }
}

function rememberTable(repoRoot, mtime, map, meta) {
  gTableCache.root = repoRoot;
  gTableCache.mtime = mtime;
  gTableCache.map = map;
  gTableCache.meta = meta;
}

function loadTable(repoRoot) {
  const p = tablePath(repoRoot);
  const mtime = tableStamp(p);
  if (gTableCache.map && gTableCache.root === repoRoot && gTableCache.mtime === mtime) {
    return gTableCache.map;
  }
  const map = emptyTable();
  let meta = null;
  if (fs.existsSync(p)) {
    let obj = null;
    try {
      obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
      const err = new Error('编码表无法解析，已停止以免用空表覆盖: ' + p);
      err.code = 'ZKZ_TABLE_CORRUPT';
      throw err;
    }
    meta = (obj && typeof obj === 'object') ? obj : null;
    const src = (obj && obj.files && typeof obj.files === 'object') ? obj.files : obj;
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const k of Object.keys(src)) {
        const kind = String(src[k] || '');
        if (kind) map[slashRel(k)] = kind;
      }
    }
  }
  rememberTable(repoRoot, mtime, map, meta);
  return map;
}

function loadMeta(repoRoot) {
  loadTable(repoRoot);
  if (gTableCache.root !== repoRoot) return null;
  return gTableCache.meta;
}

/** 旧表只有提交号。补上当前分支名，同分支提交不再被当成过期。 */
function noteTableRef(repoRoot, meta) {
  if (!meta || meta.ref) return meta;
  const ref = readHeadName(repoRoot);
  if (!ref) return meta;
  const lockDir = acquireLock(repoRoot, 'encoding-table');
  try {
    meta.ref = ref;
    atomicWriteJson(tablePath(repoRoot), meta);
    if (gTableCache.root === repoRoot && gTableCache.meta === meta) {
      gTableCache.mtime = tableStamp(tablePath(repoRoot));
    }
  } catch (_) { /* ignore */ } finally {
    releaseLock(lockDir);
  }
  return meta;
}

function mappingOf(repoRoot, pathname) {
  if (!repoRoot || !pathname) return '';
  const files = loadTable(repoRoot);
  return files[slashRel(pathname)] || '';
}

function noteNewFile(repoRoot, pathname, mapped, opts) {
  if (!repoRoot || !pathname || !mapped) return mapped || '';
  const overwrite = !!(opts && opts.overwrite);
  const key = slashRel(pathname);
  // 编烧树同步持有仓库锁时，过滤器和刷新仍会改编码表，所以这里用另一把锁。
  const lockDir = acquireLock(repoRoot, 'encoding-table');
  try {
    if (gTableCache.root === repoRoot) gTableCache.map = null;
    const files = loadTable(repoRoot);
    if (files[key] && !overwrite) return files[key];
    if (files[key] === mapped) return mapped;
    files[key] = mapped;
    saveTableUnlocked(repoRoot, files);
    return mapped;
  } finally {
    releaseLock(lockDir);
  }
}

function saveTable(repoRoot, files, extra) {
  const lockDir = acquireLock(repoRoot, 'encoding-table');
  try {
    return saveTableUnlocked(repoRoot, files, extra);
  } finally {
    releaseLock(lockDir);
  }
}

function saveTableUnlocked(repoRoot, files, extra) {
  ensureZkz(repoRoot);
  const ordered = {};
  Object.keys(files).sort().forEach((k) => { ordered[slashRel(k)] = files[k]; });
  const obj = Object.assign({
    version: 1,
    head: currentHead(repoRoot),
    ref: readHeadName(repoRoot),
    generatedAt: formatLocalNow(),
    files: ordered
  }, extra || {});
  atomicWriteJson(tablePath(repoRoot), obj);
  if (gTableCache.root === repoRoot) {
    gTableCache.map = null;
    gTableCache.meta = null;
  }
  return obj;
}

function countByKind(files) {
  const c = { Ascii: 0, Utf8: 0, Utf8Bom: 0, Gbk: 0 };
  for (const k of Object.keys(files)) {
    const kind = parseMapped(files[k]).kind;
    if (!kind) continue;
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
  const detect = [];
  for (let i = 0; i < parsed.records.length; i++) {
    const rec = parsed.records[i];
    const path = rec.path || '';
    const oldPath = rec.oldPath || '';
    const pathIsLib = !!(path && skipLib && isLibRel(repoRoot, path));
    if (rec.status === 'M') continue;
    if ((rec.status === 'R' || rec.status === 'C') && oldPath && existing[oldPath] && !pathIsLib) {
      files[path] = existing[oldPath];
    } else if (!pathIsLib && path && (rec.status === 'A' || rec.status === 'R' || rec.status === 'C' || rec.status === 'T')) {
      detect.push(path);
    }
  }
  for (let i = 0; i < parsed.records.length; i++) {
    const rec = parsed.records[i];
    if ((rec.status === 'D' || rec.status === 'R') && rec.oldPath) delete files[rec.oldPath];
  }
  if (detect.length) await fillKinds(repoRoot, files, detect);
  const meta = saveTableUnlocked(repoRoot, files);
  return { files: files, meta: meta, counts: countByKind(files), incremental: true };
}

async function buildTable(repoRoot, opts) {
  const lockDir = acquireLock(repoRoot, 'encoding-table');
  try {
    if (gTableCache.root === repoRoot) {
      gTableCache.map = null;
      gTableCache.meta = null;
    }
    return await buildTableBody(repoRoot, opts);
  } finally {
    releaseLock(lockDir);
  }
}

async function buildTableBody(repoRoot, opts) {
  const perfStart = process.hrtime.bigint();
  const skipLib = !(opts && opts.includeLibs);
  const force = !!(opts && opts.force);
  if (!force && opts && opts.from && opts.to) {
    const hit = await buildTableIncremental(repoRoot, opts.from, opts.to, skipLib);
    if (hit) {
      recordPerf(repoRoot, 'zkz-native.buildEncodingTable', {
        ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
        files: Object.keys(hit.files || {}).length,
        incremental: true,
        includeLibs: !skipLib
      });
      return hit;
    }
  }
  const paths = listSourceFiles(repoRoot).map(slashRel).filter((p) => {
    if (skipLib && isLibRel(repoRoot, p)) return false;
    return true;
  });
  const files = emptyTable();
  await fillKinds(repoRoot, files, paths);
  const meta = saveTableUnlocked(repoRoot, files);
  recordPerf(repoRoot, 'zkz-native.buildEncodingTable', {
    ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
    files: Object.keys(files).length,
    incremental: false,
    includeLibs: !skipLib
  });
  return { files: files, meta: meta, counts: countByKind(files) };
}

module.exports = {
  loadTable,
  loadMeta,
  noteTableRef,
  mappingOf,
  noteNewFile,
  saveTable,
  countByKind,
  buildTable
};
