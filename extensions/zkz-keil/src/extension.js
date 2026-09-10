'use strict';

const vscode = require('vscode');
const { resolvePair } = require('./pair');

function setPaired() {
  let ok = false;
  try {
    resolvePair();
    ok = true;
  } catch (_) { /* unpaired */ }
  void vscode.commands.executeCommand('setContext', 'zkzKeil.paired', ok);
  return ok;
}

function activate(context) {
  setPaired();
  require('./keil').activate(context);
  require('./keil_tasks').activate(context);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => setPaired()));
}

function deactivate() {
  void vscode.commands.executeCommand('setContext', 'zkzKeil.paired', false);
}

module.exports = { activate, deactivate };
