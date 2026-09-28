'use strict';

const fs = require('fs');
const path = require('path');
const { isWorktreeClean, git, gitText, listSourceFiles, currentHead, readHeadName, catFileBatchSync } = require('./git_exec');
const { buildTable, loadTable, loadMeta, countByKind, noteTableRef } = require('./enc_table');
const { installGitConfig, uninstallGitConfig, isInstalled } = require('./git_config');
const { installHooks, uninstallHooks } = require('./hooks');
const { applySkipWorktree, clearSkipWorktree } = require('./config_freeze');
const { slashRel, isLibRel, atomicWriteJson, nativeStatusPath, ensureZkz } = require('./paths');
const { detectKind, parseMapped } = require('./encoding');
const { loadRoundtripFailures, loadFilterFail } = require('./observe');
const { loadLibWarnings, libWarningsNotified } = require('./lib_encoding');

function diskNeedsSmudge(mappedKind, diskKind) {
  if (mappedKind === 'Gbk' && diskKind === 'Gbk') return true;
  if (mappedKind === 'Utf8Bom' && diskKind === 'Utf8Bom') return true;
  return false;
}

function resmudgeStale(repoRoot) {
  const table = loadTable(repoRoot);
  const stale = [];
  for (const rel of listSourceFiles(repoRoot).map(slashRel)) {
    if (isLibRel(repoRoot, rel)) continue;
    const kind = parseMapped(table[rel]).kind;
    if (kind !== 'Gbk' && kind !== 'Utf8Bom') continue;
    const abs = path.join(repoRoot, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { continue; }
    if (diskNeedsSmudge(kind, detectKind(buf))) stale.push(rel);
  }
  if (!stale.length) return 0;
  // 索引 stat 已对齐时 checkout-index -f 不会重跑 smudge，GBK 会留在工作区。
  const dirtyOut = gitText(repoRoot, ['diff', '--name-only', '--'].concat(stale), { allowFail: true });
  const dirty = new Set(String(dirtyOut || '').split('\n').map(slashRel).filter(Boolean));
  const todo = stale.filter((rel) => !dirty.has(rel));
  if (!todo.length) return 0;
  const { smudge } = require('./filter_core');
  const chunk = 80;
  let wrote = 0;
  for (let i = 0; i < todo.length; i += chunk) {
    const slice = todo.slice(i, i + chunk);
    const blobs = catFileBatchSync(repoRoot, slice.map((rel) => ':' + rel));
    for (let j = 0; j < slice.length; j++) {
      const rec = blobs[j];
      if (!rec || rec.missing) continue;
      const out = smudge(slice[j], rec.data, table, repoRoot);
      try {
        fs.writeFileSync(path.join(repoRoot, slice[j]), out);
        wrote += 1;
      } catch (_) { /* 编辑器锁住时跳过 */ }
    }
  }
  if (wrote) {
    // stat 仍是旧 GBK 大小时，status 会把已对齐的 UTF-8 标成修改。add 只刷新索引记录，内容哈希不变。
    git(repoRoot, ['add', '--'].concat(todo), { allowFail: true });
  }
  return wrote;
}

function tableDrift(repoRoot) {
  const meta = loadMeta(repoRoot);
  if (!meta) return false;
  if (!meta.ref) {
    noteTableRef(repoRoot, meta);
    return false;
  }
  const name = readHeadName(repoRoot);
  return !!(name && meta.ref !== name);
}

function statusSnapshot(repoRoot) {
  const installed = isInstalled(repoRoot);
  const files = loadTable(repoRoot);
  const n = Object.keys(files).length;
  let unstable = [];
  try {
    const p = nativeStatusPath(repoRoot);
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(obj.unstable)) unstable = obj.unstable;
    }
  } catch (_) { /* ignore */ }
  const roundtripFails = loadRoundtripFailures(repoRoot);
  const ff = loadFilterFail(repoRoot);
  return {
    installed: installed,
    tableCount: n,
    counts: countByKind(files),
    unstable: unstable,
    roundtripFails: roundtripFails.map((x) => x.rel),
    tableDrift: tableDrift(repoRoot),
    filterFails: ff.count,
    filterFailLast: ff.last,
    filterFailNotified: ff.notified,
    libWarnings: loadLibWarnings(repoRoot),
    libWarningsNotified: libWarningsNotified(repoRoot)
  };
}

