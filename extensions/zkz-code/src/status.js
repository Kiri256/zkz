'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { showInfoAuto, withProgress, log } = require('./util');
const loadShared = require('./load_shared');
const { resolvePair } = loadShared('pair');
const { refreshCompileCommands: refreshCompileCommandsFile, resolveKeilLayout } = require('./compile_commands');
const { readHeadName, isCompileCommandsBranchStale } = require('./cc_stamp');
const { startHeadWatch } = require('./head_watch');
const {
  findYtVersion,
  isYtVersionPath,
  resolveMacroRoot,
  loadMacroTable,
  invalidateMacroTable,
  revealMacroInYtVersion,
  isTrackedMacro,
  formatMacroLines,
  listedMacroNames,
  formatMacroBadge
} = require('./macros');
const { diffMacroValues, clearClangdIndex, restartClangdSoft } = require('./macro_impact');
const ifdefFold = require('./ifdef_fold');
const statusBar = require('./status_bar');

const PREFIX = 'zkz-code';

/** @type {Record<string, string>} 上次看到的宏表。保存和刷徽章会推进。 */
let gLastMacros = {};
/** 连续保存合并成一次 clangd 重启。 */
let gClangdRestartTimer = null;
const CLANGD_RESTART_DEBOUNCE_MS = 1000;
let gRefreshTimer = null;
let gRefreshInFlight = false;
let gRefreshQueued = false;
let gYtWatchSuppressUntil = 0;
let gYtWatchSuppressPath = '';
let gHeadSync = false;
let bar = null;
let gLastHeadHandled = '';
let gLastHeadAt = 0;
let gCcPromptedBranch = '';
let gCcRefreshInFlight = false;
let gCcRefreshQueued = false;
let gCcRefreshQueuedBranch = false;

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

function projectRoot(filePath) {
  try { return resolvePair(filePath || '').root; } catch (_) { return ''; }
}

function findWorkspaceYtVersion() {
  return findYtVersion(projectRoot());
}

function isWorkspaceYtVersion(fsPath) {
  const want = findWorkspaceYtVersion();
  if (!want || !fsPath) return false;
  return path.resolve(want).toLowerCase() === path.resolve(fsPath).toLowerCase();
}

function shouldTrackCc(root) {
  if (!root) return false;
  if (fs.existsSync(path.join(root, 'compile_commands.json'))) return true;
  try {
    const layout = resolveKeilLayout(root);
    return !!(layout && layout.projectFile && fs.existsSync(layout.projectFile));
  } catch (_) {
    return false;
  }
}

function refreshCcBadge() {
  if (!bar || !bar.alive()) return;
  const root = projectRoot();
  if (!shouldTrackCc(root)) {
    bar.setCc(false, false);
    return;
  }
  bar.setCc(true, isCompileCommandsBranchStale(root));
}

function maybePromptCcFail(branch, err) {
  if (branch && gCcPromptedBranch === branch) return;
  if (branch) gCcPromptedBranch = branch;
  const msg = String(err && err.message ? err.message : err);
  void vscode.window.showWarningMessage(
    'compile_commands 自动刷新失败: ' + msg,
    '重试'
  ).then((choice) => {
    if (choice === '重试') void refreshCompileCommands();
  });
}

async function autoRefreshCc(root, branch, opts) {
  if (!shouldTrackCc(root)) return;
  const missing = !fs.existsSync(path.join(root, 'compile_commands.json'));
  const onBranch = !!(opts && opts.branch);
  if (!missing && !onBranch) {
    refreshCcBadge();
    return;
  }
  if (gCcRefreshInFlight) {
    gCcRefreshQueued = true;
    if (onBranch) gCcRefreshQueuedBranch = true;
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
    gCcPromptedBranch = '';
  } catch (e) {
    log('compile_commands auto refresh failed: ' + String(e && e.message ? e.message : e));
    maybePromptCcFail(branch, e);
  } finally {
    gCcRefreshInFlight = false;
    refreshCcBadge();
    if (gCcRefreshQueued) {
      const branch = gCcRefreshQueuedBranch;
      gCcRefreshQueued = false;
      gCcRefreshQueuedBranch = false;
      const nextRoot = projectRoot() || root;
      const nextOpts = branch ? { notify: true, branch: true } : opts;
      void autoRefreshCc(nextRoot, readHeadName(nextRoot), nextOpts);
    }
  }
}

