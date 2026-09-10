'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { loadWorkspaceLists } = require('./lists');
const {
  looksBinary,
  getTextEncodingKind,
  bytesToUtf8Text,
  encodeTextByKind
} = require('./encoding');
const { getUtf8Path } = require('./pair');

const STATE_DIR = '.zkz';
const META = '.workspace_sync_meta.json';
const ENC_MAP = '.workspace_source_encodings.json';
const SRC_STAMP = '.workspace_source_stamps.json';
const DST_STAMP = '.workspace_dest_stamps.json';
const UNIX_EPOCH_TICKS = 621355968000000000n;

function lists() { return loadWorkspaceLists(); }

function throwIfCancelled(token) {
  if (token && token.isCancellationRequested) throw new Error('\u5df2\u53d6\u6d88');
}

function normRel(p) { return String(p || '').replace(/\//g, '\\'); }
function slashRel(p) { return String(p || '').replace(/\\/g, '/'); }
function joinRoot(root, rel) { return path.join(root, normRel(rel)); }

function isSkipTopDir(name) {
  if (!name) return true;
  const set = lists().skipTopDirNames || [];
  if (set.indexOf(name) >= 0) return true;
  return name.charAt(0) === '.';
}

function isSkipTopFile(name) {
  if (!name) return true;
  const set = lists().skipTopFileNames || [];
  if (set.indexOf(name) >= 0) return true;
  if (name.indexOf('.workspace_') === 0) return true;
  return /\.code-workspace$/i.test(name);
}

function isLibraryName(name) {
  const libs = lists().libraryDirNames || [];
  return libs.some((n) => String(n).toLowerCase() === String(name).toLowerCase());
}

function isLibraryRel(rel) {
  const top = normRel(rel).replace(/^\\+/, '').split('\\')[0];
  return isLibraryName(top);
}

function isNoTranscode(rel) {
  const n = normRel(rel).replace(/^\\+/, '');
  return /^Project\\/i.test(n) || /\\Project\\/i.test('\\' + n);
}

function isTextFile(p) {
  const ext = path.extname(p).toLowerCase();
  return (lists().textExtensions || []).indexOf(ext) >= 0;
}

function isSyncCopyFile(rel) {
  if (isNoTranscode(rel)) return false;
  return isTextFile(rel);
}

function isExcludedPath(rel) {
  const parts = normRel(rel).split(/[\\/]/);
  const excludeDirs = lists().excludeDirNames || [];
  const excludeFiles = lists().excludeFileNames || [];
  for (const p of parts) {
    if (excludeDirs.indexOf(p) >= 0) return true;
  }
  const leaf = parts[parts.length - 1] || '';
  if (excludeFiles.indexOf(leaf) >= 0) return true;
  if (/\.uvgui/i.test(leaf) || /\.uvguix/i.test(leaf)) return true;
  if (/\.build_log\.htm$/i.test(leaf)) return true;
  return false;
}

function isReparse(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
}

function resolvePlan(w1) {
  const copy = [];
  const skipped = [];
  let ents = [];
  try { ents = fs.readdirSync(w1, { withFileTypes: true }); } catch (_) { ents = []; }
  for (const ent of ents) {
    if (ent.isDirectory()) {
      if (isSkipTopDir(ent.name)) { skipped.push(ent.name); continue; }
      copy.push(ent.name);
    } else if (isSkipTopFile(ent.name)) {
      skipped.push(ent.name);
    }
  }
  copy.sort();
  return { copyDirs: copy, skippedTop: skipped.sort() };
}

function librarySpecs(copyDirs) { return copyDirs.filter(isLibraryName); }
function businessSpecs(copyDirs) { return copyDirs.filter((d) => !isLibraryName(d)); }

function walkFiles(root, spec, transcodeOnly) {
  const out = [];
  const specFull = path.join(root, spec);
  if (!fs.existsSync(specFull)) return out;
  const st = fs.statSync(specFull);
  const visit = (abs, rel) => {
    if (isExcludedPath(rel)) return;
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    const excludeDirs = lists().excludeDirNames || [];
    for (const ent of ents) {
      const childRel = rel ? rel + '\\' + ent.name : ent.name;
      const childAbs = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        if (excludeDirs.indexOf(ent.name) >= 0) continue;
        visit(childAbs, childRel);
      } else if (ent.isFile()) {
        if (isExcludedPath(childRel)) continue;
        if (transcodeOnly && !isSyncCopyFile(childRel)) continue;
        out.push(childRel);
      }
    }
  };
  if (st.isDirectory()) visit(specFull, spec);
  else {
    const rel = spec;
    if (!isExcludedPath(rel) && (!transcodeOnly || isSyncCopyFile(rel))) out.push(rel);
  }
  return out;
}

function filesUnderSpecs(root, specs, transcodeOnly) {
  const out = [];
  for (const spec of specs || []) out.push.apply(out, walkFiles(root, spec, transcodeOnly));
  return out;
}

function fileStamp(p) {
  const st = fs.statSync(p);
  const ns = typeof st.mtimeNs === 'bigint' ? st.mtimeNs : BigInt(Math.round(Number(st.mtimeMs) * 1e6));
  const ticks = ns / 100n + UNIX_EPOCH_TICKS;
  return String(st.size) + '|' + String(ticks);
}

function fileStampFast(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fileStamp(p);
  } catch (_) { return null; }
}

