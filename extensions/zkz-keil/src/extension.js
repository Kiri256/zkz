'use strict';

const vscode = require('vscode');
const { resolvePair } = require('./pair');
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

function activate(context) {
  statusBar.create(context, setPaired);
  try {
    require('../../shared/zkz_settings').ensure(resolvePair().root);
  } catch (_) { /* unpaired */ }
  require('./keil').activate(context);
  require('./keil_tasks').activate(context);
}

function deactivate() {
  void vscode.commands.executeCommand('setContext', 'zkzKeil.paired', false);
}

module.exports = { activate, deactivate };
