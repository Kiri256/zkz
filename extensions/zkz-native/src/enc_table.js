'use strict';

const fs = require('fs');
const path = require('path');
const { detectKind, encodeMapped, hasCrlf, parseMapped } = require('./encoding');
const { slashRel, tablePath, ensureZkz, isLibRel, formatLocalNow, atomicWriteJson } = require('./paths');
const { acquireLock, releaseLock } = require('./lock');
const { listSourceFiles, catFileBatch, currentHead, readHeadName, git, indexBlobOid } = require('./git_exec');
const { parseNameStatusZ } = require('./git_status');
const loadShared = require('./load_shared');
const { record: recordPerf } = loadShared('perf');

function emptyTable() {
  return Object.create(null);
}

const gTableCache = { root: '', mtime: 0, map: null, meta: null };
// blob → 编码。本进程的工作副本；文件只在出现新 blob 时写。
const gBlobCache = { root: '', mtime: '', blobs: null, dirty: false };
// 路径上手工指定的编码，不跟 blob 混在一起。
const gOverrideCache = { root: '', mtime: '', paths: null, dirty: false };

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

// 同分支新提交只改编码表里的提交号，不重算每个文件。表不存在或提交号不合法则不动。扩展宿主调用。
function noteTableHead(repoRoot, head) {
  const want = commitOid(head);
  if (!want) return null;
  const lockDir = acquireLock(repoRoot, 'encoding-table');
  try {
    if (gTableCache.root === repoRoot) {
      gTableCache.map = null;
      gTableCache.meta = null;
    }
    const meta = loadMeta(repoRoot);
    if (!meta || !meta.files || typeof meta.files !== 'object') return null;
    if (commitOid(meta.head) === want) return meta;
    meta.head = want;
    atomicWriteJson(tablePath(repoRoot), meta);
    if (gTableCache.root === repoRoot && gTableCache.meta === meta) {
      gTableCache.mtime = tableStamp(tablePath(repoRoot));
    }
    return meta;
  } finally {
    releaseLock(lockDir);
  }
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
  // 已在表里就直接用。编烧每个文件都抢锁重读整份 JSON，会拖到几十秒。
  if (!overwrite) {
    const cached = loadTable(repoRoot);
    if (cached[key]) return cached[key];
  }
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

function commitOid(value) {
  const oid = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : '';
}

function blobCachePath(repoRoot) {
  return path.join(path.dirname(tablePath(repoRoot)), 'encoding-by-blob.json');
}

function overridePath(repoRoot) {
  return path.join(path.dirname(tablePath(repoRoot)), 'encoding-path-override.json');
}

function readBlobFile(repoRoot) {
  try {
    const obj = JSON.parse(fs.readFileSync(blobCachePath(repoRoot), 'utf8'));
    if (!obj || obj.version !== 1 || !obj.blobs) return emptyTable();
    return obj.blobs;
  } catch (_) {
    return emptyTable();
  }
}

function readOverrideFile(repoRoot) {
  try {
    const obj = JSON.parse(fs.readFileSync(overridePath(repoRoot), 'utf8'));
    if (!obj || obj.version !== 1 || !obj.paths) return emptyTable();
    return obj.paths;
  } catch (_) {
    return emptyTable();
  }
}

// 两份路径表是否逐项相同。相同返回 true。过滤进程或扩展宿主调用。
function mapsEqual(a, b) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (a[aKeys[i]] !== b[aKeys[i]]) return false;
  }
  return true;
}

// 装入 blob → 编码。返回这张表。过滤进程或扩展宿主调用。
function loadBlobCache(repoRoot) {
  const file = blobCachePath(repoRoot);
  const mtime = tableStamp(file);
  if (gBlobCache.blobs && gBlobCache.root === repoRoot && (gBlobCache.dirty || gBlobCache.mtime === mtime)) {
    return gBlobCache.blobs;
  }
  const blobs = readBlobFile(repoRoot);
  gBlobCache.root = repoRoot;
  gBlobCache.mtime = mtime;
  gBlobCache.blobs = blobs;
  gBlobCache.dirty = false;
  return blobs;
}