async function enable(repoRoot, extensionRoot, opts) {
  const force = !!(opts && opts.force);
  if (!force && !isWorktreeClean(repoRoot)) {
    const err = new Error('工作区不干净，请先提交或暂存后再启用 zkz-native');
    err.code = 'ZKZ_DIRTY';
    throw err;
  }
  const built = await buildTable(repoRoot);
  installGitConfig(repoRoot, extensionRoot);
  installHooks(repoRoot, extensionRoot);
  applySkipWorktree(repoRoot, { force: true });
  // checkout -- . 会跳过「stat 已与 index 一致」的旧 GBK 文件，必须强制写出才会跑 smudge
  git(repoRoot, ['checkout-index', '-f', '-a'], { allowFail: true });
  resmudgeStale(repoRoot);
  git(repoRoot, ['add', '--renormalize', '.'], { allowFail: true });
  const status = gitText(repoRoot, ['status', '--porcelain'], { allowFail: true });
  const unstable = String(status || '').split('\n').map((s) => s.trim()).filter(Boolean);
  git(repoRoot, ['reset', 'HEAD'], { allowFail: true });
  try {
    const { formatLocalNow } = require('./paths');
    ensureZkz(repoRoot);
    atomicWriteJson(nativeStatusPath(repoRoot), {
      unstable: unstable,
      at: formatLocalNow()
    });
  } catch (_) { /* ignore */ }
  return {
    installed: true,
    tableCount: Object.keys(built.files).length,
    counts: built.counts,
    unstable: unstable
  };
}


function listMappedRels(repoRoot, kinds) {
  const table = loadTable(repoRoot);
  const want = Object.create(null);
  for (let i = 0; i < kinds.length; i++) want[kinds[i]] = true;
  const rels = [];
  for (const rel of listSourceFiles(repoRoot).map(slashRel)) {
    if (isLibRel(repoRoot, rel)) continue;
    const kind = parseMapped(table[rel]).kind;
    if (want[kind]) rels.push(rel);
  }
  return rels;
}

function wantsAutocrlf(repoRoot) {
  const v = gitText(repoRoot, ['config', '--get', 'core.autocrlf'], { allowFail: true }).trim().toLowerCase();
  return v === 'true';
}

/** autocrlf=true 时工作区要用 CRLF，否则 status 会把和 blob 相同的 LF 标成修改。blob 里已有 CR 则原样写。 */
function worktreeBytes(blob, autocrlf) {
  const src = blob ? Buffer.from(blob) : Buffer.alloc(0);
  if (!autocrlf || !src.length || src.includes(0x0d)) return src;
  let n = 0;
  for (let i = 0; i < src.length; i++) if (src[i] === 0x0a) n += 1;
  if (!n) return src;
  const out = Buffer.allocUnsafe(src.length + n);
  let j = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x0a) out[j++] = 0x0d;
    out[j++] = src[i];
  }
  return out;
}

function gitAddChunks(repoRoot, rels, prefix) {
  if (!rels || !rels.length) return;
  const chunk = 40;
  const head = prefix || ['add', '--'];
  for (let i = 0; i < rels.length; i += chunk) {
    git(repoRoot, head.concat(rels.slice(i, i + chunk)), { allowFail: true });
  }
}