function statePath(sandbox, name) {
  return path.join(sandbox, STATE_DIR, name);
}

function resolveStatePath(sandbox, name) {
  const p = statePath(sandbox, name);
  if (fs.existsSync(p)) return p;
  const legacy = path.join(sandbox, name);
  if (fs.existsSync(legacy)) return legacy;
  return p;
}

function readJsonMap(sandbox, name) {
  const p = resolveStatePath(sandbox, name);
  const map = Object.create(null);
  if (!fs.existsSync(p)) return map;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const k of Object.keys(obj || {})) map[normRel(k)] = String(obj[k]);
  } catch (_) { /* ignore */ }
  return map;
}

function saveJsonMap(sandbox, name, map) {
  const ordered = {};
  Object.keys(map).sort().forEach((k) => { ordered[slashRel(k)] = map[k]; });
  const dir = path.join(sandbox, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(sandbox, name), JSON.stringify(ordered, null, 2), 'utf8');
}

function readMeta(sandbox) {
  const p = resolveStatePath(sandbox, META);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function saveMeta(sandbox, meta) {
  const dir = path.join(sandbox, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(sandbox, META), JSON.stringify(meta, null, 2), 'utf8');
}

function stripJsonc(text) {
  let t = String(text || '');
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  t = t.replace(/^\s*\/\/.*$/gm, '');
  t = t.replace(/\s+\/\/.*$/gm, '');
  t = t.replace(/,(\s*[}\]])/g, '$1');
  return t.trim();
}

function readSyncConfig(sandbox) {
  const cfg = { syncAll: false, verifyAll: false };
  const p = path.join(sandbox, STATE_DIR, 'sync.jsonc');
  if (!fs.existsSync(p)) return cfg;
  try {
    const obj = JSON.parse(stripJsonc(fs.readFileSync(p, 'utf8')));
    if (obj && typeof obj.syncAll === 'boolean') cfg.syncAll = obj.syncAll;
    if (obj && typeof obj.verifyAll === 'boolean') cfg.verifyAll = obj.verifyAll;
  } catch (_) { /* defaults */ }
  return cfg;
}

function writeBytesAtomic(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const dir = path.dirname(dest);
  const leaf = path.basename(dest);
  const tmp = path.join(dir, '.' + leaf + '.zkz_tmp');
  const bak = path.join(dir, '.' + leaf + '.zkz_bak');
  fs.writeFileSync(tmp, bytes);
  if (fs.existsSync(dest)) {
    try { fs.unlinkSync(bak); } catch (_) { /* ignore */ }
    fs.renameSync(dest, bak);
    try { fs.renameSync(tmp, dest); }
    catch (e) {
      try { fs.renameSync(bak, dest); } catch (_) { /* ignore */ }
      throw e;
    }
    try { fs.unlinkSync(bak); } catch (_) { /* ignore */ }
  } else {
    fs.renameSync(tmp, dest);
  }
}

