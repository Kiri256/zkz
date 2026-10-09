'use strict';

const vscode = require('vscode');
const { isProjectRoot, findProjectRoot } = require('../../shared/project_root');

function resolvePair() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) throw new Error('未打开工作区文件夹');
  const root = findProjectRoot(folders.map(function (f) { return f.uri.fsPath; }));
  if (!root) throw new Error('无法解析工程根目录');
  return { root: root };
}

module.exports = { isProjectRoot, resolvePair };
