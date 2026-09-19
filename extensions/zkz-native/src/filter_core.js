'use strict';

const { slashRel, isLibRel } = require('./paths');
const { detectKind, applySmudge, applyClean, kindForNewFile, parseMapped } = require('./encoding');

function lookupKind(table, pathname) {
  if (!table) return null;
  const key = slashRel(pathname);
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  return null;
}

function smudge(pathname, blobBytes, table, repoRoot) {
  if (repoRoot && isLibRel(repoRoot, pathname)) return Buffer.from(blobBytes || []);
  const mapped = lookupKind(table, pathname);
  const kind = mapped ? parseMapped(mapped).kind : detectKind(blobBytes);
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
  return applyClean(parsed.kind, wtBytes, { crlf: parsed.crlf });
}

module.exports = { lookupKind, smudge, clean };