function contentEqual(src, dst) {
  if (!fs.existsSync(dst) || !fs.statSync(dst).isFile()) return false;
  const srcBytes = fs.readFileSync(src);
  const dstBytes = fs.readFileSync(dst);
  if (!isNoTranscode(src) && !isNoTranscode(dst)) {
    if (isTextFile(src) && !looksBinary(srcBytes) && !looksBinary(dstBytes)) {
      return bytesToUtf8Text(srcBytes) === bytesToUtf8Text(dstBytes);
    }
  }
  return Buffer.compare(srcBytes, dstBytes) === 0;
}

function copyTranscoded(src, dst, direction, writeBackKind) {
  const bytes = fs.readFileSync(src);
  if (isNoTranscode(src) || isNoTranscode(dst)) return 'skipped';
  const isText = isSyncCopyFile(src) && !looksBinary(bytes);
  if (!isText) return 'skipped';
  if (direction === 'ToUtf8') {
    const kind = getTextEncodingKind(bytes);
    if (kind === 'Utf8' || kind === 'Utf8Bom' || kind === 'Ascii') {
      writeBytesAtomic(dst, bytes);
      return 'keep-' + kind.toLowerCase();
    }
    writeBytesAtomic(dst, encodeTextByKind(bytesToUtf8Text(bytes), 'Utf8'));
    return 'to-utf8';
  }
  const text = bytesToUtf8Text(bytes);
  const target = writeBackKind || 'Gbk';
  writeBytesAtomic(dst, encodeTextByKind(text, target));
  if (!contentEqual(src, dst)) throw new Error('Write did not persist: ' + dst);
  if (target === 'Utf8' || target === 'Utf8Bom' || target === 'Ascii') return 'to-' + target.toLowerCase();
  return 'to-gbk';
}

function resolveWriteBack(rel, encMap, destPath) {
  const n = normRel(rel);
  if (encMap[n]) return encMap[n];
  if (encMap[slashRel(n)]) return encMap[slashRel(n)];
  if (destPath && fs.existsSync(destPath)) {
    const b = fs.readFileSync(destPath);
    if (!looksBinary(b)) return getTextEncodingKind(b);
  }
  return 'Gbk';
}

function stampLookup(map, rel) {
  const n = normRel(rel);
  if (Object.prototype.hasOwnProperty.call(map, n)) return map[n];
  if (Object.prototype.hasOwnProperty.call(map, slashRel(n))) return map[slashRel(n)];
  return undefined;
}

function selectToUtf8Diff(w1, sandbox, files, prevSrc, prevDst) {
  const out = [];
  let skipped = 0;
  for (const rel of files) {
    const srcStamp = fileStampFast(joinRoot(w1, rel));
    if (srcStamp == null) continue;
    const prev = stampLookup(prevSrc, rel);
    if (prev === srcStamp) {
      const dstStamp = fileStampFast(joinRoot(sandbox, rel));
      if (dstStamp != null && stampLookup(prevDst, rel) === dstStamp) {
        skipped++;
        continue;
      }
    }
    out.push(rel);
  }
  return { files: out, skipped };
}

function selectFromUtf8Diff(sandbox, files, prevDst) {
  const out = [];
  let skipped = 0;
  for (const rel of files) {
    const st = fileStampFast(joinRoot(sandbox, rel));
    if (st == null) continue;
    if (stampLookup(prevDst, rel) === st) { skipped++; continue; }
    out.push(rel);
  }
  return { files: out, skipped };
}

function bump(stats, key) { stats[key] = (stats[key] || 0) + 1; }