async function onHeadChanged(payload) {
  const root = (payload && payload.root) || projectRoot();
  const to = (payload && payload.to) ? String(payload.to) : readHeadName(root);
  if (!to) return;
  const now = Date.now();
  if (to === gLastHeadHandled && (now - gLastHeadAt) < 2000) return;
  gLastHeadHandled = to;
  gLastHeadAt = now;

  gHeadSync = true;
  suppressYtVersionWatch('', 5000);
  try {
    await syncYtMacros({ reason: 'checkout', prompt: true });
  } finally {
    gHeadSync = false;
    suppressYtVersionWatch('', 2000);
    refreshStatus();
  }
  void autoRefreshCc(root, to, { notify: true, branch: true });
}

function adoptSeenMacros(macros) {
  gLastMacros = macros || {};
}

function alignYtMacroBaseline(macros) {
  if (gHeadSync) return false;
  if (!macros || typeof macros !== 'object') return false;
  const changed = Object.keys(gLastMacros).length
    ? diffMacroValues(gLastMacros, macros)
    : Object.keys(macros);
  if (!Object.keys(gLastMacros).length || changed.length) {
    adoptSeenMacros(macros);
    return true;
  }
  return false;
}

async function refreshCompileCommands() {
  const root = projectRoot();
  if (!root) throw new Error('Open a workspace first');
  try {
    await withProgress('Refresh compile_commands', () =>
      refreshCompileCommandsFile(root, { force: true, log })
    );
    gCcPromptedBranch = '';
  } catch (e) {
    refreshCcBadge();
    throw e;
  }
  refreshCcBadge();
  void showInfoAuto('compile_commands refreshed (restart clangd if needed)');
}

async function syncYtMacros(opts) {
  const reason = (opts && opts.reason) || 'status';
  const prompt = !!(opts && opts.prompt);
  let macros;
  const filePath = (opts && opts.filePath) || findWorkspaceYtVersion() || undefined;
  const macroRoot = resolveMacroRoot(filePath);
  try {
    const table = loadMacroTable({
      workspaceRoot: macroRoot,
      text: (opts && opts.text != null) ? String(opts.text) : undefined,
      filePath: filePath
    });
    if (!table.filePath && !Object.keys(table.macros).length) {
      return { changed: [], updated: false };
    }
    macros = table.macros;
  } catch (_) {
    return { changed: [], updated: false };
  }

  const changedAll = Object.keys(gLastMacros).length ? diffMacroValues(gLastMacros, macros) : [];
  // 重启只看白名单；折叠用全量，非白名单变了也要重折
  const changed = changedAll.filter((k) => isTrackedMacro(k));
  if (gHeadSync && reason !== 'checkout' && reason !== 'save') {
    return { changed: changed, updated: false };
  }
  adoptSeenMacros(macros);

  if (changedAll.length) {
    try { ifdefFold.onMacrosChanged(); } catch (_) { /* ignore */ }
  }

  if (prompt && changed.length) scheduleClangdRestart();
  return { changed: changed, updated: true };
}

function scheduleClangdRestart() {
  if (gClangdRestartTimer) clearTimeout(gClangdRestartTimer);
  gClangdRestartTimer = setTimeout(() => {
    gClangdRestartTimer = null;
    void restartClangdSoft().then((ok) => {
      if (!ok) log('clangd restart failed');
    });
  }, CLANGD_RESTART_DEBOUNCE_MS);
}

