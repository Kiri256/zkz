'use strict';

const fs = require('fs');
const path = require('path');

function isOid(s) {
  return /^[0-9a-f]{40}$/i.test(s);
}

function gitDirOf(repoRoot) {
  if (!repoRoot) return '';
  const dot = path.join(repoRoot, '.git');
  let st = null;
  try { st = fs.statSync(dot); } catch (_) { return ''; }
  if (st.isDirectory()) return dot;
  try {
    const text = fs.readFileSync(dot, 'utf8');
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (!m) return '';
    return path.resolve(repoRoot, m[1].trim());
  } catch (_) {
    return '';
  }
}

/** 当前分支。符号引用返回 refs/heads/...；分离 HEAD 返回 detached。同分支提交、撤回不变。 */
function readHeadName(repoRoot) {
  const gitDir = gitDirOf(repoRoot);
  if (!gitDir) return '';
  let head = '';
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch (_) { return ''; }
  if (isOid(head)) return 'detached';
  const m = head.match(/^ref:\s*(.+)$/);
  if (!m) return '';
  return m[1].trim();
}

function compileCommandsStampPath(root) {
  return path.join(root, '.zkz', 'run', 'compile-commands-stamp.json');
}

function readCompileCommandsStamp(root) {
  try {
    return JSON.parse(fs.readFileSync(compileCommandsStampPath(root), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeCompileCommandsStamp(root, layout) {
  if (!root) return;
  const info = layout || {};
  fs.mkdirSync(path.dirname(compileCommandsStampPath(root)), { recursive: true });
  fs.writeFileSync(compileCommandsStampPath(root), JSON.stringify({
    version: 1,
    branch: readHeadName(root),
    flavor: info.flavor || '',
    target: info.target || ''
  }, null, 2) + '\n', 'utf8');
}

/**
 * 编译数据库是否还停在别的分支。文件没有、标记没有分支名、标记分支和当前分支不同，都算。
 * 当前分支读不到时，文件还在就不算。同分支提交不改变分支名，不算。
 */
function isCompileCommandsBranchStale(root) {
  if (!root) return false;
  const cc = path.join(root, 'compile_commands.json');
  if (!fs.existsSync(cc)) return true;
  const name = readHeadName(root);
  if (!name) return false;
  const stamp = readCompileCommandsStamp(root);
  if (!stamp || !stamp.branch) return true;
  return stamp.branch !== name;
}

function currentKeilLayout(root) {
  const loadShared = require('./load_shared');
  const { resolveKeilLayout, layoutOptionsFromGet } = loadShared('keil_layout');
  const { get } = loadShared('zkz_settings');
  return resolveKeilLayout(root, layoutOptionsFromGet(function (key, fallback) {
    return get(root, 'keil', key, fallback);
  }));
}

// 编译数据库是否还停在另一个机型或目标。标记里没有机型时不算，避免旧标记一启动就重写。扩展宿主调用。
function isCompileCommandsLayoutStale(root) {
  if (!root) return false;
  const cc = path.join(root, 'compile_commands.json');
  if (!fs.existsSync(cc)) return false;
  const stamp = readCompileCommandsStamp(root);
  if (!stamp || !stamp.flavor) return false;
  let layout;
  try { layout = currentKeilLayout(root); } catch (_) { return false; }
  if (!layout) return false;
  return stamp.flavor !== layout.flavor || (stamp.target || '') !== (layout.defaultTarget || '');
}

module.exports = {
  readHeadName,
  gitDirOf,
  compileCommandsStampPath,
  readCompileCommandsStamp,
  writeCompileCommandsStamp,
  isCompileCommandsBranchStale,
  isCompileCommandsLayoutStale
};