function copyToUtf8Pass(w1, sandbox, files, prevSrc, prevDst, prevEnc, full, token, log) {
  const stats = { 'to-utf8': 0, skipped: 0, unchanged: 0, deleted: 0, 'keep-utf8': 0, 'keep-utf8bom': 0, 'keep-ascii': 0 };
  const encMap = Object.assign(Object.create(null), prevEnc);
  const stampMap = Object.assign(Object.create(null), prevSrc);
  const destMap = Object.assign(Object.create(null), prevDst);
  for (const rel of files) {
    throwIfCancelled(token);
    const src = joinRoot(w1, rel);
    const dst = joinRoot(sandbox, rel);
    try {
      const stamp = fileStamp(src);
      stampMap[normRel(rel)] = stamp;
      let need = full || stampLookup(prevSrc, rel) !== stamp || !fs.existsSync(dst);
      if (!need) {
        const dstStamp = fileStamp(dst);
        let destOk = true;
        if (isSyncCopyFile(rel)) {
          const probe = fs.readFileSync(dst);
          if (!looksBinary(probe) && getTextEncodingKind(probe) === 'Gbk') destOk = false;
        }
        if (!destOk) need = true;
        else if (stampLookup(prevDst, rel) === dstStamp) {
          destMap[normRel(rel)] = dstStamp;
          bump(stats, 'unchanged');
          if (stampLookup(prevEnc, rel) != null) encMap[normRel(rel)] = stampLookup(prevEnc, rel);
          else encMap[normRel(rel)] = 'Ascii';
          continue;
        } else if (contentEqual(src, dst)) {
          destMap[normRel(rel)] = dstStamp;
          bump(stats, 'unchanged');
          if (stampLookup(prevEnc, rel) != null) encMap[normRel(rel)] = stampLookup(prevEnc, rel);
          else encMap[normRel(rel)] = 'Ascii';
          continue;
        } else need = true;
      }
      const srcBytes = fs.readFileSync(src);
      if (isNoTranscode(rel) || !(isTextFile(src) && !looksBinary(srcBytes))) encMap[normRel(rel)] = 'Binary';
      else encMap[normRel(rel)] = getTextEncodingKind(srcBytes);
      const action = copyTranscoded(src, dst, 'ToUtf8');
      bump(stats, action);
      if (log && action !== 'skipped') log('  ' + action + ' [' + encMap[normRel(rel)] + ']: ' + rel);
      if (fs.existsSync(dst)) destMap[normRel(rel)] = fileStamp(dst);
    } catch (e) {
      bump(stats, 'skipped');
      if (log) log('Skip ' + rel + ': ' + (e && e.message ? e.message : e));
    }
  }
  return { stats, stampMap, destStampMap: destMap, encodingMap: encMap };
}

