'use strict';

const { slashRel } = require('./paths');

/** git diff --name-status -z：状态与路径分字段，以 NUL 结尾。R/C 为 status\\0old\\0new\\0，其余为 status\\0path\\0。 */
function parseNameStatusZ(out) {
  const added = [];
  const removed = [];
  const records = [];
  const parts = String(out || '').split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const code = rec.charAt(0);
    if (code === 'R' || code === 'C') {
      const oldPath = slashRel(parts[i + 1] || '');
      const newPath = slashRel(parts[i + 2] || '');
      if (oldPath) removed.push(oldPath);
      if (newPath) added.push(newPath);
      records.push({ status: code, oldPath: oldPath, path: newPath });
      i += 2;
    } else {
      const p = slashRel(parts[i + 1] || '');
      i += 1;
      if (!p) continue;
      if (code === 'D') {
        removed.push(p);
        records.push({ status: 'D', path: p, oldPath: p });
      } else {
        added.push(p);
        records.push({ status: code, path: p, oldPath: '' });
      }
    }
  }
  return { added: added, removed: removed, records: records };
}

function parsePorcelainZ(out) {
  const set = new Set();
  const parts = String(out || '').split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    const status = rec.slice(0, 2);
    const pathname = rec.slice(3);
    if (pathname) set.add(slashRel(pathname));
    // Porcelain -z puts the destination first, then the unprefixed origin.
    if (/[RC]/.test(status) && i + 1 < parts.length) set.add(slashRel(parts[++i]));
  }
  return set;
}

module.exports = { parseNameStatusZ, parsePorcelainZ };
