'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

function isProjectRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, 'Project'))) return true;
  if (fs.existsSync(path.join(dir, 'core')) || fs.existsSync(path.join(dir, 'User'))) return true;
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  return false;
}

function resolvePair() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) throw new Error('未打开工作区文件夹');
  for (const f of folders) {
    let cur = f.uri.fsPath;
    for (let i = 0; i < 6; i++) {
      if (isProjectRoot(cur)) return { root: cur };
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  throw new Error('无法解析工程根目录');
}

function assertRootGit(root) {
  if (!fs.existsSync(root)) throw new Error('工程根不存在: ' + root);
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('不是 Git 仓库: ' + root);
}

module.exports = {
  isProjectRoot,
  resolvePair,
  assertRootGit
};
