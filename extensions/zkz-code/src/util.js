'use strict';

const vscode = require('vscode');

const output = vscode.window.createOutputChannel('zkz Code');

function log(msg) {
  output.appendLine('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

async function withProgress(title, fn) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    async () => fn()
  );
}

function showInfoAuto(message, ms) {
  const title = String(message || '');
  const wait = ms == null ? 4000 : Number(ms);
  if (!title) return Promise.resolve();
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    () => new Promise((resolve) => setTimeout(resolve, wait > 0 ? wait : 4000))
  );
}

module.exports = { output, log, withProgress, showInfoAuto };
