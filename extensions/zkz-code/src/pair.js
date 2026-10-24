'use strict';

const vscode = require('vscode');
const { isProjectRoot, findProjectRoot } = require('../../shared/project_root');

function activeEditorPath() {
  try {
    const ed = vscode.window.activeTextEditor;
    const uri = ed && ed.document && ed.document.uri;
    if (uri && uri.scheme === 'file') return uri.fsPath;
  } catch (_) { /* ignore */ }
  return '';
}

function resolvePair(filePath) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) throw new Error('未打开工作区文件夹');
  const hint = filePath || activeEditorPath();
  const root = findProjectRoot(folders.map(function (f) { return f.uri.fsPath; }), hint);
  if (!root) throw new Error('无法解析工程根目录');
  return { root: root };
}

module.exports = { isProjectRoot, resolvePair };
