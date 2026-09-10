'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { resolvePair, isSandboxWorkspace } = require('./pair');
const { isGitManageEnabled } = require('./git_manage');
const { runGit, getW1RemoteSyncState } = require('./git');
const { isSyncing } = require('./sync_gate');
const { collectSyncHints, readMeta } = require('./sync_hint');
const { loadWorkspaceLists } = require('./lists');

const FOCUS_STATUS_COOLDOWN_MS = 30000;

function libraryDirNames() {
  return loadWorkspaceLists().libraryDirNames || [];
}
function textExtSet() {
  return new Set(loadWorkspaceLists().textExtensions || []);
}
function skipTopSet() {
  const L = loadWorkspaceLists();
  return new Set(
    []
      .concat(L.skipTopDirNames || [])
      .concat(L.fffdSkipTop || [])
      .map((s) => String(s).toLowerCase())
  );
}

/** @type {{ branchItem: vscode.StatusBarItem, syncItem: vscode.StatusBarItem } | null} */
let state = null;
let gRefreshTimer = null;
let gRefreshInFlight = false;
let gRefreshQueued = false;
let gLastFocusRefreshAt = 0;
let gRemoteSyncCache = { w1: '', at: 0, st: null };
let gLibsSeedCache = { key: '', at: 0, value: true };

function dirHasCSource(dir, depth) {
  if (depth > 3) return false;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isFile() && textExtSet().has(path.extname(ent.name).toLowerCase())) return true;
      if (ent.isDirectory() && dirHasCSource(p, depth + 1)) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function libsSeeded(sandbox, w1) {
  for (const name of libraryDirNames()) {
    const src = path.join(w1, name);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;
    if (!dirHasCSource(src, 0)) continue;
    const dst = path.join(sandbox, name);
    if (!fs.existsSync(dst)) return false;
    try { if (fs.lstatSync(dst).isSymbolicLink()) return false; } catch (_) { return false; }
  }
  return true;
}

function libsSeededCached(sandbox, w1) {
  const key = String(sandbox) + '|' + String(w1);
  const now = Date.now();
  if (gLibsSeedCache.key === key && (now - gLibsSeedCache.at) < 60000) return gLibsSeedCache.value;
  const value = libsSeeded(sandbox, w1);
  gLibsSeedCache = { key, at: now, value };
  return value;
}

async function getRemoteSyncCached(w1) {
  const now = Date.now();
  if (gRemoteSyncCache.w1 === w1 && gRemoteSyncCache.st && (now - gRemoteSyncCache.at) < 3000) {
    return gRemoteSyncCache.st;
  }
  try {
    const st = await getW1RemoteSyncState(w1);
    gRemoteSyncCache = { w1, at: now, st };
    return st;
  } catch (_) {
    return null;
  }
}

function refreshStatus() {
  if (!state) return;
  if (gRefreshTimer) clearTimeout(gRefreshTimer);
  gRefreshTimer = setTimeout(() => {
    gRefreshTimer = null;
    void runRefreshMerged();
  }, 250);
}

async function runRefreshMerged() {
  if (!state) return;
  if (gRefreshInFlight) {
    gRefreshQueued = true;
    return;
  }
  gRefreshInFlight = true;
  try {
    await refreshStatusAsync();
  } finally {
    gRefreshInFlight = false;
    if (gRefreshQueued) {
      gRefreshQueued = false;
      void runRefreshMerged();
    }
  }
}

