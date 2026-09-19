'use strict';

const vscode = require('vscode');
const ifdefFold = require('./ifdef_fold');
const status = require('./status');

function activate(context) {
  status.activate(context);
  ifdefFold.activate(context, { commandPrefix: 'zkz-code', configNamespace: 'zkzCode' });
  void vscode.commands.executeCommand('setContext', 'zkzCode.enabled', true);
}

function deactivate() {
  try { status.deactivate(); } catch (_) { /* ignore */ }
  void vscode.commands.executeCommand('setContext', 'zkzCode.enabled', false);
}

module.exports = { activate, deactivate };
