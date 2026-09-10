'use strict';
const path = require('path');
const fs = require('fs');
const { withProgress } = require('./shared');

/** 本源浏览：仅跳过无意义/危险目录，其余（含 Libraries 等）全部列出 */
function buildSkipDirSet() {
  return new Set(['.git', 'node_modules']);
}

function sleep0() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 列出真源下全部文件（含库目录）；异步分片 walk，避免卡死扩展宿主。
 */
async function listAllFilesUnderAsync(rootAbs) {
  const skipDir = buildSkipDirSet();
  const out = [];
  const stack = [{ abs: rootAbs, rel: '' }];
  let steps = 0;

  while (stack.length) {
    const { abs, rel } = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of ents) {
      const name = ent.name;
      if (!name || name === '.' || name === '..') continue;
      if (skipDir.has(name)) continue;
      const childRel = rel ? (rel + '/' + name) : name;
      const childAbs = path.join(abs, name);
      let isDir = false;
      try { isDir = ent.isDirectory(); } catch (_) { continue; }
      if (isDir) {
        stack.push({ abs: childAbs, rel: childRel.replace(/\\/g, '/') });
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        out.push(childRel.replace(/\\/g, '/'));
      }
    }
    steps++;
    if ((steps % 40) === 0) await sleep0();
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function listAllFilesUnder(rootAbs) {
  const skipDir = buildSkipDirSet();
  const out = [];
  const walk = (absDir, relPosix) => {
    let ents;
    try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      const name = ent.name;
      if (!name || skipDir.has(name) || name === '.' || name === '..') continue;
      const childRel = relPosix ? (relPosix + '/' + name) : name;
      const childAbs = path.join(absDir, name);
      let isDir = false;
      try { isDir = ent.isDirectory(); } catch (_) { continue; }
      if (isDir) walk(childAbs, childRel.replace(/\\/g, '/'));
      else if (ent.isFile() || ent.isSymbolicLink()) out.push(childRel.replace(/\\/g, '/'));
    }
  };
  walk(rootAbs, '');
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function loadW1AllFiles(w1) {
  return withProgress('\u5217\u672c\u6e90\u5168\u90e8\u6587\u4ef6...', async () => {
    const paths = await listAllFilesUnderAsync(w1);
    return paths.map((file) => ({ file }));
  });
}

async function listW1Files(w1) {
  const files = await loadW1AllFiles(w1);
  return files.map((f) => f.file);
}

function matchFileFilter(filePosix, filterRaw) {
  const filter = String(filterRaw || '').trim().toLowerCase();
  if (!filter) return true;
  const hay = String(filePosix || '').toLowerCase();
  const tokens = filter.split(/\s+/).filter(Boolean);
  return tokens.every((t) => hay.includes(t));
}

module.exports = {
  listAllFilesUnder,
  listAllFilesUnderAsync,
  loadW1AllFiles,
  listW1Files,
  matchFileFilter
};
