'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { showInfoAuto, withProgress, log } = require('./util');
const { resolvePair } = require('./pair');
const { refreshCompileCommands: refreshCompileCommandsFile, resolveKeilLayout } = require('./compile_commands');
const { isCompileCommandsStale, gitHead, readHeadOid } = require('./cc_stamp');
const { startHeadWatch } = require('./head_watch');
const {
  findYtVersion,
  loadMacroTable,
  invalidateMacroTable,
  revealMacroInYtVersion,
  isTrackedMacro,
  isMacroKeyShown,
  machineFingerprint,
  formatMacroLines,
  listedMacroNames,
  formatMacroBadge
} = require('./macros');
const { diffMacroValues, invalidateIndexForMacroChanges } = require('./macro_impact');
const ifdefFold = require('./ifdef_fold');
const fffd = require('./fffd');
const statusBar = require('./status_bar');

const PREFIX = 'zkz-code';

/** @type {Record<string, string>} */
let gLastMacros = {};
let gLastMachineFp = '';
let gYtPromptKey = '';
let gYtPromptAt = 0;
let gRefreshTimer = null;
let gRefreshInFlight = false;
let gRefreshQueued = false;
let gYtWatchSuppressUntil = 0;
let gYtWatchSuppressPath = '';
let gMacroBaselineFrozen = false;
let gMacroBaselineFreezeTimer = null;
let bar = null;
let gLastHeadHandled = '';
let gLastHeadAt = 0;
let gCcPromptedHead = '';
let gCcRefreshInFlight = false;
let gCcRefreshQueued = false;

function command(name) {
  return PREFIX + '.' + name;
}

function suppressYtVersionWatch(filePath, ms) {
  gYtWatchSuppressUntil = Date.now() + (ms || 1500);
  gYtWatchSuppressPath = filePath
    ? path.normalize(String(filePath)).toLowerCase()
    : '';
}

function isYtVersionWatchSuppressed(filePath) {
  if (Date.now() > gYtWatchSuppressUntil) return false;
  if (!filePath) return true;
  if (!gYtWatchSuppressPath) return true;
  const p = path.normalize(String(filePath)).toLowerCase();
  return p === gYtWatchSuppressPath || /[\\/]yt_version\.h$/i.test(p);
}

function beginYtMacroCheckoutGuard(ms) {
  const hold = typeof ms === 'number' && ms > 0 ? ms : 120000;
  gMacroBaselineFrozen = true;
  suppressYtVersionWatch('', hold);
  if (gMacroBaselineFreezeTimer) clearTimeout(gMacroBaselineFreezeTimer);
  gMacroBaselineFreezeTimer = setTimeout(() => {
    gMacroBaselineFreezeTimer = null;
    gMacroBaselineFrozen = false;
  }, hold);
}

function endYtMacroCheckoutGuard() {
  if (gMacroBaselineFreezeTimer) {
    clearTimeout(gMacroBaselineFreezeTimer);
    gMacroBaselineFreezeTimer = null;
  }
  gMacroBaselineFrozen = false;
  suppressYtVersionWatch('', 2000);
}

