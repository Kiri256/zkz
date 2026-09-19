'use strict';

const vscode = require('vscode');
const { isInstalled, verifyGitConfig } = require('./git_config');
const { installHooks, hooksPresent } = require('./hooks');
const { applySkipWorktree } = require('./config_freeze');
const commands = require('./commands');
const statusBar = require('./status_bar');

function tryRepo() {
  try { return commands.resolveRepo(); } catch (_) { return ''; }
}

function activate(context) {
  const extensionRoot = context.extensionPath;
  const bar = statusBar.create(context);
  commands.register(context, extensionRoot, () => bar.refresh());

  const repo = tryRepo();
  if (repo && isInstalled(repo)) {
    try { verifyGitConfig(repo, extensionRoot); } catch (_) { /* ignore */ }
    if (!hooksPresent(repo)) {
      try { installHooks(repo, extensionRoot); } catch (_) { /* ignore */ }
    }
    try { applySkipWorktree(repo); } catch (_) { /* ignore */ }
    bar.refresh();
  }

  void vscode.commands.executeCommand('setContext', 'zkzNative.enabled', !!(repo && isInstalled(repo)));
}

function deactivate() {
  void vscode.commands.executeCommand('setContext', 'zkzNative.enabled', false);
}

module.exports = { activate, deactivate };
