'use strict';

const path = require('path');
const vscode = require('vscode');
const { readHeadOid, gitDirOf } = require('./git_exec');
const { appendLog } = require('./paths');

const DEBOUNCE_MS = 500;
const POLL_MS = 30000;

function startHeadWatch(context, repoRoot, onChange) {
  if (!repoRoot) return { dispose: function () { } };
  let last = '';
  try { last = readHeadOid(repoRoot) || ''; } catch (_) { last = ''; }
  let debounceTimer = null;
  let disposed = false;

  const fire = (reason) => {
    if (disposed) return;
    let now = '';
    try { now = readHeadOid(repoRoot) || ''; } catch (_) { return; }
    if (!now || now === last) return;
    const from = last;
    last = now;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed) return;
      try {
        appendLog(repoRoot, 'HEAD ' + reason + ' ' + String(from).slice(0, 8) + ' -> ' + String(now).slice(0, 8));
      } catch (_) { /* ignore */ }
      Promise.resolve(onChange({ from: from, to: now, reason: reason })).catch(() => { });
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
  addWatch('packed-refs');
  addWatch('refs/**');

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