function workspaceRoot() {
  return (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || '';
}

function sourceRoot() {
  try { return resolvePair().root; } catch (_) { return workspaceRoot(); }
}

function findWorkspaceYtVersion() {
  const root = workspaceRoot();
  return findYtVersion(root) || findYtVersion(sourceRoot());
}

function clangdRoot() {
  return workspaceRoot() || sourceRoot();
}

function shouldTrackCc(root) {
  if (!root) return false;
  if (fs.existsSync(path.join(root, 'compile_commands.json'))) return true;
  try {
    const layout = resolveKeilLayout(root);
    return !!(layout && (fs.existsSync(layout.ytswarm) || fs.existsSync(layout.projectFile)));
  } catch (_) {
    return false;
  }
}

function refreshCcBadge() {
  if (!bar || !bar.alive()) return;
  const root = clangdRoot() || sourceRoot();
  if (!shouldTrackCc(root)) {
    bar.setCc(false, false);
    return;
  }
  bar.setCc(true, isCompileCommandsStale(root));
}

function maybePromptCcFail(root, head, err) {
  if (head && gCcPromptedHead === head) return;
  if (head) gCcPromptedHead = head;
  const msg = String(err && err.message ? err.message : err);
  void vscode.window.showWarningMessage(
    'compile_commands \u81ea\u52a8\u5237\u65b0\u5931\u8d25: ' + msg,
    '\u91cd\u8bd5'
  ).then((choice) => {
    if (choice === '\u91cd\u8bd5') void refreshCompileCommands();
  });
}

async function autoRefreshCc(root, head, opts) {
  if (!shouldTrackCc(root)) return;
  if (!isCompileCommandsStale(root, head)) {
    refreshCcBadge();
    return;
  }
  if (gCcRefreshInFlight) {
    gCcRefreshQueued = true;
    return;
  }
  gCcRefreshInFlight = true;
  refreshCcBadge();
  try {
    const run = () => refreshCompileCommandsFile(root, { force: true, log });
    if (opts && opts.notify) {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'zkz-code：检测到分支切换，正在刷新 compile_commands',
        cancellable: false
      }, run);
    } else {
      await run();
    }
  } catch (e) {
    log('compile_commands auto refresh failed: ' + String(e && e.message ? e.message : e));
    maybePromptCcFail(root, head, e);
  } finally {
    gCcRefreshInFlight = false;
    refreshCcBadge();
    if (gCcRefreshQueued) {
      gCcRefreshQueued = false;
      const nextRoot = clangdRoot() || sourceRoot() || root;
      void autoRefreshCc(nextRoot, gitHead(nextRoot), opts);
    }
  }
}

async function onHeadChanged(payload) {
  const root = (payload && payload.root) || clangdRoot() || sourceRoot();
  const to = (payload && payload.to) ? String(payload.to) : gitHead(root);
  if (!to) return;
  const now = Date.now();
  if (to === gLastHeadHandled && (now - gLastHeadAt) < 2000) return;
  gLastHeadHandled = to;
  gLastHeadAt = now;

  beginYtMacroCheckoutGuard(120000);
  try {
    await syncYtMacros({ reason: 'checkout', prompt: true });
  } finally {
    endYtMacroCheckoutGuard();
    refreshStatus();
  }
  void autoRefreshCc(root, to, { notify: true });
}

function alignYtMacroBaseline(macros) {
  if (gMacroBaselineFrozen) return false;
  if (!macros || typeof macros !== 'object') return false;
  const fp = machineFingerprint(macros);
  const changed = Object.keys(gLastMacros).length
    ? diffMacroValues(gLastMacros, macros)
    : Object.keys(macros);
  if (!Object.keys(gLastMacros).length || changed.length || fp !== gLastMachineFp) {
    gLastMacros = macros;
    gLastMachineFp = fp;
    return true;
  }
  return false;
}

async function reindexClangd() {
  const root = clangdRoot();
  if (!root) throw new Error('Open a workspace first');
  const indexDir = path.join(root, '.cache', 'clangd');
  await withProgress('Reindex clangd', async () => {
    if (fs.existsSync(indexDir)) {
      fs.rmSync(indexDir, { recursive: true, force: true });
    }
    for (const cmd of ['clangd.restart', 'clangd.restartLanguageServer']) {
      try { await vscode.commands.executeCommand(cmd); break; } catch (_) { /* next */ }
    }
  });
  log('clangd index cleared: ' + indexDir);
  void showInfoAuto('clangd index cleared: ' + indexDir);
}

async function restartClangd() {
  let restarted = false;
  await withProgress('Restart clangd', async () => {
    for (const cmd of ['clangd.restart', 'clangd.restartLanguageServer']) {
      try {
        await vscode.commands.executeCommand(cmd);
        restarted = true;
        break;
      } catch (_) { /* try next */ }
    }
  });
  if (!restarted) throw new Error('clangd restart command unavailable');
  log('clangd restarted');
  void showInfoAuto('clangd restarted');
}

