'use strict';

const vscode = require('vscode');
const { resolvePair, isSandboxWorkspace, assertSandboxSync } = require('./pair');
const { log } = require('./shared');
const { withSyncLock } = require('./sync_gate');
const { diffSandboxW1 } = require('./pair_diff');
const { showPairDiffBatch } = require('./pair_diff_batch');
const dashboard = require('./dashboard');
const { runKind, readSyncConfig, readMeta } = require('./sync_engine');
const { showInfoAuto } = require('./toast');
const { ageText } = require('./time_fmt');
const statusBar = require('./status_bar');

const COMMAND_PREFIX = 'zkz-sandbox';

function command(name) {
  return COMMAND_PREFIX + '.' + name;
}

function refreshSyncStatus() {
  statusBar.refreshStatus();
}

async function sync(kind, opts) {
  assertSandboxSync();
  const pair = resolvePair();
  const silent = !!(opts && typeof opts === 'object' && opts.silent);
  const lines = [];
  const logLine = (msg) => {
    log(msg);
    lines.push(String(msg));
  };
  await withSyncLock(kind, () => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'zkz Sync: ' + kind, cancellable: true },
    (_progress, token) => runKind(kind, pair.w1, pair.sandbox, token, logLine)
  ));
  refreshSyncStatus();
  if (!silent) {
    vscode.window.showInformationMessage('zkz Sync: ' + kind + ' completed');
  }
  return lines;
}

