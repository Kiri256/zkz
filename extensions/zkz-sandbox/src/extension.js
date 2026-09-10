'use strict';
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { resolvePair, isSandboxWorkspace } = require('./pair');
const { refreshGitManageFromWorkspace, isPairedWorkspace } = require('./git_manage');
const sync = require('./sync');

let initialized = false;

function setContexts() {
  const paired = isPairedWorkspace();
  const gitOn = refreshGitManageFromWorkspace();
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.paired', paired);
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.gitManage', gitOn);
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.sandbox', isSandboxWorkspace());
  return paired;
}

function activateHost(context) {
  if (initialized) return;
  if (!setContexts()) return;
  require('./host').activate(context);
  initialized = true;
}

function activate(context) {
  setContexts();
  sync.activate(context);
  const looksZkz = (vscode.workspace.workspaceFolders || []).some((f) => {
    const p = f.uri.fsPath;
    return isSandboxWorkspace() || fs.existsSync(path.join(p, '.zkz', '.workspace_sync_meta.json'))
      || fs.existsSync(path.join(p, 'Project'));
  });
  if (looksZkz || !(vscode.workspace.workspaceFolders || []).length) activateHost(context);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    setContexts();
    activateHost(context);
  }));
}

function deactivate() {
  sync.deactivate();
  for (const key of ['zkzSandbox.paired', 'zkzSandbox.gitManage', 'zkzSandbox.sandbox', 'zkzSandbox.syncing']) {
    void vscode.commands.executeCommand('setContext', key, false);
  }
}

module.exports = { activate, deactivate };
