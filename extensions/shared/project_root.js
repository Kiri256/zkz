'use strict';

const fs = require('fs');
const path = require('path');

function isKeilNativeTree(dir) {
  const norm = path.resolve(String(dir || '')).replace(/\\/g, '/').toLowerCase();
  return norm.endsWith('/.zkz/keil-native') || norm.indexOf('/.zkz/keil-native/') >= 0;
}

function existsDir(dir) {
  try { return fs.existsSync(dir); } catch (_) { return false; }
}

/** 2 = 固件（有 Project，或同时有 User 与 core）。1 = 只有 .git、User 或 core。编烧树记 0。 */
function rootScore(dir) {
  if (!dir || isKeilNativeTree(dir) || !existsDir(dir)) return 0;
  const hasProject = existsDir(path.join(dir, 'Project'));
  const hasUser = existsDir(path.join(dir, 'User'));
  const hasCore = existsDir(path.join(dir, 'core'));
  const hasGit = existsDir(path.join(dir, '.git'));
  if (hasProject || (hasUser && hasCore)) return 2;
  if (hasUser || hasCore || hasGit) return 1;
  return 0;
}

function isProjectRoot(dir) {
  return rootScore(dir) > 0;
}

function containsPath(root, file) {
  if (!root || !file) return false;
  const base = path.resolve(root);
  const target = path.resolve(file);
  const rel = path.relative(base, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  if (process.platform !== 'win32') return false;
  const b = base.toLowerCase();
  const t = target.toLowerCase();
  return t === b || t.startsWith(b + path.sep);
}

function bestOnWalk(start) {
  let cur = start;
  let best = '';
  let bestScore = 0;
  for (let i = 0; i < 6 && cur; i++) {
    const score = rootScore(cur);
    if (score > bestScore) {
      best = cur;
      bestScore = score;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { root: best, score: bestScore };
}

function findProjectRoot(starts, activeFile) {
  const list = starts || [];
  const found = [];
  let bestScore = 0;
  for (let n = 0; n < list.length; n++) {
    if (!list[n]) continue;
    const hit = bestOnWalk(list[n]);
    if (!hit.score) continue;
    found.push(hit);
    if (hit.score > bestScore) bestScore = hit.score;
  }
  const top = [];
  for (let i = 0; i < found.length; i++) {
    if (found[i].score === bestScore) top.push(found[i]);
  }
  if (!top.length) return '';
  if (activeFile) {
    for (let i = 0; i < top.length; i++) {
      if (containsPath(top[i].root, activeFile)) return top[i].root;
    }
  }
  return top[0].root;
}

/** 在若干工作区路径里选出最贴近 root 的那一个。相等优先，其次 root 里面的路径，再其次包住 root 的路径。 */
function folderForRoot(folders, root) {
  const paths = folders || [];
  if (!paths.length) return '';
  if (!root) return paths[0];
  const rootLow = path.resolve(root).toLowerCase();
  let inside = '';
  let contains = '';
  for (let i = 0; i < paths.length; i++) {
    const fp = path.resolve(paths[i]).toLowerCase();
    if (fp === rootLow) return paths[i];
    if (!inside && fp.startsWith(rootLow + path.sep)) inside = paths[i];
    if (!contains && rootLow.startsWith(fp + path.sep)) contains = paths[i];
  }
  return inside || contains || paths[0];
}

module.exports = { isProjectRoot, findProjectRoot, rootScore, folderForRoot };