function copyFromUtf8Pass(w1, sandbox, files, encMap, prevSrc, prevDst, all, token, log) {
  const stats = { 'to-gbk': 0, unchanged: 0, 'skipped-w1': 0, 'to-utf8': 0, 'to-utf8bom': 0, 'to-ascii': 0 };
  const written = [];
  const srcMap = Object.assign(Object.create(null), prevSrc);
  const destMap = Object.assign(Object.create(null), prevDst);
  let stampsDirty = false;
  for (const rel of files) {
    throwIfCancelled(token);
    const src = joinRoot(sandbox, rel);
    const dst = joinRoot(w1, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    try {
      const sandboxStamp = fileStamp(src);
      const dstExists = fs.existsSync(dst) && fs.statSync(dst).isFile();
      const w1Stamp = dstExists ? fileStamp(dst) : '';
      const sandboxUnchanged = stampLookup(prevDst, rel) === sandboxStamp;
      const w1Unchanged = dstExists && stampLookup(prevSrc, rel) === w1Stamp;
      if (!all && sandboxUnchanged && w1Unchanged) {
        destMap[normRel(rel)] = sandboxStamp;
        srcMap[normRel(rel)] = w1Stamp;
        bump(stats, 'unchanged');
        continue;
      }
      if (!all && sandboxUnchanged && dstExists && !w1Unchanged) {
        destMap[normRel(rel)] = sandboxStamp;
        if (Object.prototype.hasOwnProperty.call(srcMap, normRel(rel))) {
          delete srcMap[normRel(rel)];
          stampsDirty = true;
        }
        bump(stats, 'skipped-w1');
        if (log) log('  skip-w1 (true source changed): ' + rel);
        continue;
      }
      if (dstExists && contentEqual(src, dst)) {
        destMap[normRel(rel)] = sandboxStamp;
        srcMap[normRel(rel)] = w1Stamp;
        stampsDirty = true;
        bump(stats, 'unchanged');
        continue;
      }
      const writeEnc = resolveWriteBack(rel, encMap, dst);
      const action = copyTranscoded(src, dst, 'ToGbk', writeEnc);
      bump(stats, action);
      written.push(rel);
      if (log) log('  ' + action + ' [' + writeEnc + ']: ' + rel);
      destMap[normRel(rel)] = fileStamp(src);
      if (fs.existsSync(dst)) srcMap[normRel(rel)] = fileStamp(dst);
      stampsDirty = true;
    } catch (e) {
      if (log) log('Skip ' + rel + ': ' + (e && e.message ? e.message : e));
    }
  }
  return { stats, srcStampMap: srcMap, destStampMap: destMap, written, stampsDirty };
}

function pruneMaps(w1, sandbox, stampMap, destMap, encMap) {
  let srcR = 0, dstR = 0, encR = 0;
  for (const k of Object.keys(stampMap)) {
    if (!fs.existsSync(joinRoot(w1, k))) { delete stampMap[k]; srcR++; }
  }
  for (const k of Object.keys(destMap)) {
    if (!fs.existsSync(joinRoot(sandbox, k))) { delete destMap[k]; dstR++; }
  }
  for (const k of Object.keys(encMap)) {
    if (!fs.existsSync(joinRoot(w1, k)) && !fs.existsSync(joinRoot(sandbox, k))) {
      delete encMap[k]; encR++;
    }
  }
  return { total: srcR + dstR + encR, srcR, dstR, encR };
}

function mergeSkipped(prevSrc, prevDst, prevEnc, stampMap, destMap, encMap, keepLib) {
  const keep = (rel) => keepLib ? isLibraryRel(rel) : !isLibraryRel(rel);
  for (const k of Object.keys(prevSrc)) if (keep(k)) stampMap[k] = prevSrc[k];
  for (const k of Object.keys(prevDst)) if (keep(k)) destMap[k] = prevDst[k];
  for (const k of Object.keys(prevEnc)) if (keep(k)) encMap[k] = prevEnc[k];
}

function removeTree(p) {
  if (!fs.existsSync(p)) return;
  if (isReparse(p)) { try { fs.rmdirSync(p); } catch (_) { fs.rmSync(p, { recursive: true, force: true }); } return; }
  fs.rmSync(p, { recursive: true, force: true });
}

function prepareSandbox(sandbox, activeSpecs, copyDirs, full, log) {
  if (!fs.existsSync(sandbox)) return;
  for (const spec of activeSpecs) {
    const dst = path.join(sandbox, spec);
    if (fs.existsSync(dst) && isReparse(dst)) {
      if (log) log('Unlink former junction: ' + spec);
      try { fs.rmdirSync(dst); } catch (_) { /* ignore */ }
    }
  }
  const proj = path.join(sandbox, 'Project');
  if (fs.existsSync(proj)) {
    if (log) log('Remove sandbox Project (W1-only)');
    removeTree(proj);
  }
  const keep = {};
  for (const n of copyDirs) keep[n.toLowerCase()] = true;
  for (const n of (lists().libraryDirNames || [])) keep[String(n).toLowerCase()] = true;
  keep.zkz = true;
  let ents = [];
  try { ents = fs.readdirSync(sandbox, { withFileTypes: true }); } catch (_) { ents = []; }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    if (isSkipTopDir(ent.name)) continue;
    if (keep[ent.name.toLowerCase()]) continue;
    if (log) log('Remove stale sandbox top: ' + ent.name);
    removeTree(path.join(sandbox, ent.name));
  }
  if (full) {
    if (log) log('FULL: wipe copy trees');
    for (const spec of activeSpecs) removeTree(path.join(sandbox, spec));
  }
}