async function refreshCompileCommands() {
  let root = workspaceRoot();
  try {
    const ids = await vscode.commands.getCommands(true);
    if (ids.indexOf('zkz-native.resolveRoot') >= 0) {
      const r = await vscode.commands.executeCommand('zkz-native.resolveRoot');
      if (r && r.root) root = r.root;
    }
  } catch (_) { /* 未装 native 时用当前工作区 */ }
  if (!root) root = sourceRoot();
  if (!root) throw new Error('Open a workspace first');
  await withProgress('Refresh compile_commands', () =>
    refreshCompileCommandsFile(root, { force: true, log })
  );
  gCcPromptedHead = gitHead(root) || gCcPromptedHead;
  refreshCcBadge();
  void showInfoAuto('compile_commands refreshed (restart clangd if needed)');
}

async function syncYtMacros(opts) {
  const reason = (opts && opts.reason) || 'status';
  const prompt = !!(opts && opts.prompt);
  let macros;
  try {
    const table = loadMacroTable({
      workspaceRoot: clangdRoot(),
      text: (opts && opts.text != null) ? String(opts.text) : undefined,
      filePath: (opts && opts.filePath) || findWorkspaceYtVersion() || undefined
    });
    if (!table.filePath && !Object.keys(table.macros).length) {
      return { changed: [], updated: false };
    }
    macros = table.macros;
  } catch (_) {
    return { changed: [], updated: false };
  }

  const fp = machineFingerprint(macros);
  const changedAll = Object.keys(gLastMacros).length ? diffMacroValues(gLastMacros, macros) : [];
  // 弹窗/刷索引只看白名单；折叠用全量，非白名单变了也要重折
  const changed = changedAll.filter((k) => isTrackedMacro(k));
  if (gMacroBaselineFrozen && reason !== 'checkout' && reason !== 'save') {
    return { changed: changed, updated: false, frozen: true };
  }
  const prevFp = gLastMachineFp;
  gLastMacros = macros;
  gLastMachineFp = fp;

  if (changedAll.length) {
    try { ifdefFold.onMacrosChanged(); } catch (_) { /* ignore */ }
  }

  if (!prompt || !changed.length) {
    return { changed: changed, updated: true };
  }

  const dedupKey = fp + '|' + changed.slice().sort().join(',');
  const now = Date.now();
  if (dedupKey === gYtPromptKey && (now - gYtPromptAt) < 120000) {
    return { changed: changed, updated: true, deduped: true };
  }
  gYtPromptKey = dedupKey;
  gYtPromptAt = now;

  const preview = changed.slice(0, 8).join(', ') + (changed.length > 8 ? '...' : '');
  const machineHint = (prevFp && fp !== prevFp) ? '\u673a\u578b\u6307\u7eb9\u4e5f\u53d8\u4e86\u3002' : '';
  let reasonHint = '\u5b8f';
  if (reason === 'checkout') reasonHint = '\u5206\u652f\u5207\u6362\u540e';
  else if (reason === 'disk') reasonHint = '\u78c1\u76d8\u6587\u4ef6\u53d8\u66f4\u540e';
  const choice = await vscode.window.showInformationMessage(
    reasonHint + '\u5df2\u53d8\u5316 ' + changed.length + '\u9879: ' + preview + '\u3002' + machineHint +
    '\u53ef\u6309\u5f15\u7528\u6587\u4ef6\u5220\u9664\u5bf9\u5e94 clangd .idx\uff08\u4e0d\u662f\u5168\u91cf\u6e05\u7d22\u5f15\uff09\u3002',
    '\u5c40\u90e8\u5237\u65b0\u7d22\u5f15',
    '\u5168\u91cf\u91cd\u5efa\u7d22\u5f15',
    '\u7a0d\u540e'
  );
  if (choice === '\u5c40\u90e8\u5237\u65b0\u7d22\u5f15') {
    const r = await invalidateIndexForMacroChanges(clangdRoot(), changed);
    const searchN = (r.searchMacros && r.searchMacros.length) ? r.searchMacros.length : changed.length;
    void showInfoAuto(
      '\u5df2\u5220 ' + r.removed + ' \u4e2a .idx\uff08\u79cd\u5b50 ' + changed.length +
      ' / \u68c0\u7d22 ' + searchN + ' \u5b8f, \u547d\u4e2d ' + r.files.length +
      ' \u4e2a\u6587\u4ef6\uff09' + (r.restarted ? '\uff0c\u5df2\u8bf7\u6c42 clangd \u91cd\u542f' : '')
    );
  } else if (choice === '\u5168\u91cf\u91cd\u5efa\u7d22\u5f15') {
    await reindexClangd();
  }
  return { changed: changed, updated: true };
}

