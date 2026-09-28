'use strict';

const { slashRel } = require('./paths');

function parseNameStatusZ(out) {
  const added = [];
  const removed = [];
  const records = [];
  const parts = String(out || '').split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    const code = rec.charAt(0);
    if (code === 'R' || code === 'C') {
      const oldPath = slashRel(parts[i + 1] || '');
      const newPath = slashRel(parts[i + 2] || '');
      if (oldPath) removed.push(oldPath);
      if (newPath) added.push(newPath);
      records.push({ status: code, oldPath: oldPath, path: newPath });
      i += 2;
    } else if (code === 'D') {
      const p = slashRel(rec.slice(1).replace(/^\s+/, '') || parts[i + 1] || '');
      if (rec.length <= 2) i += 1;
      if (p) removed.push(p);
      records.push({ status: code, path: p, oldPath: p });
    } else {
      const p = slashRel(rec.slice(1).replace(/^\s+/, '') || parts[i + 1] || '');
      if (rec.length <= 2) i += 1;
      if (p) added.push(p);
      records.push({ status: code, path: p, oldPath: '' });
    }
  }
  return { added: added, removed: removed, records: records };
}

function parsePorcelainZ(out) {
  const set = new Set();
  const parts = String(out || '').split('\0').filter(Boolean);
  for (const rec of parts) {
    const pathPart = rec.length > 3 ? rec.slice(3) : rec;
    if (pathPart) set.add(slashRel(pathPart.split(' -> ').pop()));
  }
  return set;
}

module.exports = { parseNameStatusZ, parsePorcelainZ };
