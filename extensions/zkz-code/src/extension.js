'use strict';

const vscode = require('vscode');
const ifdefFold = require('./ifdef_fold');
const status = require('./status');
const { resolvePair } = require('./pair');
const { restoreCmsis } = require('./cmsis');

function activate(context) {
  status.activate(context);
  context.subscriptions.push(vscode.commands.registerCommand('zkz-code.restoreCmsisInclude', async () => {
    try {
      const root = resolvePair().root;
      const result = restoreCmsis(root);
      void vscode.window.showInformationMessage(result.skipped
        ? 'CMSIS Include 已存在，未改动工作区'
        : 'CMSIS Include 已恢复到工作区（未暂存、未提交）');
      return result;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      void vscode.window.showErrorMessage(msg);
      throw e;
    }
  }));
  const ensureSettings = () => {
    try { require('../../shared/zkz_settings').ensure(resolvePair().root); } catch (_) { /* unpaired */ }
  };
  ensureSettings();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(ensureSettings));
  ifdefFold.activate(context, { commandPrefix: 'zkz-code' });
  void vscode.commands.executeCommand('setContext', 'zkzCode.enabled', true);
}

function deactivate() {
  try { status.deactivate(); } catch (_) { /* ignore */ }
  void vscode.commands.executeCommand('setContext', 'zkzCode.enabled', false);
}

module.exports = { activate, deactivate };
