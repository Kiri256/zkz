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

function resolvePairLocal() {
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

function resolvePair() {
  return resolvePairLocal();
}

async function resolvePairPreferred() {
  try {
    const ids = await vscode.commands.getCommands(true);
    if (ids.indexOf('zkz-native.resolveRoot') >= 0) {
      const r = await vscode.commands.executeCommand('zkz-native.resolveRoot');
      if (r && r.root) return { root: r.root };
    }
  } catch (_) { /* native 未装时用本包回退 */ }
  return resolvePairLocal();
}

module.exports = {
  isProjectRoot,
  resolvePair,
  resolvePairPreferred
};
