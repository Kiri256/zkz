'use strict';

const path = require('path');
const vscode = require('vscode');
const { readHeadName, readHeadOid, gitDirOf } = require('./git_exec');
const { appendLog } = require('./paths');

const DEBOUNCE_MS = 500;
const POLL_MS = 30000;

function startHeadWatch(context, repoRoot, onChange) {
  if (!repoRoot) return { dispose: function () { } };
  let lastName = '';
  let lastOid = '';
  try { lastName = readHeadName(repoRoot) || ''; } catch (_) { lastName = ''; }
  try { lastOid = readHeadOid(repoRoot) || ''; } catch (_) { lastOid = ''; }
  let debounceTimer = null;
  let disposed = false;

  const fire = (reason) => {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed) return;
      let name = '';
      let oid = '';
      try {
        name = readHeadName(repoRoot) || '';
        oid = readHeadOid(repoRoot) || '';
      } catch (_) { return; }
      if (!name || name === lastName) return;
      const from = lastOid;
      lastName = name;
      if (oid) lastOid = oid;
      try {
        appendLog(repoRoot, 'HEAD ' + reason + ' ' + name + ' ' + String(from).slice(0, 8) + ' -> ' + String(oid).slice(0, 8));
      } catch (_) { /* ignore */ }
      Promise.resolve(onChange({ from: from, to: oid, reason: reason })).catch(() => { });
    }, DEBOUNCE_MS);
  };

  const gitDir = gitDirOf(repoRoot) || path.join(repoRoot, '.git');
  const watchers = [];
  const addWatch = (pattern) => {
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitDir, pattern));
      w.onDidChange(() => fire('watch'));
      w.onDidCreate(() => fire('watch'));
      w.onDidDelete(() => fire('watch'));
      watchers.push(w);
    } catch (_) { /* .git 可能是文件（worktree） */ }
  };
  addWatch('HEAD');

  const focusSub = vscode.window.onDidChangeWindowState((s) => {
    if (s.focused) fire('focus');
  });
  const poll = setInterval(() => fire('poll'), POLL_MS);

  const sub = {
    dispose: function () {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(poll);
      try { focusSub.dispose(); } catch (_) { /* ignore */ }
      watchers.forEach((w) => { try { w.dispose(); } catch (_2) { /* ignore */ } });
    }
  };
  if (context && context.subscriptions) context.subscriptions.push(sub);
  return sub;
}

module.exports = { startHeadWatch, DEBOUNCE_MS, POLL_MS };