async function refreshBranchItem(pair, branchItem) {
  if (!isGitManageEnabled()) {
    branchItem.hide();
    return;
  }
  try {
    let br = String(await runGit(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
    let syncSt = { ahead: 0, behind: 0, dirty: false, unpublished: false, upstream: '', hasUpstream: false };
    const cached = await getRemoteSyncCached(pair.w1);
    if (cached) syncSt = cached;
    const syncBits = [];
    if (syncSt.dirty) syncBits.push('*');
    if (syncSt.unpublished) syncBits.push('\u672a\u53d1\u5e03');
    else {
      if (syncSt.ahead > 0) syncBits.push('$(arrow-up)' + syncSt.ahead);
      if (syncSt.behind > 0) syncBits.push('$(arrow-down)' + syncSt.behind);
    }
    const syncText = syncBits.length ? (' ' + syncBits.join(' ')) : '';
    const tipExtra = [];
    if (syncSt.upstream) tipExtra.push('upstream: ' + syncSt.upstream);
    else if (syncSt.unpublished) tipExtra.push('\u65e0\u8fdc\u7a0b\u4e0a\u6e38\uff08\u672a\u53d1\u5e03\uff09');
    if (syncSt.dirty) tipExtra.push('\u5de5\u4f5c\u533a\u6709\u672a\u63d0\u4ea4\u4fee\u6539');
    if (syncSt.ahead > 0) tipExtra.push('\u672a\u63a8\u9001: ' + syncSt.ahead + ' \u4e2a\u63d0\u4ea4');
    if (syncSt.behind > 0) tipExtra.push('\u843d\u540e\u8fdc\u7a0b: ' + syncSt.behind + ' \u4e2a\u63d0\u4ea4');
    if (br === 'HEAD') {
      const short = String(await runGit(pair.w1, ['rev-parse', '--short', 'HEAD'])).trim();
      branchItem.text = '$(git-commit) ' + (short || 'detached') + syncText;
      branchItem.tooltip = ['\u672c\u6e90\u5206\u79bb\u5934\u6307\u9488', pair.w1, ...tipExtra, '', '\u70b9\u51fb\u5207\u6362\u5206\u652f'].join('\n');
    } else {
      branchItem.text = '$(git-branch) ' + br + syncText;
      branchItem.tooltip = ['\u672c\u6e90\u5206\u652f: ' + br, pair.w1, ...tipExtra, '', '\u70b9\u51fb\u5207\u6362\u5206\u652f'].join('\n');
    }
    branchItem.command = 'zkz-sandbox.pickBranch';
    branchItem.show();
  } catch (e) {
    branchItem.text = '$(git-branch) ?';
    branchItem.tooltip = String(e && e.message ? e.message : e);
    branchItem.command = 'zkz-sandbox.pickBranch';
    branchItem.show();
  }
}

async function refreshStatusAsync() {
  if (!state) return;
  const { branchItem, syncItem } = state;
  try {
    const pair = resolvePair();
    await refreshBranchItem(pair, branchItem);
    const meta = readMeta(pair.sandbox);
    const seeded = libsSeededCached(pair.sandbox, pair.w1);
    const syncedAt = meta && meta.syncedAt ? String(meta.syncedAt).replace('T', ' ').slice(0, 16) : '-';
    const fromUtfAt = meta && meta.lastFromUtf8At ? String(meta.lastFromUtf8At).replace('T', ' ').slice(0, 16) : '-';
    const hints = collectSyncHints(pair);
    let syncLabel = seeded ? 'LibsOK' : 'LibsSEED';
    if (isSyncing()) syncLabel = 'SYNC...';
    else if (hints.needToGb) syncLabel = 'ToGb?';
    else if (hints.needToUtf) syncLabel = 'ToUtf?';
    syncItem.text = '$(sync) zkz ' + syncLabel;
    const tipLines = [
      '\u771f\u6e90: ' + pair.w1,
      'Sandbox: ' + pair.sandbox,
      'Last ToUtf: ' + syncedAt,
      'Last ToGb: ' + fromUtfAt,
      'Libs: ' + (seeded ? 'OK\uff08\u65e5\u5e38\u4e0d\u540c\u6b65\u5e93\uff09' : '\u672a\u5c31\u7eea \u2192 \u7528 ToUtf (libs) \u4ec5\u540c\u6b65\u5e93')
    ];
    if (hints.hints.length) {
      tipLines.push('', '\u63d0\u793a:');
      for (const h of hints.hints) tipLines.push('\u2022 ' + h);
    }
    if (isSandboxWorkspace()) {
      tipLines.push('', 'Click: \u4eea\u8868\u76d8 / ToUtf / ToGb / ...');
      syncItem.command = 'zkz-sandbox.syncMenu';
    } else {
      tipLines.push('', '\u8bf7\u5728 *U \u6c99\u7bb1\u6267\u884c\u540c\u6b65/\u5bf9\u6bd4');
      syncItem.command = undefined;
    }
    syncItem.tooltip = tipLines.join('\n');
    syncItem.backgroundColor = (hints.needToGb || hints.needToUtf)
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    syncItem.show();
  } catch (e) {
    syncItem.text = '$(sync) zkz';
    syncItem.tooltip = String(e && e.message ? e.message : e);
    syncItem.command = undefined;
    syncItem.show();
    branchItem.hide();
  }
}

function bindW1GitRepo(context) {
  void (async () => {
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt) return;
      const gitExports = gitExt.isActive ? gitExt.exports : await gitExt.activate();
      if (!gitExports || typeof gitExports.getAPI !== 'function') return;
      const gitApi = gitExports.getAPI(1);
      const w1RootNorm = () => {
        try { return path.normalize(resolvePair().w1).toLowerCase(); } catch (_) { return ''; }
      };
      const bindRepo = (repo) => {
        if (!repo || !repo.rootUri || !repo.state) return;
        const root = path.normalize(repo.rootUri.fsPath).toLowerCase();
        const w1 = w1RootNorm();
        if (!w1 || (root !== w1 && !root.startsWith(w1 + path.sep))) return;
        context.subscriptions.push(repo.state.onDidChange(() => {
          gRemoteSyncCache = { w1: '', at: 0, st: null };
          refreshStatus();
        }));
      };
      for (const repo of gitApi.repositories || []) bindRepo(repo);
      context.subscriptions.push(gitApi.onDidOpenRepository((repo) => bindRepo(repo)));
    } catch (_) { /* ignore */ }
  })();
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const branchItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  const syncItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  state = { branchItem, syncItem };
  context.subscriptions.push(branchItem, syncItem);

  let saveHintTimer = null;
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => refreshStatus()),
    vscode.window.onDidChangeWindowState((s) => {
      if (!s || !s.focused) return;
      const now = Date.now();
      if ((now - gLastFocusRefreshAt) < FOCUS_STATUS_COOLDOWN_MS) return;
      gLastFocusRefreshAt = now;
      refreshStatus();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      try {
        if (!doc || doc.uri.scheme !== 'file') return;
        const pair = resolvePair();
        const rel = path.relative(pair.sandbox, doc.uri.fsPath);
        if (!rel || rel.startsWith('..')) return;
        const top = rel.split(/[/\\]/)[0].toLowerCase();
        if (skipTopSet().has(top)) return;
        try { require('./session_edits').noteSandboxSave(pair.sandbox, doc.uri.fsPath); } catch (_) { /* ignore */ }
        if (saveHintTimer) clearTimeout(saveHintTimer);
        saveHintTimer = setTimeout(() => { saveHintTimer = null; refreshStatus(); }, 400);
      } catch (_) { /* ignore */ }
    }),
    {
      dispose: () => {
        if (gRefreshTimer) clearTimeout(gRefreshTimer);
        if (saveHintTimer) clearTimeout(saveHintTimer);
        state = null;
      }
    }
  );

  bindW1GitRepo(context);
  refreshStatus();
}

function deactivate() {
  state = null;
}

module.exports = { activate, deactivate, refreshStatus };
