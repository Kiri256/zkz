'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { readHeadName, readHeadOid, gitDirOf, refWatchPaths } = require('./git_exec');
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
      if (!name) return;
      // 分支名变了才刷编码表。同分支的提交也要通知，检出经常清掉 skip-worktree。
      const branchChanged = name !== lastName;
      const oidChanged = !!(oid && oid !== lastOid);
      if (!branchChanged && !oidChanged) return;
      const from = lastOid;
      lastName = name;
      if (oid) lastOid = oid;
      try {
        appendLog(repoRoot, 'HEAD ' + reason + ' ' + name + ' ' + String(from).slice(0, 8) + ' -> ' + String(oid).slice(0, 8));
      } catch (_) { /* ignore */ }
      Promise.resolve(onChange({ from: from, to: oid, branchChanged: branchChanged, reason: reason })).catch(() => { });
    }, DEBOUNCE_MS);
  };

  const gitDir = gitDirOf(repoRoot) || path.join(repoRoot, '.git');
  const watchers = [];
  const fsWatchers = [];
  const addWatch = (base, pattern) => {
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      w.onDidChange(() => fire('watch'));
      w.onDidCreate(() => fire('watch'));
      w.onDidDelete(() => fire('watch'));
      watchers.push(w);
    } catch (_) { /* .git 可能是文件（worktree） */ }
  };
  addWatch(gitDir, 'HEAD');
  // 编辑器可能排除 .git。Node 监视不走那份排除，同分支提交能马上看到。
  refWatchPaths(repoRoot).forEach((target) => {
    const recursive = path.basename(target) === 'heads';
    try {
      const w = fs.watch(target, { recursive: recursive }, () => fire('watch'));
      w.on('error', () => { });
      fsWatchers.push(w);
    } catch (_) { /* packed-refs 或 refs/heads 还没有 */ }
  });

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
      fsWatchers.forEach((w) => { try { w.close(); } catch (_2) { /* ignore */ } });
    }
  };
  if (context && context.subscriptions) context.subscriptions.push(sub);
  return sub;
}

module.exports = { startHeadWatch, DEBOUNCE_MS, POLL_MS };
