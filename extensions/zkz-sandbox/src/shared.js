'use strict';
const vscode = require('vscode');
const { showInfoAuto } = require('./toast');

const GIT_SCHEME = 'zkz-sandbox';
const W1_EDIT_SCHEME = 'zkz-w1';
const output = vscode.window.createOutputChannel('\u672c\u6e90 Git');

/** @type {{ viewMode: 'tree'|'list', sortBy: 'name'|'date', branchFilter?: string, fileFilter?: string, localFilter?: string, remoteFilter?: string }} */
const uiState = {
  viewMode: 'tree',
  sortBy: 'name',
  localFilter: '',
  remoteFilter: '',
  branchFilter: '',
  fileFilter: ''
};

function syncUiContext() {
  vscode.commands.executeCommand('setContext', 'zkzSandbox.viewAsTree', uiState.viewMode === 'tree');
  vscode.commands.executeCommand('setContext', 'zkzSandbox.viewAsList', uiState.viewMode === 'list');
}

function log(msg) {
  const line = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  output.appendLine(line);
}

async function withProgress(title, fn) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    async () => fn()
  );
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  GIT_SCHEME,
  W1_EDIT_SCHEME,
  output,
  uiState,
  syncUiContext,
  log,
  withProgress,
  sleepMs,
  showInfoAuto
};
