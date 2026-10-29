'use strict';

const vscode = require('vscode');
const loadShared = require('./load_shared');
const { resolvePair } = loadShared('pair');
const statusBar = require('./status_bar');

function setPaired() {
  let ok = false;
  try {
    resolvePair();
    ok = true;
  } catch (_) { /* unpaired */ }
  void vscode.commands.executeCommand('setContext', 'zkzKeil.paired', ok);
  return ok;
}

function ensureSettings() {
  try { loadShared('zkz_settings').ensure(resolvePair().root); } catch (_) { /* unpaired */ }
}

function activate(context) {
  statusBar.create(context, setPaired);
  ensureSettings();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(ensureSettings));
  require('./keil').activate(context);
  require('./keil_tasks').activate(context);
}

function deactivate() {
  void vscode.commands.executeCommand('setContext', 'zkzKeil.paired', false);
}

module.exports = { activate, deactivate };
