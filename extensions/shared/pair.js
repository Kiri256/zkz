'use strict';

const vscode = require('vscode');
const { findProjectRoot } = require('./project_root');

/** 当前编辑器的文件路径。没有打开文件时返回空字符串。扩展宿主线程调用。 */
function activeEditorPath() {
  try {
    const ed = vscode.window.activeTextEditor;
    const uri = ed && ed.document && ed.document.uri;
    if (uri && uri.scheme === 'file') return uri.fsPath;
  } catch (_) { /* ignore */ }
  return '';
}

/** 从工作区文件夹和可选路径解析工程根。返回 { root }。没有工作区或找不到工程根时抛错。扩展宿主线程调用。 */
function resolvePair(filePath) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) throw new Error('未打开工作区文件夹');
  const hint = filePath || activeEditorPath();
  const root = findProjectRoot(folders.map(function (f) { return f.uri.fsPath; }), hint);
  if (!root) throw new Error('无法解析工程根目录');
  return { root: root };
}

module.exports = { resolvePair };