// 记住这份 blob 的编码。相同则不标记写盘。过滤进程或扩展宿主调用。
function rememberBlob(repoRoot, oid, mapped) {
  const id = commitOid(oid);
  if (!id || !mapped) return;
  const blobs = loadBlobCache(repoRoot);
  if (blobs[id] === mapped) return;
  blobs[id] = mapped;
  gBlobCache.dirty = true;
}

// 把新的 blob 编码写入文件。没有新内容返回 false。过滤进程或扩展宿主调用。
function flushBlobCache(repoRoot) {
  if (!gBlobCache.dirty || gBlobCache.root !== repoRoot || !gBlobCache.blobs) return false;
  ensureZkz(repoRoot);
  const file = blobCachePath(repoRoot);
  atomicWriteJson(file, { version: 1, blobs: gBlobCache.blobs });
  gBlobCache.mtime = tableStamp(file);
  gBlobCache.dirty = false;
  return true;
}

// 装入路径手工指定。返回路径表。过滤进程或扩展宿主调用。
function loadPathOverrides(repoRoot) {
  const file = overridePath(repoRoot);
  const mtime = tableStamp(file);
  if (gOverrideCache.paths && gOverrideCache.root === repoRoot && (gOverrideCache.dirty || gOverrideCache.mtime === mtime)) {
    return gOverrideCache.paths;
  }
  const paths = readOverrideFile(repoRoot);
  gOverrideCache.root = repoRoot;
  gOverrideCache.mtime = mtime;
  gOverrideCache.paths = paths;
  gOverrideCache.dirty = false;
  return paths;
}

// 路径编码和 blob 判定不一致时记下手工指定，一致时去掉。过滤进程或扩展宿主调用。
function syncPathOverrides(repoRoot, files) {
  const overrides = loadPathOverrides(repoRoot);
  const blobs = loadBlobCache(repoRoot);
  let changed = false;
  Object.keys(files || {}).forEach((rel) => {
    const oid = indexBlobOid(repoRoot, rel);
    const known = oid && blobs[commitOid(oid)];
    if (!known) return;
    if (known === files[rel]) {
      if (overrides[rel]) {
        delete overrides[rel];
        changed = true;
      }
    } else if (overrides[rel] !== files[rel]) {
      overrides[rel] = files[rel];
      changed = true;
    }
  });
  if (!changed) return;
  gOverrideCache.dirty = true;
  ensureZkz(repoRoot);
  const file = overridePath(repoRoot);
  atomicWriteJson(file, { version: 1, paths: overrides });
  gOverrideCache.mtime = tableStamp(file);
  gOverrideCache.dirty = false;
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
  syncPathOverrides(repoRoot, ordered);
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
      rememberBlob(repoRoot, rec.oid, files[slice[j]]);
    }
  }
  flushBlobCache(repoRoot);
}

// 改动面已经接近整棵树时，带重命名检测的增量比全量重算更慢。
function diffIsWide(changed, existingCount) {
  if (changed >= 800) return true;
  return existingCount >= 200 && changed * 2 >= existingCount;
}

function changedSourceCount(repoRoot, from, to) {
  const r = git(repoRoot, ['diff', '--name-only', '--no-renames', '-z', from, to, '--', '*.c', '*.h'], { allowFail: true });
  if (r.status !== 0) return Number.POSITIVE_INFINITY;
  return String(r.stdout || '').split('\0').filter(Boolean).length;
}

