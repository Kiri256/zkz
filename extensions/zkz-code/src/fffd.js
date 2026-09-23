'use strict';
const path = require('path');
const fs = require('fs');
const { loadWorkspaceLists } = require('./lists');

function textExtSet() {
  const L = loadWorkspaceLists();
  return new Set(L.fffdTextExtensions || L.textExtensions || []);
}
function skipTopSet() {
  return new Set((loadWorkspaceLists().fffdSkipTop || []).map((s) => String(s).toLowerCase()));
}

function countFffd(buf) {
  let n = 0;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) n++;
  }
  return n;
}

function countFffdText(text) {
  const s = String(text || '');
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xFFFD) n++;
  return n;
}

function shouldCheckFffd(fsPath, root) {
  if (!root || !fsPath) return false;
  const rel = path.relative(root, fsPath);
  if (!rel || rel.startsWith('..')) return false;
  const top = rel.split(/[/\\]/)[0].toLowerCase();
  if (skipTopSet().has(top)) return false;
  if (!textExtSet().has(path.extname(fsPath).toLowerCase())) return false;
  try { if (fs.statSync(fsPath).size > 2 * 1024 * 1024) return false; } catch (_) { return false; }
  return true;
}

function isSkippedFffdTop(relOrTop) {
  const top = String(relOrTop || '').split(/[/\\]/)[0].toLowerCase();
  return skipTopSet().has(top);
}

function activate(context, deps) {
  const vscode = require('vscode');
  const command = deps.command;
  const workspaceRoot = deps.workspaceRoot;
  const showInfoAuto = deps.showInfoAuto;
  const resolveRoot = deps.resolveRoot;
  context.subscriptions.push(vscode.commands.registerCommand(command('checkFffd'), async () => {
    try {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const root = resolveRoot();
      const fp = ed.document.uri.fsPath;
      if (!shouldCheckFffd(fp, root || workspaceRoot())) {
        void showInfoAuto('skipped');
        return;
      }
      const n = countFffdText(ed.document.getText());
      if (n === 0) void showInfoAuto('no FFFD');
      else vscode.window.showWarningMessage('FFFD count=' + n + ' ' + fp);
    } catch (e) {
      vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
    }
  }));

  const diag = vscode.languages.createDiagnosticCollection('zkz-fffd');
  context.subscriptions.push(diag);
  const fffdSeen = new Map();
  const scanFffdDoc = (doc, warn) => {
    try {
      if (!doc || doc.uri.scheme !== 'file') return;
      const root = resolveRoot();
      const fp = doc.uri.fsPath;
      if (!shouldCheckFffd(fp, root || workspaceRoot())) { diag.delete(doc.uri); return; }
      let stamp = String(doc.version);
      try { stamp += ':' + fs.statSync(fp).mtimeMs; } catch (_) { /* ignore */ }
      if (!warn && fffdSeen.get(fp) === stamp) return;
      fffdSeen.set(fp, stamp);
      const n = countFffdText(doc.getText());
      if (n === 0) { diag.delete(doc.uri); return; }
      const d = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        'U+FFFD (EF BF BD) x ' + n + '. Chinese may be corrupted.',
        vscode.DiagnosticSeverity.Error
      );
      d.source = 'zkz-fffd';
      diag.set(doc.uri, [d]);
      if (warn) vscode.window.showWarningMessage('FFFD: ' + path.basename(fp) + ' (' + n + ')');
    } catch (_) { /* ignore */ }
  };
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => scanFffdDoc(doc, true)));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => scanFffdDoc(doc, false)));
}

module.exports = {
  get TEXT_EXT() { return textExtSet(); },
  get SKIP_TOP() { return skipTopSet(); },
  countFffd,
  countFffdText,
  shouldCheckFffd,
  isSkippedFffdTop,
  activate
};
