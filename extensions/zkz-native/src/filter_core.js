'use strict';

const { slashRel, isLibRel } = require('./paths');
const { detectKind, applySmudge, applyClean, planNewFile, parseMapped, hasNonAscii, hasCrlf, encodeMapped } = require('./encoding');
const { noteNewFile, mappingOf } = require('./enc_table');
const { indexBlobOid, tryCatFileBatch } = require('./git_exec');
const { recordRoundtripFailure, clearRoundtripFailure, recordCp936Drop, clearCp936Drop } = require('./observe');

function lookupKind(table, pathname) {
  if (!table) return null;
  const key = slashRel(pathname);
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  return null;
}

function utfFamily(kind) {
  return kind === 'Utf8' || kind === 'Utf8Bom' || kind === 'Ascii';
}

function reconcileSmudgeKind(actual, hinted) {
  const act = actual || 'Ascii';
  const hint = hinted || '';
  if (act === 'Gbk') return 'Gbk';
  if (hint === 'Gbk' && utfFamily(act)) return act;
  if (act === 'Utf8Bom') return 'Utf8Bom';
  if (utfFamily(act) && utfFamily(hint)) return hint || act;
  return hint || act;
}

function noteCp936Drop(repoRoot, pathname, info) {
  if (!repoRoot || !info) return;
  if (info.count) recordCp936Drop(repoRoot, pathname, info);
  else clearCp936Drop(repoRoot, pathname, info.stage);
}

function remember(table, pathname, mapped) {
  if (table && pathname && mapped) table[slashRel(pathname)] = mapped;
}

function bindMapping(table, repoRoot, pathname, mapped, overwrite) {
  let stored = mapped;
  if (repoRoot && pathname && mapped) {
    stored = noteNewFile(repoRoot, pathname, mapped, overwrite ? { overwrite: true } : undefined) || mapped;
  }
  remember(table, pathname, stored);
  return stored;
}

/** 表里没有时，用索引里的 blob 判断原编码。工作区已经是 UTF-8，不能拿它当新文件登记。 */
function trackedMapping(repoRoot, pathname) {
  const key = slashRel(pathname);
  const oid = indexBlobOid(repoRoot, key);
  if (!oid) return '';
  const recs = tryCatFileBatch(repoRoot, [oid]);
  const rec = recs && recs[0];
  if (!rec || rec.missing) {
    const err = new Error('无法读取索引中的原编码: ' + key);
    err.code = 'ZKZ_BLOB_LOOKUP';
    throw err;
  }
  return encodeMapped(detectKind(rec.data), hasCrlf(rec.data));
}

function smudge(pathname, blobBytes, table, repoRoot, isLibraryPath) {
  if (repoRoot && (isLibraryPath ? isLibraryPath(pathname) : isLibRel(repoRoot, pathname))) return Buffer.from(blobBytes || []);
  const mapped = lookupKind(table, pathname);
  const hinted = mapped ? parseMapped(mapped).kind : '';
  const actual = detectKind(blobBytes);
  const kind = reconcileSmudgeKind(actual, hinted);
  return applySmudge(kind, blobBytes, {
    onDrop: (info) => noteCp936Drop(repoRoot, pathname, info)
  });
}

function clean(pathname, wtBytes, table, repoRoot, isLibraryPath) {
  if (repoRoot && (isLibraryPath ? isLibraryPath(pathname) : isLibRel(repoRoot, pathname))) return Buffer.from(wtBytes || []);
  let mapped = lookupKind(table, pathname);
  if (!mapped && repoRoot && pathname) {
    const disk = mappingOf(repoRoot, pathname);
    if (disk) {
      // 磁盘表已有这项就用它。内存表缺一项时不再逐个读 blob。
      mapped = disk;
      remember(table, pathname, disk);
    } else {
      const fromGit = trackedMapping(repoRoot, pathname);
      if (fromGit) mapped = bindMapping(table, repoRoot, pathname, fromGit, false);
    }
  }
  if (!mapped) {
    const plan = planNewFile(wtBytes);
    if (!(repoRoot && pathname)) return plan.blob;
    const stored = bindMapping(table, repoRoot, pathname, plan.mapped, false);
    if (stored === plan.mapped) return plan.blob;
    mapped = stored;
  }
  const parsed = parseMapped(mapped);
  if (parsed.kind === 'Ascii' && hasNonAscii(wtBytes)) {
    let soft = false;
    const out = applyClean('Gbk', wtBytes, {
      crlf: parsed.crlf,
      onSoftFail: (err) => {
        soft = true;
        if (repoRoot) recordRoundtripFailure(repoRoot, pathname, err);
      },
      onDrop: (info) => noteCp936Drop(repoRoot, pathname, info)
    });
    if (!soft) {
      bindMapping(table, repoRoot, pathname, encodeMapped('Gbk', parsed.crlf), true);
      if (repoRoot) clearRoundtripFailure(repoRoot, pathname);
    }
    return out;
  }
  let soft = false;
  const out = applyClean(parsed.kind, wtBytes, {
    crlf: parsed.crlf,
    onSoftFail: (err) => {
      soft = true;
      if (repoRoot) recordRoundtripFailure(repoRoot, pathname, err);
    },
    onDrop: (info) => noteCp936Drop(repoRoot, pathname, info)
  });
  if (!soft && repoRoot && parsed.kind === 'Gbk') clearRoundtripFailure(repoRoot, pathname);
  return out;
}

module.exports = { lookupKind, smudge, clean, reconcileSmudgeKind, trackedMapping };
