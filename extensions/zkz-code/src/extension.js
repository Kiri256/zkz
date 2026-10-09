'use strict';

const vscode = require('vscode');
const ifdefFold = require('./ifdef_fold');
const status = require('./status');

function activate(context) {
  status.activate(context);
  try {
    const pair = require('./pair').resolvePair();
    require('../../shared/zkz_settings').ensure(pair.root);
  } catch (_) { /* unpaired */ }
  ifdefFold.activate(context, { commandPrefix: 'zkz-code' });
  void vscode.commands.executeCommand('setContext', 'zkzCode.enabled', true);
}

function deactivate() {
  try { status.deactivate(); } catch (_) { /* ignore */ }
  void vscode.commands.executeCommand('setContext', 'zkzCode.enabled', false);
}

module.exports = { activate, deactivate };
