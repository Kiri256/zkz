'use strict';

const fs = require('fs');
const path = require('path');
const { detectKind, encodeMapped, hasCrlf, parseMapped } = require('./encoding');
const { slashRel, tablePath, ensureZkz, isLibRel, formatLocalNow, atomicWriteJson } = require('./paths');
const { acquireLock, releaseLock } = require('./lock');
const { listSourceFiles, catFileBatch, currentHead, readHeadName, git } = require('./git_exec');
const { parseNameStatusZ } = require('./git_status');
// 源码树里在 extensions/shared，装进扩展后在 src/shared。
function loadPerf() {
  try { return require('../../shared/perf'); }
  catch (_) { return require('./shared/perf'); }
}
const { record: recordPerf } = loadPerf();

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

let deferNotes = false;
const deferredNotes = [];

/** 过滤进程里先改内存，结束时再写一次编码表。避免每个文件都抢锁重写整份 JSON。 */
function setNoteDefer(on) {
  deferNotes = !!on;
}

function noteNewFileDeferred(repoRoot, key, mapped, overwrite) {
  const files = loadTable(repoRoot);
  if (files[key] && !overwrite) return files[key];
  if (files[key] === mapped) return mapped;
  files[key] = mapped;
  deferredNotes.push({ repoRoot: repoRoot, key: key, mapped: mapped, overwrite: overwrite });
  return mapped;
}

/** 把这一次过滤里积下的编码写回磁盘。过滤进程结束时调用。失败则抛出。 */
function flushDeferredNotes() {
  if (!deferredNotes.length) return;
  const queue = deferredNotes.splice(0, deferredNotes.length);
  const roots = [];
  for (let i = 0; i < queue.length; i++) {
    if (roots.indexOf(queue[i].repoRoot) < 0) roots.push(queue[i].repoRoot);
  }
  for (let i = 0; i < roots.length; i++) {
    const repoRoot = roots[i];
    const lockDir = acquireLock(repoRoot, 'encoding-table');
    try {
      if (gTableCache.root === repoRoot) gTableCache.map = null;
      const files = loadTable(repoRoot);
      let changed = false;
      for (let j = 0; j < queue.length; j++) {
        const op = queue[j];
        if (op.repoRoot !== repoRoot) continue;
        if (files[op.key] && !op.overwrite) continue;
        if (files[op.key] === op.mapped) continue;
        files[op.key] = op.mapped;
        changed = true;
      }
      if (changed) saveTableUnlocked(repoRoot, files);
    } finally {
      releaseLock(lockDir);
    }
  }
}

function noteNewFile(repoRoot, pathname, mapped, opts) {
  if (!repoRoot || !pathname || !mapped) return mapped || '';
  const overwrite = !!(opts && opts.overwrite);
  const key = slashRel(pathname);
  if (deferNotes) return noteNewFileDeferred(repoRoot, key, mapped, overwrite);
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

const COMMIT_TABLE_LIMIT = 8;

function commitOid(value) {
  const oid = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : '';
}

function commitTablePath(repoRoot) {
  return path.join(path.dirname(tablePath(repoRoot)), 'encoding-by-commit.json');
}

function readCommitTables(repoRoot) {
  try {
    const obj = JSON.parse(fs.readFileSync(commitTablePath(repoRoot), 'utf8'));
    if (!obj || obj.version !== 1 || !obj.commits) return { version: 1, order: [], commits: {} };
    if (!Array.isArray(obj.order)) obj.order = Object.keys(obj.commits);
    return obj;
  } catch (_) {
    return { version: 1, order: [], commits: {} };
  }
}

function copyFileMap(files) {
  const out = emptyTable();
  Object.keys(files || {}).forEach((k) => { out[slashRel(k)] = files[k]; });
  return out;
}

// 同一个提交的编码结果留下。来回切分支时直接用，不再对整棵树重新 diff。
function rememberCommitTable(repoRoot, head, files, includeLibs) {
  const oid = commitOid(head);
  if (!oid || !files) return;
  try {
    ensureZkz(repoRoot);
    const obj = readCommitTables(repoRoot);
    obj.order = obj.order.filter((item) => item !== oid);
    obj.order.push(oid);
    while (obj.order.length > COMMIT_TABLE_LIMIT) {
      const drop = obj.order.shift();
      if (drop) delete obj.commits[drop];
    }
    obj.commits[oid] = { includeLibs: !!includeLibs, files: copyFileMap(files) };
    atomicWriteJson(commitTablePath(repoRoot), obj);
  } catch (_) { /* 缓存写不上就下次再算 */ }
}

function recallCommitTable(repoRoot, head, includeLibs) {
  const oid = commitOid(head);
  if (!oid) return null;
  const obj = readCommitTables(repoRoot);
  const rec = obj.commits[oid];
  if (!rec || !!rec.includeLibs !== !!includeLibs || !rec.files) return null;
  return copyFileMap(rec.files);
}

function saveTableUnlocked(repoRoot, files, extra) {
  ensureZkz(repoRoot);
  const ordered = {};
  Object.keys(files).sort().forEach((k) => { ordered[slashRel(k)] = files[k]; });
  const head = currentHead(repoRoot);
  const obj = Object.assign({
    version: 1,
    head: head,
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
  const includeLibs = !skipLib;
  if (!force && opts && opts.from && opts.to && opts.from !== opts.to) {
    const meta = loadMeta(repoRoot);
    if (meta && commitOid(meta.head) && commitOid(meta.head) !== commitOid(opts.to)) {
      rememberCommitTable(repoRoot, meta.head, loadTable(repoRoot), includeLibs);
    }
    const cached = recallCommitTable(repoRoot, opts.to, includeLibs);
    if (cached) {
      const metaHit = saveTableUnlocked(repoRoot, cached);
      rememberCommitTable(repoRoot, opts.to, cached, includeLibs);
      recordPerf(repoRoot, 'zkz-native.buildEncodingTable', {
        ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
        files: Object.keys(cached).length,
        incremental: true,
        cacheHit: true,
        includeLibs: includeLibs
      });
      return { files: cached, meta: metaHit, counts: countByKind(cached), incremental: true, cacheHit: true };
    }
  }
  if (!force && opts && opts.from && opts.to) {
    const hit = await buildTableIncremental(repoRoot, opts.from, opts.to, skipLib);
    if (hit) {
      rememberCommitTable(repoRoot, opts.to || currentHead(repoRoot), hit.files, includeLibs);
      recordPerf(repoRoot, 'zkz-native.buildEncodingTable', {
        ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
        files: Object.keys(hit.files || {}).length,
        incremental: true,
        cacheHit: false,
        includeLibs: includeLibs
      });
      hit.cacheHit = false;
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
  rememberCommitTable(repoRoot, (opts && opts.to) || currentHead(repoRoot), files, includeLibs);
  recordPerf(repoRoot, 'zkz-native.buildEncodingTable', {
    ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
    files: Object.keys(files).length,
    incremental: false,
    cacheHit: false,
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
  buildTable,
  setNoteDefer,
  flushDeferredNotes
};
