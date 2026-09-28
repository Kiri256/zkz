'use strict';

const vscode = require('vscode');
const { isInstalled, verifyGitConfig } = require('./git_config');
const { verifyHooks } = require('./hooks');
const { applySkipWorktree } = require('./config_freeze');
const { restoreOverlay, overlaySeeded } = require('./overlay');
const { refresh, silentRefresh, tableDrift } = require('./bootstrap');
const commands = require('./commands');
const statusBar = require('./status_bar');
const { withLock } = require('./lock');
const { startHeadWatch } = require('./head_watch');
const { currentBranch } = require('./git_exec');

function tryRepo() {
  try { return commands.resolveRepo(); } catch (_) { return ''; }
}

function headLabel(repo, to) {
  let branch = '';
  try { branch = currentBranch(repo); } catch (_) { branch = ''; }
  const short = String(to || '').slice(0, 8);
  if (branch && branch !== 'HEAD') return short ? branch + ' (' + short + ')' : branch;
  return short || '新提交';
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
  const repo = tryRepo();
  const bar = statusBar.create(context, { defer: !!repo });
  let headSub = null;

  const stopHeadWatch = () => {
    if (!headSub) return;
    try { headSub.dispose(); } catch (_) { /* ignore */ }
    headSub = null;
  };

  const startWatch = () => {
    if (!repo || headSub) return;
    headSub = startHeadWatch(context, repo, async ({ from, to }) => {
      if (!isInstalled(repo)) return;
      const where = headLabel(repo, to);
      try {
        const r = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'zkz-native：已切换到 ' + where + '，正在刷新编码表',
          cancellable: false
        }, () => withLock(repo, () => silentRefresh(repo, { from: from, to: to })));
        if (r && r.errors && r.errors.length) warnActivate('headWatch', r.errors.join('; '));
      } catch (e) {
        warnActivate('headWatch', e);
      }
      try { bar.refresh(); } catch (_) { /* ignore */ }
      void vscode.window.showInformationMessage(
        'zkz-native：已切换到 ' + where + '，是否从权威副本还原本地配置？',
        '还原'
      ).then((choice) => {
        if (choice !== '还原') return;
        if (!overlaySeeded(repo)) {
          void vscode.window.showInformationMessage('还没有权威副本，请先执行 saveConfigOverlay');
          return;
        }
        try {
          const restored = restoreOverlay(repo);
          void vscode.window.showInformationMessage('已还原 ' + restored.restored.length + ' 个本地配置');
        } catch (e) {
          warnActivate('configOverlay', e);
        }
      });
      try {
        await vscode.commands.executeCommand('zkz-code.onHeadChanged', {
          root: repo,
          from: from,
          to: to
        });
      } catch (_) { /* zkz-code 未装 */ }
    });
  };

  commands.register(context, extensionRoot, {
    onStatus: () => bar.refresh(),
    onActive: (on) => {
      if (on) startWatch();
      else stopHeadWatch();
      try { bar.refresh(); } catch (_) { /* ignore */ }
    }
  });

  setImmediate(() => {
    let installed = false;
    try {
      installed = !!(repo && isInstalled(repo));
      if (installed) {
        startWatch();
        try { verifyGitConfig(repo, extensionRoot); } catch (e) { warnActivate('verifyGitConfig', e); }
        try { verifyHooks(repo, extensionRoot); } catch (e) { warnActivate('verifyHooks', e); }
        try { applySkipWorktree(repo); } catch (e) { warnActivate('applySkipWorktree', e); }
        if (tableDrift(repo)) {
          void withLock(repo, () => refresh(repo, extensionRoot))
            .then(() => bar.refresh())
            .catch((e) => warnActivate('refreshTable', e));
        } else {
          bar.refresh();
        }
      } else {
        try { bar.refresh(); } catch (_) { /* ignore */ }
      }
    } catch (e) {
      warnActivate('init', e);
      try { bar.refresh(); } catch (_) { /* ignore */ }
    }
    void vscode.commands.executeCommand('setContext', 'zkzNative.enabled', installed);
  });
}

function deactivate() {
  void vscode.commands.executeCommand('setContext', 'zkzNative.enabled', false);
}

module.exports = { activate, deactivate };