function removeOrphans(sandbox, specs, srcSet, stats, log) {
  const dstFiles = filesUnderSpecs(sandbox, specs, false);
  let deleted = 0;
  for (const rel of dstFiles) {
    const key = normRel(rel).toLowerCase();
    if (srcSet[key]) continue;
    try {
      fs.unlinkSync(joinRoot(sandbox, rel));
      deleted++;
    } catch (e) {
      if (log) log('Delete failed ' + rel + ': ' + (e && e.message ? e.message : e));
    }
  }
  stats.deleted = (stats.deleted || 0) + deleted;
  return deleted;
}

function gitInfo(repo) {
  return new Promise((resolve) => {
    const info = { branch: '', commit: '', dirty: false };
    if (!fs.existsSync(path.join(repo, '.git'))) return resolve(info);
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, windowsHide: true }, (e1, b) => {
      if (!e1) info.branch = String(b || '').trim();
      execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, windowsHide: true }, (e2, c) => {
        if (!e2) info.commit = String(c || '').trim();
        execFile('git', ['status', '--porcelain'], { cwd: repo, windowsHide: true }, (e3, s) => {
          info.dirty = !e3 && String(s || '').trim().length > 0;
          resolve(info);
        });
      });
    });
  });
}

function uvprojStamp(root) {
  let p = path.join(root, 'Project', 'MDK-ARM(uV4)', 'b_01.uvproj');
  if (!fs.existsSync(p)) p = path.join(root, 'Project', 'MDK-ARM(uV4)', 'b_01.uvprojx');
  if (!fs.existsSync(p)) {
    const h = path.join(root, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
    if (fs.existsSync(h)) p = h;
  }
  return fs.existsSync(p) ? fileStamp(p) : '';
}

function isoNow() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function isSeededLib(sandbox, name) {
  const abs = path.join(sandbox, name);
  if (!fs.existsSync(abs)) return false;
  try { if (isReparse(abs)) return false; } catch (_) { return false; }
  return true;
}

async function runToUtf8(opts) {
  const w1 = opts.w1;
  const sandbox = opts.sandbox || getUtf8Path(w1);
  const log = opts.log || (() => { });
  const token = opts.token;
  const full = !!opts.full;
  const syncLibs = !!opts.syncLibs;
  const includeLibs = !!opts.includeLibs;
  const changedOnly = !!opts.changedOnly;
  const libsOnly = syncLibs && !full && !includeLibs;
  const bizAndLibs = includeLibs && !full;
  throwIfCancelled(token);

  if (!fs.existsSync(sandbox)) fs.mkdirSync(sandbox, { recursive: true });
  const plan = resolvePlan(w1);
  const libSpecs = librarySpecs(plan.copyDirs);
  const bizSpecs = businessSpecs(plan.copyDirs);
  let active = bizSpecs;
  if (full || bizAndLibs) active = plan.copyDirs.slice();
  else if (libsOnly) active = libSpecs;
  log('ToUtf W1=' + w1);
  log('ToUtf U=' + sandbox);
  log('copy: ' + (active.join(', ') || '(none)'));
  prepareSandbox(sandbox, active, plan.copyDirs, full, log);

  const prevSrc = full ? Object.create(null) : readJsonMap(sandbox, SRC_STAMP);
  const prevDst = full ? Object.create(null) : readJsonMap(sandbox, DST_STAMP);
  const prevEnc = full ? Object.create(null) : readJsonMap(sandbox, ENC_MAP);
  const files = filesUnderSpecs(w1, active, true);
  const srcSet = Object.create(null);
  for (const f of files) srcSet[normRel(f).toLowerCase()] = true;
  log('Sync files: ' + files.length);
  let filesForCopy = files;
  let stampSkipped = 0;
  if (changedOnly && !full) {
    const sel = selectToUtf8Diff(w1, sandbox, files, prevSrc, prevDst);
    stampSkipped = sel.skipped;
    filesForCopy = sel.files;
    log('Stamp prefilter: ' + filesForCopy.length + ' to check, ' + stampSkipped + ' skipped');
  }
  const pass = copyToUtf8Pass(w1, sandbox, filesForCopy, prevSrc, prevDst, prevEnc, full, token, log);
  if (stampSkipped) pass.stats.unchanged = (pass.stats.unchanged || 0) + stampSkipped;
  if (libsOnly) mergeSkipped(prevSrc, prevDst, prevEnc, pass.stampMap, pass.destStampMap, pass.encodingMap, false);
  else if (!(full || syncLibs || includeLibs)) mergeSkipped(prevSrc, prevDst, prevEnc, pass.stampMap, pass.destStampMap, pass.encodingMap, true);
  if (!full) removeOrphans(sandbox, active, srcSet, pass.stats, log);
  pruneMaps(w1, sandbox, pass.stampMap, pass.destStampMap, pass.encodingMap);
  saveJsonMap(sandbox, ENC_MAP, pass.encodingMap);
  saveJsonMap(sandbox, SRC_STAMP, pass.stampMap);
  saveJsonMap(sandbox, DST_STAMP, pass.destStampMap);

  const git = await gitInfo(w1);
  const prevMeta = readMeta(sandbox) || {};
  const meta = {
    sourceRoot: w1,
    sourceCommit: git.commit,
    uvprojStamp: uvprojStamp(w1),
    syncedAt: isoNow()
  };
  if (prevMeta.lastFromUtf8At) meta.lastFromUtf8At = prevMeta.lastFromUtf8At;
  if (prevMeta.lastFromUtf8Files) meta.lastFromUtf8Files = prevMeta.lastFromUtf8Files;
  if (prevMeta.libsSyncedAt) meta.libsSyncedAt = prevMeta.libsSyncedAt;
  if (full || syncLibs || includeLibs) meta.libsSyncedAt = isoNow();
  saveMeta(sandbox, meta);
  log(
    'Done ToUtf to-utf8=' + (pass.stats['to-utf8'] || 0) +
    ' keep-utf8=' + (pass.stats['keep-utf8'] || 0) +
    ' unchanged=' + (pass.stats.unchanged || 0) +
    ' skipped=' + (pass.stats.skipped || 0)
  );
  return pass.stats;
}

async function runFromUtf8(opts) {
  const w1 = opts.w1;
  const sandbox = opts.sandbox || getUtf8Path(w1);
  const log = opts.log || (() => { });
  const token = opts.token;
  const force = !!opts.force;
  const all = !!opts.all;
  const syncLibs = !!opts.syncLibs;
  const includeLibs = !!opts.includeLibs;
  const changedOnly = !!opts.changedOnly;
  const libsOnly = syncLibs && !includeLibs;
  throwIfCancelled(token);
  if (!fs.existsSync(sandbox)) throw new Error('UTF-8 sandbox not found: ' + sandbox);

  const meta = readMeta(sandbox);
  if (meta && meta.sourceRoot && meta.sourceRoot !== w1 && !force) {
    throw new Error('Meta sourceRoot mismatch.\n  meta: ' + meta.sourceRoot + '\n  now:  ' + w1 + '\nUse Force to override.');
  }
  const git = await gitInfo(w1);
  if (meta && meta.sourceCommit && git.commit && meta.sourceCommit !== git.commit && !force) {
    throw new Error('W1 HEAD (' + git.commit + ') != sync sourceCommit (' + meta.sourceCommit + '). Switch/restore branch, or Force.');
  }

  const plan = resolvePlan(w1);
  const libSpecsAll = librarySpecs(plan.copyDirs);
  let fromSpecs;
  if (libsOnly) fromSpecs = libSpecsAll.filter((n) => isSeededLib(sandbox, n));
  else if (includeLibs) fromSpecs = businessSpecs(plan.copyDirs).concat(libSpecsAll.filter((n) => isSeededLib(sandbox, n)));
  else fromSpecs = businessSpecs(plan.copyDirs);
  log('ToGb W1=' + w1);
  log('ToGb specs: ' + (fromSpecs.join(', ') || '(none)'));

  const encMap = readJsonMap(sandbox, ENC_MAP);
  const prevSrc = readJsonMap(sandbox, SRC_STAMP);
  const prevDst = readJsonMap(sandbox, DST_STAMP);
  let relFiles = filesUnderSpecs(sandbox, fromSpecs, true);
  log('Candidates: ' + relFiles.length);
  if (!relFiles.length) return { unchanged: 0 };
  if (changedOnly && !all) {
    const sel = selectFromUtf8Diff(sandbox, relFiles, prevDst);
    log('Stamp prefilter: ' + sel.files.length + ' to check, ' + sel.skipped + ' skipped');
    relFiles = sel.files;
    if (!relFiles.length) {
      pruneMaps(w1, sandbox, prevSrc, prevDst, encMap);
      saveJsonMap(sandbox, SRC_STAMP, prevSrc);
      saveJsonMap(sandbox, DST_STAMP, prevDst);
      saveJsonMap(sandbox, ENC_MAP, encMap);
      return { unchanged: sel.skipped };
    }
  }
  const pass = copyFromUtf8Pass(w1, sandbox, relFiles, encMap, prevSrc, prevDst, all, token, log);
  const prune = pruneMaps(w1, sandbox, pass.srcStampMap, pass.destStampMap, encMap);
  if (prune.total) pass.stampsDirty = true;
  if (pass.stampsDirty) {
    saveJsonMap(sandbox, SRC_STAMP, pass.srcStampMap);
    saveJsonMap(sandbox, DST_STAMP, pass.destStampMap);
    if (prune.encR) saveJsonMap(sandbox, ENC_MAP, encMap);
  }
  if (pass.written.length || pass.stampsDirty) {
    const m = readMeta(sandbox) || {};
    m.lastFromUtf8At = isoNow();
    m.lastFromUtf8Files = pass.written;
    saveMeta(sandbox, m);
  }
  log(
    'Done ToGb to-gbk=' + (pass.stats['to-gbk'] || 0) +
    ' unchanged=' + (pass.stats.unchanged || 0) +
    ' skipped-w1=' + (pass.stats['skipped-w1'] || 0)
  );
  return pass.stats;
}

async function runKind(kind, w1, sandbox, token, log) {
  const cfg = readSyncConfig(sandbox);
  const common = { w1, sandbox, token, log, force: true };
  if (kind === 'toUtf') {
    return runToUtf8(Object.assign({}, common, {
      changedOnly: true,
      includeLibs: !!cfg.syncAll
    }));
  }
  if (kind === 'toGb') {
    return runFromUtf8(Object.assign({}, common, {
      changedOnly: !cfg.verifyAll,
      all: !!cfg.verifyAll,
      includeLibs: !!cfg.syncAll
    }));
  }
  if (kind === 'toUtfAll') return runToUtf8(common);
  if (kind === 'toUtfLibs') return runToUtf8(Object.assign({}, common, { syncLibs: true }));
  if (kind === 'toUtfFull') return runToUtf8(Object.assign({}, common, { full: true }));
  if (kind === 'toGbAll') return runFromUtf8(Object.assign({}, common, { all: true }));
  if (kind === 'toGbLibs') return runFromUtf8(Object.assign({}, common, { syncLibs: true, changedOnly: true }));
  throw new Error('unknown sync kind: ' + kind);
}

async function runDaily(action, w1, sandbox, token, log) {
  return runKind(action === 'Push' ? 'toGb' : 'toUtf', w1, sandbox, token, log);
}

module.exports = { runKind, runDaily, runToUtf8, runFromUtf8, readSyncConfig, readMeta };