async function showSyncMenu(api) {
  assertSandboxSync();
  let toUtfAge = '-';
  let toGbAge = '-';
  let batchDesc = 'core/application/driver';
  let syncAllFlag = false;
  let verifyAllFlag = false;
  try {
    const pair0 = resolvePair();
    const meta0 = readMeta(pair0.sandbox) || {};
    toUtfAge = ageText(meta0.syncedAt);
    toGbAge = ageText(meta0.lastFromUtf8At);
    const cfg0 = readSyncConfig(pair0.sandbox);
    syncAllFlag = !!cfg0.syncAll;
    verifyAllFlag = !!cfg0.verifyAll;
    const pdb = require('./pair_diff_batch');
    const topsU = pdb.scanTopsForBatch(pair0.sandbox);
    batchDesc = topsU.length
      ? pdb.describeBatchScanTops(pair0.sandbox)
      : pdb.describeBatchScanTops(pair0.w1);
  } catch (_) { /* ignore */ }
  const Sep = vscode.QuickPickItemKind.Separator;
  const dailyScope = syncAllFlag ? '\u4e1a\u52a1+\u5e93' : '\u4e1a\u52a1';
  const dailySep = syncAllFlag
    ? '\u65e5\u5e38\u540c\u6b65\uff08syncAll \u4e1a\u52a1+\u5e93\u00b7stamp\uff09'
    : '\u65e5\u5e38\u540c\u6b65\uff08\u4e1a\u52a1\uff09';
  const toGbDailyLabel = verifyAllFlag
    ? (syncAllFlag
      ? '$(arrow-up) ToGb (verifyAll \u4e1a\u52a1+\u5e93)'
      : '$(arrow-up) ToGb (verifyAll)')
    : (syncAllFlag
      ? '$(arrow-up) ToGb (syncAll stamp)'
      : '$(arrow-up) ToGb stamp\u5dee');
  const toGbDailyDesc = verifyAllFlag
    ? ('.zkz/sync.jsonc verifyAll \u00b7 ' + dailyScope + ' \u5168\u6587\u6838\u5bf9 \u00b7 ' + toGbAge)
    : (syncAllFlag
      ? '.zkz/sync.jsonc syncAll \u00b7 ' + dailyScope + ' stamp \u00b7 ' + toGbAge
      : '\u6c99\u7bb1 \u2192 \u771f\u6e90 \u00b7 ' + toGbAge);
  const pick = await vscode.window.showQuickPick([
    { label: '\u6982\u89c8\u4e0e\u5bf9\u6bd4', kind: Sep },
    { label: '$(dashboard) \u540c\u6b65/\u7f16\u7801\u4eea\u8868\u76d8', description: '\u51b2\u7a81\u3001\u65f6\u95f4\u3001GBK/FFFD\u3001\u94fe\u63a5', id: 'dash' },
    { label: '$(diff) \u672c\u6e90 \u2194 \u6c99\u7bb1', description: '\u5f53\u524d\u6587\u4ef6\u6216\u8f93\u5165\u8def\u5f84\u5bf9\u6bd4', id: 'pairDiff' },
    { label: '$(search) \u6279\u91cf\u5dee\u5f02', description: '\u626b\u63cf ' + batchDesc, id: 'pairDiffBatch' },
    { label: dailySep, kind: Sep },
    {
      label: syncAllFlag ? '$(arrow-down) ToUtf (syncAll stamp)' : '$(arrow-down) ToUtf stamp\u5dee',
      description: syncAllFlag
        ? '.zkz/sync.jsonc syncAll \u00b7 \u771f\u6e90 \u2192 ' + dailyScope + ' stamp \u00b7 ' + toUtfAge
        : '\u771f\u6e90 \u2192 \u6c99\u7bb1 \u00b7 ' + toUtfAge,
      id: 'toUtf'
    },
    { label: toGbDailyLabel, description: toGbDailyDesc, id: 'toGb' },
    { label: '\u6838\u5bf9\u4e0e\u5e93', kind: Sep },
    { label: '$(arrow-down) ToUtf (\u4e0d\u9884\u8fc7\u6ee4)', description: '\u4e0d\u8d70 ChangedOnly\uff0c\u9010\u6587\u4ef6 stamp/\u5185\u5bb9' + (syncAllFlag ? ' \u00b7 \u542b\u5e93' : ''), id: 'toUtfAll' },
    { label: '$(arrow-up) ToGb (\u5168\u6587\u6838\u5bf9)', description: '-All \u5f3a\u5236\u5185\u5bb9\u6838\u5bf9\uff08\u6162\uff09\u00b7\u6216 sync.jsonc verifyAll' + (syncAllFlag ? ' \u00b7 \u542b\u5e93' : ''), id: 'toGbAll' },
    { label: '$(library) ToUtf (libs)', description: '\u672c\u6e90\u5e93 \u2192 \u6c99\u7bb1\uff08\u4e0d\u542b\u65e5\u5e38\u4e1a\u52a1\uff09', id: 'toUtfLibs' },
    { label: '$(library) ToGb (libs)', description: '\u6c99\u7bb1\u5e93 \u2192 \u672c\u6e90\uff08\u56de\u5199\u00b7\u8c28\u614e\uff09', id: 'toGbLibs' },
    { label: '$(trash) ToUtf Full', description: 'wipe + libs \u00b7 \u5371\u9669', id: 'toUtfFull' },
    { label: '$(discard) reset \u6c99\u7bb1', description: 'reset --hard \u2192 origin/maUtf\uff08utf\u5960\u57fa\uff09', id: 'resetSandbox' },
    { label: '\u7ef4\u62a4', kind: Sep },
    { label: '$(refresh) Refresh', description: 'refresh status bar', id: 'refresh' }
  ], { placeHolder: 'zkz sync \u00b7 \u6309\u5206\u7c7b\u9009\u62e9' });
  if (!pick || pick.kind === Sep) return;
  if (pick.id === 'refresh') { refreshSyncStatus(); return; }
  if (pick.id === 'dash') { await dashboard.showDashboard(api); return; }
  if (pick.id === 'pairDiff') { await diffSandboxW1(); return; }
  if (pick.id === 'pairDiffBatch') { await showPairDiffBatch(); return; }
  if (pick.id === 'resetSandbox') {
    const pair = resolvePair();
    const { sandboxHasGit, resetSandboxToFoundation } = require('./git');
    if (!sandboxHasGit(pair.sandbox)) {
      vscode.window.showErrorMessage('\u6c99\u7bb1\u4e0d\u662f Git \u4ed3\u5e93\uff0c\u65e0\u6cd5 reset');
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      'reset \u6c99\u7bb1\uff1areset --hard \u2192 origin/maUtf\uff08utf\u5960\u57fa\uff09\u3002\n' +
      '\u5c06\u4e22\u5f03\u6c99\u7bb1\u672a\u63d0\u4ea4\u66f4\u6539\u4e0e\u5960\u57fa\u4e4b\u540e\u7684\u672c\u5730\u63d0\u4ea4\u3002',
      { modal: true },
      '\u786e\u8ba4 reset'
    );
    if (ok !== '\u786e\u8ba4 reset') return;
    await withSyncLock('reset sandbox', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'reset \u6c99\u7bb1' },
        async () => {
          const r = await resetSandboxToFoundation(pair.sandbox);
          void showInfoAuto(
            'sandbox reset utf\u5960\u57fa @ ' + (r.head || '?') +
            (r.subject ? (' \u300c' + r.subject + '\u300d') : '')
          );
        }
      );
    });
    refreshSyncStatus();
    return;
  }
  return sync(pick.id);
}