function refreshStatus() {
  if (!bar || !bar.alive()) return;
  refreshCcBadge();
  if (gRefreshTimer) clearTimeout(gRefreshTimer);
  gRefreshTimer = setTimeout(() => {
    gRefreshTimer = null;
    void runRefreshStatusMerged();
  }, 250);
}

async function runRefreshStatusMerged() {
  if (!bar || !bar.alive()) return;
  if (gRefreshInFlight) {
    gRefreshQueued = true;
    return;
  }
  gRefreshInFlight = true;
  try {
    await refreshMacroBadge();
  } finally {
    gRefreshInFlight = false;
    if (gRefreshQueued) {
      gRefreshQueued = false;
      void runRefreshStatusMerged();
    }
  }
}

async function refreshMacroBadge() {
  if (!bar || !bar.alive()) return;
  const ver = findWorkspaceYtVersion();
  if (!ver) {
    bar.setMacro('$(symbol-misc) yt_version?', 'yt_version.h not found');
    return;
  }
  try {
    const macros = loadMacroTable({ filePath: ver }).macros;
    alignYtMacroBaseline(macros);
    const lines = formatMacroLines(macros);
    const preview = lines.slice(0, 10).join('\n');
    const more = lines.length > 10 ? ('\n... 另有 ' + (lines.length - 10) + ' 项') : '';
    bar.setMacro(
      '$(symbol-misc) ' + formatMacroBadge(macros),
      [ver, preview + more].filter(Boolean).join('\n')
    );
  } catch (e) {
    bar.setMacro('$(symbol-misc) yt_version?', String(e && e.message ? e.message : e));
  }
}

function macroMenuItems() {
  const ver = findWorkspaceYtVersion();
  if (!ver) return [];
  let detailed;
  try { detailed = loadMacroTable({ filePath: ver }); } catch (_) { return []; }
  const macros = detailed.macros || {};
  const locs = detailed.locs || {};
  const names = listedMacroNames(macros);
  const items = [];
  if (vscode.QuickPickItemKind) {
    items.push({ label: '宏', kind: vscode.QuickPickItemKind.Separator });
  }
  items.push({ label: '$(file) 打开 yt_version.h', filePath: ver, line: 1 });
  for (let i = 0; i < names.length; i++) {
    const k = names[i];
    const v = macros[k];
    items.push({
      label: (v === '' || v == null) ? ('#define ' + k) : (k + '=' + v),
      filePath: ver,
      name: k,
      line: locs[k] || 0
    });
  }
  return items;
}

async function openMacroPick(pick) {
  if (!pick || !pick.filePath) return;
  if (!pick.line) {
    vscode.window.showWarningMessage('未找到定义行: ' + (pick.name || ''));
    return;
  }
  await revealMacroInYtVersion(pick.filePath, pick.line);
}

