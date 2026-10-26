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

function existsFile(file) {
  try { return fs.existsSync(file) && fs.statSync(file).isFile(); } catch (_) { return false; }
}

/** 有 F429 或 H750 的 Keil 工程文件才算工程根。编烧树里的副本不算。 */
function hasKeilProject(dir) {
  if (!dir || isKeilNativeTree(dir) || !existsDir(dir)) return false;
  const mdk = path.join(dir, 'Project', 'MDK-ARM(uV4)');
  if (existsFile(path.join(mdk, 'b_01.uvproj')) || existsFile(path.join(mdk, 'b_01.uvprojx'))) return true;
  return existsFile(path.join(dir, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx'));
}

function rootScore(dir) {
  return hasKeilProject(dir) ? 2 : 0;
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

module.exports = { isProjectRoot, hasKeilProject, findProjectRoot, rootScore, folderForRoot };
