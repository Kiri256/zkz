'use strict';

const { slashRel, isLibRel } = require('./paths');
const { detectKind, applySmudge, applyClean, kindForNewFile, parseMapped } = require('./encoding');
const { recordRoundtripFailure, clearRoundtripFailure } = require('./observe');

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

function smudge(pathname, blobBytes, table, repoRoot) {
  if (repoRoot && isLibRel(repoRoot, pathname)) return Buffer.from(blobBytes || []);
  const mapped = lookupKind(table, pathname);
  const hinted = mapped ? parseMapped(mapped).kind : '';
  const actual = detectKind(blobBytes);
  const kind = reconcileSmudgeKind(actual, hinted);
  return applySmudge(kind, blobBytes);
}

function clean(pathname, wtBytes, table, repoRoot) {
  if (repoRoot && isLibRel(repoRoot, pathname)) return Buffer.from(wtBytes || []);
  const mapped = lookupKind(table, pathname);
  if (!mapped) {
    kindForNewFile(wtBytes);
    return Buffer.from(wtBytes || []);
  }
  const parsed = parseMapped(mapped);
  let soft = false;
  const out = applyClean(parsed.kind, wtBytes, {
    crlf: parsed.crlf,
    onSoftFail: (err) => {
      soft = true;
      if (repoRoot) recordRoundtripFailure(repoRoot, pathname, err);
    }
  });
  if (!soft && repoRoot && parsed.kind === 'Gbk') clearRoundtripFailure(repoRoot, pathname);
  return out;
}

module.exports = { lookupKind, smudge, clean, reconcileSmudgeKind };