async function showMacros() {
  const ver = findWorkspaceYtVersion();
  if (!ver) throw new Error('yt_version.h not found');
  const detailed = loadMacroTable({ filePath: ver });
  const macros = detailed.macros;
  const locs = detailed.locs || {};
  const names = listedMacroNames(macros);
  if (!names.length) {
    void showInfoAuto('\u65e0\u5df2\u542f\u7528\u5b8f\uff08\u6216\u4ec5\u6709 =0\uff09');
    return;
  }
  const items = [
    { label: '$(file) \u6253\u5f00 yt_version.h', description: ver, id: 'open' },
    ...names.map((k) => {
      const v = macros[k];
      return {
        label: (v === '' || v == null) ? ('#define ' + k) : (k + '=' + v),
        description: locs[k] ? ('L' + locs[k]) : '',
        id: 'macro',
        name: k,
        line: locs[k] || 0
      };
    })
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: '\u9009\u62e9\u5b8f\u4ee5\u8df3\u8f6c\u5230\u5b9a\u4e49 \u2014 ' + path.basename(ver),
    matchOnDescription: true
  });
  if (!pick) return;
  if (pick.id === 'open') {
    await revealMacroInYtVersion(ver, 1);
    return;
  }
  if (!pick.line) {
    vscode.window.showWarningMessage('\u672a\u627e\u5230\u5b9a\u4e49\u884c: ' + pick.name);
    return;
  }
  await revealMacroInYtVersion(ver, pick.line);
}

async function invalidateMacroImpact() {
  const ver = findWorkspaceYtVersion();
  if (!ver) throw new Error('yt_version.h not found');
  const macros = loadMacroTable({ filePath: ver }).macros;
  const changed = Object.keys(gLastMacros).length
    ? diffMacroValues(gLastMacros, macros).filter((k) => isTrackedMacro(k))
    : Object.keys(macros).filter((k) => isTrackedMacro(k) && isMacroKeyShown(k, macros[k]));
  if (!changed.length) {
    void showInfoAuto('\u65e0\u5b8f\u53d8\u5316\u53ef\u7528\uff08\u76f8\u5bf9\u4e0a\u6b21\u5feb\u7167\uff09');
    return;
  }
  const r = await invalidateIndexForMacroChanges(clangdRoot(), changed);
  gLastMacros = macros;
  gLastMachineFp = machineFingerprint(macros);
  const searchN = (r.searchMacros && r.searchMacros.length) ? r.searchMacros.length : changed.length;
  void showInfoAuto(
    '\u5b8f ' + changed.length + '\u9879(\u68c0\u7d22 ' + searchN + ') \u2192 \u6587\u4ef6 ' + r.files.length +
    ' \u2192 \u5220 .idx ' + r.removed + (r.restarted ? ' + clangd restart' : '')
  );
}