async function restartClangd() {
  if (gClangdRestartTimer) {
    clearTimeout(gClangdRestartTimer);
    gClangdRestartTimer = null;
  }
  const ok = await restartClangdSoft();
  if (!ok) throw new Error('未能重启 clangd');
  void showInfoAuto('已请求 clangd 重启');
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
    try { loadMacroTable({ workspaceRoot: resolveMacroRoot() }); } catch (_) { /* ignore */ }
    bar.setMacro('$(symbol-misc) yt_version?', 'yt_version.h not found');
    return;
  }
  try {
    const macros = loadMacroTable({ workspaceRoot: resolveMacroRoot(ver), filePath: ver }).macros;
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
  try { detailed = loadMacroTable({ workspaceRoot: resolveMacroRoot(ver), filePath: ver }); } catch (_) { return []; }
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

async function invalidateMacroImpact() {
  const root = projectRoot();
  if (!root) throw new Error('Open a workspace first');
  const r = await clearClangdIndex(root);
  void showInfoAuto(formatClearResult(r));
}

function formatClearResult(r) {
  const tail = r && r.restarted ? '，已请求 clangd 重启' : '';
  if (r && r.wiped) return '已清空 clangd index 目录（' + r.removed + ' 项）' + tail;
  return 'clangd index 目录未删净（已删 ' + ((r && r.removed) || 0) + ' 项）' + tail;
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
    vscode.commands.registerCommand(command('invalidateMacroImpactIndex'), wrap(invalidateMacroImpact)),
    vscode.commands.registerCommand(command('restartClangd'), wrap(restartClangd)),
    vscode.commands.registerCommand(command('refreshCompileCommands'), wrap(refreshCompileCommands))
  );

  let ytDiskDebounce = null;
  const onYtVersionSaved = async (doc) => {
    if (!doc || doc.uri.scheme !== 'file') return;
    if (!isWorkspaceYtVersion(doc.uri.fsPath)) return;
    suppressYtVersionWatch(doc.uri.fsPath, 1500);
    try {
      await syncYtMacros({ reason: 'save', text: doc.getText(), filePath: doc.uri.fsPath, prompt: true });
    } catch (_) { /* ignore */ }
    refreshStatus();
  };
  const ytWatcher = vscode.workspace.createFileSystemWatcher('**/yt_version.h');
  const onYtDiskChanged = (uri) => {
    if (!uri || uri.scheme !== 'file' || !isWorkspaceYtVersion(uri.fsPath)) return;
    if (isYtVersionWatchSuppressed(uri.fsPath)) return;
    if (ytDiskDebounce) clearTimeout(ytDiskDebounce);
    ytDiskDebounce = setTimeout(() => {
      ytDiskDebounce = null;
      if (isYtVersionWatchSuppressed(uri.fsPath)) return;
      void syncYtMacros({ reason: 'disk', prompt: false, filePath: uri.fsPath }).then(() => refreshStatus());
    }, 400);
  };
  const onYtDiskDeleted = (uri) => {
    if (!uri || uri.scheme !== 'file' || !isYtVersionPath(projectRoot(uri.fsPath), uri.fsPath)) return;
    invalidateMacroTable();
    void syncYtMacros({ reason: 'disk', prompt: false }).then(() => refreshStatus());
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

  let headSub = null;
  let headRepo = '';
  const stopHead = () => {
    if (!headSub) return;
    try { headSub.dispose(); } catch (_) { /* ignore */ }
    headSub = null;
  };
  const bindHead = (filePath) => {
    const next = projectRoot(filePath);
    if (next === headRepo && headSub) return;
    stopHead();
    headRepo = next || '';
    if (!headRepo) return;
    if (isCompileCommandsBranchStale(headRepo)) {
      const hasFile = fs.existsSync(path.join(headRepo, 'compile_commands.json'));
      void autoRefreshCc(
        headRepo,
        readHeadName(headRepo),
        hasFile ? { branch: true, notify: true } : undefined
      );
    }
    headSub = startHeadWatch(null, headRepo, (payload) => onHeadChanged(payload));
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      bindHead();
      refreshStatus();
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      const uri = ed && ed.document && ed.document.uri;
      if (!uri || uri.scheme !== 'file') return;
      const next = projectRoot(uri.fsPath);
      if (next === headRepo) return;
      bindHead(uri.fsPath);
      refreshStatus();
    }),
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
    ytWatcher.onDidDelete(onYtDiskDeleted),
    clangdWatcher,
    clangdWatcher.onDidChange(onClangdChanged),
    clangdWatcher.onDidCreate(onClangdChanged),
    clangdWatcher.onDidDelete(onClangdChanged),
    {
      dispose: () => {
        if (ytDiskDebounce) clearTimeout(ytDiskDebounce);
        if (clangdDebounce) clearTimeout(clangdDebounce);
        if (gRefreshTimer) clearTimeout(gRefreshTimer);
        gHeadSync = false;
        stopHead();
        if (bar) bar.dispose();
        bar = null;
      }
    }
  );

  refreshStatus();
  refreshCcBadge();
  bindHead();
}

function deactivate() {
  if (bar) bar.dispose();
  bar = null;
}

module.exports = {
  activate,
  deactivate
};
