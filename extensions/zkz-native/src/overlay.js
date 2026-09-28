'use strict';

// 机器本地配置的“权威副本 + 切分支还原”。
//
// 某些分支把 .vscode/settings.json 之类配置 commit 进了仓库，切分支时 git 会按
// 目标分支状态删掉/覆盖工作区里的这些文件，导致本地配置丢失。此模块把这些文件的
// 本地内容存一份权威副本到 .zkz/config-overlay/（不进仓库），并在每次
// checkout/merge/rebase 后由扩展 HEAD 监测还原回工作区（不再走 post-* hook）。

const fs = require('fs');
const path = require('path');
const { configOverlayRoot, ensureZkz, slashRel, atomicWriteFile, sleepSync } = require('./paths');
const { loadConfigPaths } = require('./config_freeze');

function relParts(rel) {
  return slashRel(rel).split('/').filter(Boolean);
}

function storePath(repoRoot, rel) {
  return path.join(configOverlayRoot(repoRoot), ...relParts(rel));
}

function wtPath(repoRoot, rel) {
  return path.join(repoRoot, ...relParts(rel));
}

// 列出某个绝对路径下的所有文件（相对该路径的、用 / 分隔的子路径）。
function walkFiles(root) {
  const out = [];
  const rec = (dir, base) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      const sub = base ? base + '/' + ent.name : ent.name;
      if (ent.isDirectory()) rec(full, sub);
      else if (ent.isFile()) out.push(sub);
    }
  };
  rec(root, '');
  return out;
}

// 把一个配置项（可能是文件或目录）展开成具体的相对文件列表；basePathFn 决定
// 从工作区还是从权威副本去枚举。
function expandEntries(repoRoot, rel, basePathFn) {
  const abs = basePathFn(repoRoot, rel);
  let st = null;
  try { st = fs.statSync(abs); } catch (_) { return []; }
  if (st.isDirectory()) return walkFiles(abs).map((sub) => slashRel(rel) + '/' + sub);
  if (st.isFile()) return [slashRel(rel)];
  return [];
}

function copyFile(src, dst) {
  const buf = fs.readFileSync(src);
  atomicWriteFile(dst, buf);
}

function overlayList(repoRoot) {
  const cfg = loadConfigPaths(repoRoot);
  return (cfg.overlay || cfg.paths || []).map(slashRel).filter(Boolean);
}

function topLevelRels(rels) {
  const sorted = rels.slice().sort();
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const rel = sorted[i];
    let covered = false;
    for (let j = 0; j < out.length; j++) {
      const pre = out[j];
      if (rel === pre || rel.indexOf(pre + '/') === 0) { covered = true; break; }
    }
    if (!covered) out.push(rel);
  }
  return out;
}

function contained(parent, child) {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  const rel = path.relative(base, target);
  if (!rel || rel === '.') return false;
  if (path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.indexOf('..') < 0;
}

function unlinkBusy(full) {
  let last = null;
  for (let i = 0; i < 4; i++) {
    try {
      fs.rmSync(full, { force: true, maxRetries: 1, retryDelay: 20 });
      return;
    } catch (e) {
      last = e;
      try { fs.unlinkSync(full); return; } catch (e2) { last = e2; }
      if (i < 3) sleepSync(40 * (i + 1));
    }
  }
  throw last || new Error('unlink failed: ' + full);
}

function isGitkeepName(name) {
  const n = String(name || '').toLowerCase();
  return n === '.gitkeep' || n === 'gitkeep';
}

// 保存权威副本时清掉旧副本。工作区还原不走这里。
function clearDir(parent, dir) {
  if (!contained(parent, dir)) throw new Error('refuse to remove ' + dir);
  let rootSt = null;
  try { rootSt = fs.lstatSync(dir); } catch (_) { return []; }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
    try { unlinkBusy(dir); } catch (e) {
      return [slashRel(path.relative(parent, dir)) + ': ' + String(e && e.message ? e.message : e)];
    }
    return [];
  }
  const failed = [];
  const sweep = (cur) => {
    let ents = [];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) {
      failed.push(slashRel(path.relative(parent, cur)) + ': ' + String(e && e.message ? e.message : e));
      return;
    }
    for (const ent of ents) {
      const full = path.join(cur, ent.name);
      if (!contained(parent, full)) continue;
      if (ent.isSymbolicLink()) {
        try { unlinkBusy(full); } catch (e) {
          failed.push(slashRel(path.relative(parent, full)) + ': ' + String(e && e.message ? e.message : e));
        }
        continue;
      }
      if (ent.isDirectory()) {
        sweep(full);
        try { fs.rmdirSync(full); } catch (_) { /* 仍被占用或非空 */ }
      } else {
        try { unlinkBusy(full); } catch (e) {
          failed.push(slashRel(path.relative(parent, full)) + ': ' + String(e && e.message ? e.message : e));
        }
      }
    }
  };
  sweep(dir);
  try { fs.rmdirSync(dir); } catch (_) { /* 根目录保持原位，里面已清空 */ }
  return failed;
}