function copyDebugAxfCmd() {
  const pair = resolvePair();
  return require('./compile_commands').copyDebugAxf(pair.w1, pair.sandbox, log);
}

function activate(context) {
  const wrap = (fn) => async (...args) => {
    try { return await fn(...args); }
    catch (e) {
      const opts = args[0];
      const silent = !!(opts && typeof opts === 'object' && opts.silent);
      if (!silent) vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
      if (silent) throw e;
    }
  };
  const api = {
    resolvePair,
    withProgress: require('./shared').withProgress,
    log,
    runGit: (cwd, args) => require('./git').runGit(cwd, args),
    getW1RemoteSyncState: (w1) => require('./git').getW1RemoteSyncState(w1),
    isGitManageEnabled: require('./git_manage').isGitManageEnabled
  };

  statusBar.activate(context);
  context.subscriptions.push(
    vscode.commands.registerCommand(command('syncMenu'), wrap(() => showSyncMenu(api))),
    vscode.commands.registerCommand(command('toUtf'), wrap((opts) => sync('toUtf', opts))),
    vscode.commands.registerCommand(command('toUtfAll'), wrap((opts) => sync('toUtfAll', opts))),
    vscode.commands.registerCommand(command('toUtfLibs'), wrap((opts) => sync('toUtfLibs', opts))),
    vscode.commands.registerCommand(command('toUtfFull'), wrap((opts) => sync('toUtfFull', opts))),
    vscode.commands.registerCommand(command('toGb'), wrap((opts) => sync('toGb', opts))),
    vscode.commands.registerCommand(command('copyDebugAxf'), wrap((opts) => copyDebugAxfCmd(opts))),
    vscode.commands.registerCommand(command('toGbAll'), wrap((opts) => sync('toGbAll', opts))),
    vscode.commands.registerCommand(command('toGbLibs'), wrap((opts) => sync('toGbLibs', opts))),
    vscode.commands.registerCommand(command('showDashboard'), wrap(() => dashboard.showDashboard(api))),
    vscode.commands.registerCommand(command('syncFrom'), wrap((opts) => sync('toGb', opts))),
    vscode.commands.registerCommand(command('pullSandbox'), wrap((opts) => sync('toUtf', opts))),
    vscode.commands.registerCommand(command('refreshStatus'), () => refreshSyncStatus())
  );
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.syncEnabled', isSandboxWorkspace());
}

function deactivate() {
  try { statusBar.deactivate(); } catch (_) { /* ignore */ }
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.syncEnabled', false);
}

module.exports = { activate, deactivate, refreshSyncStatus };