function listEncodingMismatches(repoRoot) {
  const table = loadTable(repoRoot);
  const stale = [];
  for (const rel of listSourceFiles(repoRoot).map(slashRel)) {
    if (isLibRel(repoRoot, rel)) continue;
    const kind = parseMapped(table[rel]).kind;
    if (kind !== 'Gbk' && kind !== 'Utf8Bom') continue;
    const abs = path.join(repoRoot, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { continue; }
    const disk = detectKind(buf);
    if (kind === 'Gbk' && (disk === 'Utf8' || disk === 'Utf8Bom')) stale.push(rel);
    if (kind === 'Utf8Bom' && disk !== 'Utf8Bom') stale.push(rel);
  }
  return stale;
}

/** disable 后按 HEAD 写回原编码。一次 cat-file 批量读，按 autocrlf 补 CRLF，再 add 对齐索引。 */
function restoreOriginalStale(repoRoot) {
  const rels = listMappedRels(repoRoot, ['Gbk', 'Utf8Bom']);
  if (!rels.length) return { checked: 0, leftover: [] };
  const autocrlf = wantsAutocrlf(repoRoot);
  const wrote = [];
  const statOnly = [];
  const chunk = 80;
  for (let i = 0; i < rels.length; i += chunk) {
    const slice = rels.slice(i, i + chunk);
    const blobs = catFileBatchSync(repoRoot, slice.map((rel) => 'HEAD:' + rel));
    for (let j = 0; j < slice.length; j++) {
      const rec = blobs[j];
      if (!rec || rec.missing) continue;
      const out = worktreeBytes(rec.data, autocrlf);
      const abs = path.join(repoRoot, slice[j]);
      let cur = null;
      try { cur = fs.readFileSync(abs); } catch (_) { cur = null; }
      if (cur && cur.equals(out)) {
        if (cur.equals(Buffer.from(rec.data))) statOnly.push(slice[j]);
        else wrote.push(slice[j]);
        continue;
      }
      try {
        fs.writeFileSync(abs, out);
        wrote.push(slice[j]);
      } catch (_) { /* editor lock */ }
    }
  }
  gitAddChunks(repoRoot, wrote);
  gitAddChunks(repoRoot, statOnly, ['-c', 'core.autocrlf=false', 'add', '--']);
  return {
    checked: rels.length,
    leftover: listEncodingMismatches(repoRoot)
  };
}

function disable(repoRoot) {
  uninstallGitConfig(repoRoot);
  uninstallHooks(repoRoot);
  clearSkipWorktree(repoRoot);
  const r = restoreOriginalStale(repoRoot);
  return { installed: false, restored: r.checked, leftover: r.leftover };
}


async function silentRefresh(repoRoot, opts) {
  const errors = [];
  try { applySkipWorktree(repoRoot); } catch (e) {
    errors.push('skip-worktree: ' + String(e && e.message ? e.message : e));
  }
  try {
    const from = opts && opts.from;
    const to = opts && opts.to;
    await buildTable(repoRoot, (from && to) ? { from: from, to: to } : {});
  } catch (e) {
    errors.push('table: ' + String(e && e.message ? e.message : e));
  }
  return { errors: errors };
}

async function refresh(repoRoot, extensionRoot, opts) {
  const force = !!(opts && opts.force);
  const meta = loadMeta(repoRoot);
  const head = currentHead(repoRoot);
  if (!force && meta && meta.head && meta.head === head) {
    const files = loadTable(repoRoot);
    return {
      installed: isInstalled(repoRoot),
      tableCount: Object.keys(files).length,
      counts: countByKind(files),
      unstable: [],
      skipped: true
    };
  }
  if (extensionRoot) {
    const { verifyGitConfig } = require('./git_config');
    const { verifyHooks } = require('./hooks');
    verifyGitConfig(repoRoot, extensionRoot);
    verifyHooks(repoRoot, extensionRoot);
  }
  if (force) applySkipWorktree(repoRoot, { force: true });
  const built = await buildTable(repoRoot, force
    ? { force: true }
    : { from: meta && meta.head, to: head });
  if (force) resmudgeStale(repoRoot);
  return {
    installed: isInstalled(repoRoot),
    tableCount: Object.keys(built.files).length,
    counts: built.counts,
    unstable: []
  };
}

module.exports = { enable, disable, refresh, silentRefresh, statusSnapshot, resmudgeStale, diskNeedsSmudge, restoreOriginalStale, worktreeBytes, tableDrift };