// 还原工作区：只删文件，不删目录。gitkeep 留下，避免目录被摘空。
function clearDirFiles(parent, dir) {
  if (!contained(parent, dir)) throw new Error('refuse to remove ' + dir);
  let rootSt = null;
  try { rootSt = fs.lstatSync(dir); } catch (_) { return []; }
  if (rootSt.isSymbolicLink() && rootSt.isDirectory()) return [];
  if (!rootSt.isDirectory()) {
    try { unlinkBusy(dir); } catch (e) {
      return [slashRel(path.relative(parent, dir)) + ': ' + String(e && e.message ? e.message : e)];
    }
    return [];
  }
  const failed = [];
  const sweep = (cur) => {
    let ents = [];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) {
      failed.push(slashRel(path.relative(parent, cur)) + ': ' + String(e && e.message ? e.message : e));
      return;
    }
    for (const ent of ents) {
      const full = path.join(cur, ent.name);
      if (!contained(parent, full)) continue;
      if (ent.isSymbolicLink()) {
        let dirLink = false;
        try { dirLink = fs.statSync(full).isDirectory(); } catch (_) { dirLink = false; }
        if (dirLink || isGitkeepName(ent.name)) continue;
        try { unlinkBusy(full); } catch (e) {
          failed.push(slashRel(path.relative(parent, full)) + ': ' + String(e && e.message ? e.message : e));
        }
        continue;
      }
      if (ent.isDirectory()) {
        sweep(full);
        continue;
      }
      if (isGitkeepName(ent.name)) continue;
      try { unlinkBusy(full); } catch (e) {
        failed.push(slashRel(path.relative(parent, full)) + ': ' + String(e && e.message ? e.message : e));
      }
    }
  };
  sweep(dir);
  return failed;
}

// 把当前工作区里的配置文件设为权威副本（“保存”）。目录会整棵替换副本，避免旧文件残留。
function seedOverlay(repoRoot) {
  ensureZkz(repoRoot);
  const seeded = [];
  for (const rel of topLevelRels(overlayList(repoRoot))) {
    let st = null;
    try { st = fs.statSync(wtPath(repoRoot, rel)); } catch (_) { continue; }
    if (st.isDirectory()) clearDir(configOverlayRoot(repoRoot), storePath(repoRoot, rel));
    for (const f of expandEntries(repoRoot, rel, wtPath)) {
      try {
        copyFile(wtPath(repoRoot, f), storePath(repoRoot, f));
        seeded.push(f);
      } catch (_) { /* ignore single file */ }
    }
  }
  return { seeded: seeded };
}

// 用权威副本覆盖工作区。目录保留，只删其中除 gitkeep 以外的文件，再写回副本。
function restoreOverlay(repoRoot) {
  const restored = [];
  const errors = [];
  for (const rel of topLevelRels(overlayList(repoRoot))) {
    const storedAbs = storePath(repoRoot, rel);
    let st = null;
    try { st = fs.statSync(storedAbs); } catch (_) { continue; }
    const files = expandEntries(repoRoot, rel, storePath);
    const keep = new Set(files);
    if (st.isDirectory()) {
      const failed = clearDirFiles(repoRoot, wtPath(repoRoot, rel));
      for (let i = 0; i < failed.length; i++) {
        const msg = failed[i];
        const relFail = msg.split(':')[0];
        if (!keep.has(relFail)) errors.push(msg);
      }
    }
    for (const f of files) {
      try {
        copyFile(storePath(repoRoot, f), wtPath(repoRoot, f));
        restored.push(f);
      } catch (e) {
        errors.push(f + ': ' + String(e && e.message ? e.message : e));
      }
    }
  }
  if (errors.length) throw new Error('overlay restore incomplete: ' + errors.join('; '));
  return { restored: restored };
}

// 是否已有权威副本（用于首次自动 seed 判断）。
function overlaySeeded(repoRoot) {
  try {
    return walkFiles(configOverlayRoot(repoRoot)).length > 0;
  } catch (_) {
    return false;
  }
}

module.exports = { seedOverlay, restoreOverlay, overlaySeeded, storePath, wtPath };