async function buildTableIncremental(repoRoot, from, to, skipLib) {
  if (!from || !to || from === to) return null;
  const existing = loadTable(repoRoot);
  const existingCount = Object.keys(existing).length;
  if (!existingCount) return null;
  if (diffIsWide(changedSourceCount(repoRoot, from, to), existingCount)) return null;
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

// 小范围切换时，改过的路径沿用当前表里的编码。见过的 blob 不能盖掉还没写成手工指定的那一项。返回是否改过。过滤进程或扩展宿主调用。
function keepEditedEncodings(repoRoot, from, to, files) {
  const existing = loadTable(repoRoot);
  const r = git(repoRoot, ['diff', '--name-status', '-z', from, to, '--', '*.c', '*.h'], { allowFail: true });
  if (!r || r.status !== 0) return false;
  const parsed = parseNameStatusZ(r.stdout);
  let changed = false;
  for (let i = 0; i < parsed.records.length; i++) {
    const rec = parsed.records[i];
    const path = rec.path || '';
    let kept = '';
    if (rec.status === 'M') kept = existing[path] || '';
    else if ((rec.status === 'R' || rec.status === 'C') && rec.oldPath) kept = existing[rec.oldPath] || '';
    if (!kept || !path || files[path] === kept) continue;
    files[path] = kept;
    changed = true;
  }
  return changed;
}

// 按当前索引把 blob 缓存和路径手工指定拼成编码表。knownOnly 时只要有没见过的 blob 就返回 null。过滤进程或扩展宿主调用。
async function projectTable(repoRoot, skipLib, knownOnly) {
  const paths = listSourceFiles(repoRoot).map(slashRel).filter((rel) => !(skipLib && isLibRel(repoRoot, rel)));
  const overrides = loadPathOverrides(repoRoot);
  const blobs = loadBlobCache(repoRoot);
  const files = emptyTable();
  const detect = [];
  for (let i = 0; i < paths.length; i++) {
    const rel = paths[i];
    if (overrides[rel]) {
      files[rel] = overrides[rel];
      continue;
    }
    const oid = commitOid(indexBlobOid(repoRoot, rel));
    if (oid && blobs[oid]) {
      files[rel] = blobs[oid];
      continue;
    }
    if (knownOnly) return null;
    detect.push(rel);
  }
  if (detect.length) await fillKinds(repoRoot, files, detect);
  return { files: files, detected: detect.length };
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
    const wide = diffIsWide(changedSourceCount(repoRoot, opts.from, opts.to), Object.keys(loadTable(repoRoot)).length);
    const known = await projectTable(repoRoot, skipLib, true);
    if (known) {
      if (!wide) keepEditedEncodings(repoRoot, opts.from, opts.to, known.files);
      const metaNow = loadMeta(repoRoot);
      const unchanged = !!(metaNow && commitOid(metaNow.head) === commitOid(opts.to) && mapsEqual(loadTable(repoRoot), known.files));
      const metaHit = unchanged ? metaNow : saveTableUnlocked(repoRoot, known.files);
      recordPerf(repoRoot, 'zkz-native.buildEncodingTable', {
        ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
        files: Object.keys(known.files).length,
        incremental: true,
        cacheHit: true,
        includeLibs: includeLibs
      });
      return { files: known.files, meta: metaHit, counts: countByKind(known.files), incremental: true, cacheHit: true };
    }
    if (!wide) {
      const hit = await buildTableIncremental(repoRoot, opts.from, opts.to, skipLib);
      if (hit) {
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
  }
  const projected = await projectTable(repoRoot, skipLib, false);
  const meta = saveTableUnlocked(repoRoot, projected.files);
  recordPerf(repoRoot, 'zkz-native.buildEncodingTable', {
    ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
    files: Object.keys(projected.files).length,
    incremental: false,
    cacheHit: false,
    includeLibs: !skipLib
  });
  return { files: projected.files, meta: meta, counts: countByKind(projected.files), incremental: false };
}

module.exports = {
  loadTable,
  loadMeta,
  noteTableRef,
  noteTableHead,
  mappingOf,
  noteNewFile,
  saveTable,
  countByKind,
  buildTable,
  setNoteDefer,
  flushDeferredNotes
};
