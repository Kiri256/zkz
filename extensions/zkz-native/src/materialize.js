'use strict';

const fs = require('fs');
const path = require('path');
const { git, gitText, listSourceFiles, catFileBatchSync } = require('./git_exec');
const { loadTable } = require('./enc_table');
const { slashRel, isLibRel } = require('./paths');
const { detectKind, parseMapped } = require('./encoding');
const { smudge } = require('./filter_core');

function diskNeedsSmudge(mappedKind, diskKind) {
  if (mappedKind === 'Gbk' && diskKind === 'Gbk') return true;
  if (mappedKind === 'Utf8Bom' && diskKind === 'Utf8Bom') return true;
  return false;
}

function diskIsLeftover(kind, disk) {
  if (kind === 'Gbk' && (disk === 'Utf8' || disk === 'Utf8Bom')) return true;
  if (kind === 'Utf8Bom' && disk !== 'Utf8Bom') return true;
  return false;
}

/** 非库、已映射的源码。needSmudge：磁盘仍是原编码；leftover：磁盘已是 UTF-8、disable 没写回去。 */
function scanMapped(repoRoot, opts) {
  const o = opts || {};
  const table = loadTable(repoRoot);
  const kinds = o.kinds || ['Gbk', 'Utf8Bom'];
  const want = Object.create(null);
  for (let i = 0; i < kinds.length; i++) want[kinds[i]] = true;
  const needSmudge = !!o.needSmudge;
  const leftover = !!o.leftover && !needSmudge;
  const rels = [];
  const files = listSourceFiles(repoRoot);
  for (let i = 0; i < files.length; i++) {
    const rel = slashRel(files[i]);
    if (isLibRel(repoRoot, rel)) continue;
    const kind = parseMapped(table[rel]).kind;
    if (!want[kind]) continue;
    if (!needSmudge && !leftover) {
      rels.push(rel);
      continue;
    }
    let buf;
    try { buf = fs.readFileSync(path.join(repoRoot, rel)); } catch (_) { continue; }
    const disk = detectKind(buf);
    if (needSmudge && !diskNeedsSmudge(kind, disk)) continue;
    if (leftover && !diskIsLeftover(kind, disk)) continue;
    rels.push(rel);
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

function indexOids(repoRoot, rels) {
  const map = new Map();
  const chunk = 60;
  for (let i = 0; i < rels.length; i += chunk) {
    const slice = rels.slice(i, i + chunk);
    const r = git(repoRoot, ['ls-files', '-s', '-z', '--'].concat(slice), {
      allowFail: true,
      encoding: 'buffer'
    });
    const buf = r.stdout;
    if (!buf || !buf.length) continue;
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    const parts = text.split('\0');
    for (let j = 0; j < parts.length; j++) {
      const rec = parts[j];
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const oid = String(rec.slice(0, tab).split(' ')[1] || '').toLowerCase();
      const p = slashRel(rec.slice(tab + 1));
      if (p && oid) map.set(p, oid);
    }
  }
  return map;
}

/** 按路径跑 clean，得到将要入库的 blob。失败返回 null，调用方退回整批 git add。 */
function cleanOids(repoRoot, rels) {
  const map = new Map();
  const chunk = 20;
  for (let i = 0; i < rels.length; i += chunk) {
    const slice = rels.slice(i, i + chunk);
    const r = git(repoRoot, ['hash-object', '--'].concat(slice), { allowFail: true });
    if (r.status !== 0) return null;
    const lines = String(r.stdout || '').replace(/\r\n/g, '\n').split('\n').filter(Boolean);
    if (lines.length < slice.length) return null;
    for (let j = 0; j < slice.length; j++) map.set(slice[j], lines[j].trim().toLowerCase());
  }
  return map;
}

function splitStable(repoRoot, rels) {
  const index = indexOids(repoRoot, rels);
  const cleaned = cleanOids(repoRoot, rels);
  if (!cleaned) return null;
  const stable = [];
  const unstable = [];
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i];
    const got = cleaned.get(rel) || '';
    const want = index.get(rel) || '';
    if (got && want && got === want) stable.push(rel);
    else unstable.push(rel);
  }
  return { stable: stable, unstable: unstable };
}

function dirtySet(repoRoot, rels) {
  const dirtyOut = gitText(repoRoot, ['diff', '--name-only', '-z', '--'].concat(rels), { allowFail: true });
  return new Set(String(dirtyOut || '').split('\0').map(slashRel).filter(Boolean));
}

/** 把仍是原编码、且相对索引没有内容改动的文件写成 UTF-8，再只对能往返的文件刷新索引 stat。 */
function smudgeWorktree(repoRoot) {
  const stale = scanMapped(repoRoot, { kinds: ['Gbk', 'Utf8Bom'], needSmudge: true });
  if (!stale.length) return { wrote: 0, unstable: [] };
  const dirty = dirtySet(repoRoot, stale);
  const todo = [];
  for (let i = 0; i < stale.length; i++) {
    if (!dirty.has(stale[i])) todo.push(stale[i]);
  }
  if (!todo.length) return { wrote: 0, unstable: [] };
  const table = loadTable(repoRoot);
  const wrote = [];
  const chunk = 80;
  for (let i = 0; i < todo.length; i += chunk) {
    const slice = todo.slice(i, i + chunk);
    const blobs = catFileBatchSync(repoRoot, slice.map((rel) => ':' + rel));
    for (let j = 0; j < slice.length; j++) {
      const rec = blobs[j];
      if (!rec || rec.missing) continue;
      const out = smudge(slice[j], rec.data, table, repoRoot);
      try {
        fs.writeFileSync(path.join(repoRoot, slice[j]), out);
        wrote.push(slice[j]);
      } catch (_) { /* 编辑器锁住时跳过 */ }
    }
  }
  if (!wrote.length) return { wrote: 0, unstable: [] };
  // 先比对再 add：add 会把对不上的 clean 结果写进索引，比对就失真。
  const split = splitStable(repoRoot, wrote);
  if (!split) {
    gitAddChunks(repoRoot, wrote);
    return { wrote: wrote.length, unstable: [] };
  }
  gitAddChunks(repoRoot, split.stable);
  return { wrote: wrote.length, unstable: split.unstable };
}

function resmudgeStale(repoRoot) {
  return smudgeWorktree(repoRoot).wrote;
}

/** disable 后按 HEAD 写回原编码。一次 cat-file 批量读，按 autocrlf 补 CRLF，再 add 对齐索引。 */
function restoreOriginalStale(repoRoot) {
  const rels = scanMapped(repoRoot, { kinds: ['Gbk', 'Utf8Bom'] });
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
    leftover: scanMapped(repoRoot, { kinds: ['Gbk', 'Utf8Bom'], leftover: true })
  };
}

module.exports = {
  diskNeedsSmudge,
  scanMapped,
  worktreeBytes,
  smudgeWorktree,
  resmudgeStale,
  restoreOriginalStale
};