function activate(context) {
  const wrap = (fn) => async (...args) => {
    try { await fn(...args); }
    catch (e) { vscode.window.showErrorMessage(String(e && e.message ? e.message : e)); }
  };

  bar = statusBar.create(context, {
    macroItems: macroMenuItems,
    openMacro: openMacroPick
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(command('showMacros'), wrap(showMacros)),
    vscode.commands.registerCommand(command('invalidateMacroImpactIndex'), wrap(invalidateMacroImpact)),
    vscode.commands.registerCommand(command('refreshCompileCommands'), wrap(refreshCompileCommands)),
    vscode.commands.registerCommand(command('reindexClangd'), wrap(reindexClangd)),
    vscode.commands.registerCommand(command('restartClangd'), wrap(restartClangd)),
    vscode.commands.registerCommand(command('refreshStatus'), wrap(async () => refreshStatus())),
    vscode.commands.registerCommand(command('beginYtMacroCheckoutGuard'), wrap(async () => {
      beginYtMacroCheckoutGuard(120000);
    })),
    vscode.commands.registerCommand(command('syncYtVersionAfterCheckout'), wrap(async () => {
      if (!gMacroBaselineFrozen) suppressYtVersionWatch('', 2000);
      try {
        await syncYtMacros({ reason: 'checkout', prompt: true });
      } finally {
        endYtMacroCheckoutGuard();
        refreshStatus();
      }
    })),
    vscode.commands.registerCommand(command('onHeadChanged'), wrap(async (payload) => {
      await onHeadChanged(payload || {});
    }))
  );

  fffd.activate(context, {
    command: command,
    workspaceRoot: workspaceRoot,
    resolveRoot: sourceRoot,
    showInfoAuto: showInfoAuto
  });

  let ytDiskDebounce = null;
  const onYtVersionSaved = async (doc) => {
    if (!doc || doc.uri.scheme !== 'file') return;
    if (!/yt_version\.h$/i.test(doc.uri.fsPath)) return;
    suppressYtVersionWatch(doc.uri.fsPath, 1500);
    try { await syncYtMacros({ reason: 'save', text: doc.getText(), prompt: true }); } catch (_) { /* ignore */ }
    refreshStatus();
  };
  const ytWatcher = vscode.workspace.createFileSystemWatcher('**/yt_version.h');
  const onYtDiskChanged = (uri) => {
    if (!uri || uri.scheme !== 'file') return;
    if (isYtVersionWatchSuppressed(uri.fsPath)) return;
    if (ytDiskDebounce) clearTimeout(ytDiskDebounce);
    ytDiskDebounce = setTimeout(() => {
      ytDiskDebounce = null;
      if (isYtVersionWatchSuppressed(uri.fsPath)) return;
      void syncYtMacros({ reason: 'disk', prompt: false, filePath: uri.fsPath }).then(() => refreshStatus());
    }, 400);
  };

  // .clangd -D 也是宏表输入；折叠不再自己解析，这里统一失效再刷
  let clangdDebounce = null;
  const onClangdChanged = () => {
    if (clangdDebounce) clearTimeout(clangdDebounce);
    clangdDebounce = setTimeout(() => {
      clangdDebounce = null;
      invalidateMacroTable();
      try { ifdefFold.onMacrosChanged(); } catch (_) { /* ignore */ }
      refreshStatus();
    }, 400);
  };
  const clangdWatcher = vscode.workspace.createFileSystemWatcher('**/.clangd');

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => refreshStatus()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const fp = (doc && doc.uri && doc.uri.fsPath) || '';
      if (/(^|[\\/])\.clangd$/i.test(fp)) {
        onClangdChanged();
        return;
      }
      void onYtVersionSaved(doc);
    }),
    ytWatcher,
    ytWatcher.onDidChange(onYtDiskChanged),
    ytWatcher.onDidCreate(onYtDiskChanged),
    clangdWatcher,
    clangdWatcher.onDidChange(onClangdChanged),
    clangdWatcher.onDidCreate(onClangdChanged),
    clangdWatcher.onDidDelete(onClangdChanged),
    {
      dispose: () => {
        if (ytDiskDebounce) clearTimeout(ytDiskDebounce);
        if (clangdDebounce) clearTimeout(clangdDebounce);
        if (gRefreshTimer) clearTimeout(gRefreshTimer);
        if (gMacroBaselineFreezeTimer) clearTimeout(gMacroBaselineFreezeTimer);
        gMacroBaselineFrozen = false;
        if (bar) bar.dispose();
        bar = null;
      }
    }
  );

  refreshStatus();
  refreshCcBadge();
  const headRoot = clangdRoot() || sourceRoot();
  if (headRoot) {
    const head = readHeadOid(headRoot) || gitHead(headRoot);
    if (head && isCompileCommandsStale(headRoot, head)) void autoRefreshCc(headRoot, head);
    setImmediate(async () => {
      let nativeOn = false;
      try { nativeOn = !!(await vscode.commands.executeCommand('zkz-native.isEnabled')); } catch (_) { nativeOn = false; }
      if (!nativeOn) startHeadWatch(context, headRoot, (payload) => onHeadChanged(payload));
    });
  }
}

function deactivate() {
  if (bar) bar.dispose();
  bar = null;
}

module.exports = {
  activate,
  deactivate,
  refreshStatus,
  findWorkspaceYtVersion,
  beginYtMacroCheckoutGuard,
  endYtMacroCheckoutGuard
};
