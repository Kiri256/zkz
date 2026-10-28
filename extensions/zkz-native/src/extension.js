'use strict';

const vscode = require('vscode');
const { isInstalled, verifyGitConfig } = require('./git_config');
const { verifyHooks } = require('./hooks');
const { restoreOverlay, overlayDrift } = require('./overlay');
const { refresh, silentRefresh, tableDrift } = require('./bootstrap');
const commands = require('./commands');
const statusBar = require('./status_bar');
const { withLock } = require('./lock');
const { startHeadWatch } = require('./head_watch');
const { currentBranch } = require('./git_exec');

function tryRepo(filePath) {
  try { return commands.resolveRepo(filePath); } catch (_) { return ''; }
}

function headLabel(repo, to) {
  let branch = '';
  try { branch = currentBranch(repo); } catch (_) { branch = ''; }
  if (branch && branch !== 'HEAD') return branch;
  return String(to || '').slice(0, 8) || '分离头';
}

function warnActivate(step, e) {
  const msg = 'zkz-native ' + step + ' 失败: ' + String(e && e.message ? e.message : e);
  try { vscode.window.showWarningMessage(msg); } catch (_) { /* ignore */ }
  try {
    if (!warnActivate._ch) warnActivate._ch = vscode.window.createOutputChannel('zkz Native');
    warnActivate._ch.appendLine(msg);
  } catch (_2) { /* ignore */ }
}

function activate(context) {
  const extensionRoot = context.extensionPath;
  const bar = statusBar.create(context, { defer: !!tryRepo() });
  let headSub = null;
  let watchedRepo = '';

  const stopHeadWatch = () => {
    if (!headSub) return;
    try { headSub.dispose(); } catch (_) { /* ignore */ }
    headSub = null;
  };

  const startWatch = (repo) => {
    if (!repo || !isInstalled(repo)) return;
    if (headSub && watchedRepo === repo) return;
    stopHeadWatch();
    watchedRepo = repo;
    headSub = startHeadWatch(null, repo, async ({ from, to }) => {
      if (!isInstalled(repo)) return;
      const where = headLabel(repo, to);
      try {
        const r = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: '已切换到 ' + where + '，正在刷新编码表',
          cancellable: false
        }, () => withLock(repo, () => silentRefresh(repo, { from: from, to: to })));
        if (r && r.errors && r.errors.length) warnActivate('刷新编码表', r.errors.join('; '));
      } catch (e) {
        warnActivate('刷新编码表', e);
      }
      try { bar.refresh(); } catch (_) { /* ignore */ }
      let drift = 'same';
      try { drift = overlayDrift(repo); } catch (e) {
        warnActivate('本地配置', e);
        return;
      }
      if (drift !== 'changed') return;
      const choice = await vscode.window.showInformationMessage(
        '已切换到 ' + where + '。本地配置与权威副本不一致。',
        '还原',
        '跳过'
      );
      if (choice !== '还原') return;
      try {
        const restored = restoreOverlay(repo);
        commands.note('已还原 ' + restored.restored.length + ' 个本地配置', 'native');
      } catch (e) {
        warnActivate('还原本地配置', e);
      }
    });
  };

  const syncWatch = (verify, filePath) => {
    const repo = tryRepo(filePath);
    if (repo) {
      try { require('../../shared/zkz_settings').ensure(repo); } catch (_) { /* ignore */ }
    }
    const installed = !!(repo && isInstalled(repo));
    if (installed) {
      startWatch(repo);
      if (verify) {
        try { verifyGitConfig(repo, extensionRoot); } catch (e) { warnActivate('verifyGitConfig', e); }
        try { verifyHooks(repo, extensionRoot); } catch (e) { warnActivate('verifyHooks', e); }
        let drift = false;
        try { drift = tableDrift(repo); } catch (e) { warnActivate('encodingTable', e); }
        if (drift) {
          void withLock(repo, () => refresh(repo, extensionRoot))
            .then(() => bar.refresh())
            .catch((e) => warnActivate('refreshTable', e));
        }
      }
    } else {
      stopHeadWatch();
      watchedRepo = '';
    }
    try { bar.refresh(); } catch (_) { /* ignore */ }
    void vscode.commands.executeCommand('setContext', 'zkzNative.enabled', installed);
  };

  commands.register(context, extensionRoot, {
    onStatus: () => bar.refresh(),
    onFlash: (text) => bar.flash(text),
    onActive: (on) => {
      if (on) startWatch(tryRepo());
      else stopHeadWatch();
      try { bar.refresh(); } catch (_) { /* ignore */ }
    }
  });

  context.subscriptions.push(
    { dispose: stopHeadWatch },
    vscode.workspace.onDidChangeWorkspaceFolders(() => syncWatch(true)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      const uri = ed && ed.document && ed.document.uri;
      if (!uri || uri.scheme !== 'file') return;
      if (tryRepo(uri.fsPath) === watchedRepo) return;
      syncWatch(true, uri.fsPath);
    })
  );

  setImmediate(() => {
    try { syncWatch(true); } catch (e) {
      warnActivate('init', e);
      try { bar.refresh(); } catch (_) { /* ignore */ }
    }
  });
}

function deactivate() {
  void vscode.commands.executeCommand('setContext', 'zkzNative.enabled', false);
}

module.exports = { activate, deactivate };
