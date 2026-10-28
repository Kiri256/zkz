'use strict';

const vscode = require('vscode');
const path = require('path');
const { isInstalled, verifyGitConfig, isLocalInstalled, applyLocalSwitch } = require('./git_config');
const { verifyHooks } = require('./hooks');
const { refresh, silentRefresh, tableDrift } = require('./bootstrap');
const commands = require('./commands');
const statusBar = require('./status_bar');
const { withLock } = require('./lock');
const { startHeadWatch } = require('./head_watch');
const { applySkipWorktree, stopLocalWatch } = require('./local_filter');
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
    if (!repo || (!isInstalled(repo) && !isLocalInstalled(repo))) return;
    if (headSub && watchedRepo === repo) return;
    stopHeadWatch();
    watchedRepo = repo;
    headSub = startHeadWatch(null, repo, async ({ from, to, branchChanged }) => {
      if (branchChanged && isInstalled(repo)) {
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
      }
      if (isLocalInstalled(repo)) {
        try { applySkipWorktree(repo); }
        catch (e) { warnActivate('本地配置', e); }
      }
      try { bar.refresh(); } catch (_) { /* ignore */ }
    });
  };

  let settingsWatch = [];
  const watchLocal = (repo) => {
    if (!repo) return;
    try { stopLocalWatch(repo); } catch (_) { /* 旧监视停不掉不影响开关 */ }
  };
  const watchSettings = (repo) => {
    settingsWatch.forEach((d) => { try { d.dispose(); } catch (_) { /* ignore */ } });
    settingsWatch = [];
    if (!repo) return;
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.join(repo, '.zkz'), 'settings.json'));
      const kick = () => {
        try { applyLocalSwitch(repo, extensionRoot); }
        catch (e) { warnActivate('本地配置', e); }
      };
      settingsWatch.push(w, w.onDidChange(kick), w.onDidCreate(kick));
    } catch (_) { /* ignore */ }
  };

  const syncWatch = (verify, filePath) => {
    const repo = tryRepo(filePath);
    if (repo) {
      try { applyLocalSwitch(repo, extensionRoot); } catch (e) { warnActivate('本地配置', e); }
    }
    watchSettings(repo);
    watchLocal(repo);
    const installed = !!(repo && isInstalled(repo));
    const localOn = !!(repo && isLocalInstalled(repo));
    if (installed || localOn) {
      startWatch(repo);
      if (verify && (installed || localOn)) {
        try { verifyHooks(repo, extensionRoot); } catch (e) { warnActivate('verifyHooks', e); }
      }
      if (installed && verify) {
        try { verifyGitConfig(repo, extensionRoot); } catch (e) { warnActivate('verifyGitConfig', e); }
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
    void syncGitShim(extensionRoot);
  };

  commands.register(context, extensionRoot, {
    onStatus: () => bar.refresh(),
    onFlash: (text) => bar.flash(text),
    onActive: (on) => {
      const repo = tryRepo();
      if (on || (repo && isLocalInstalled(repo))) startWatch(repo);
      else {
        stopHeadWatch();
        watchedRepo = '';
      }
      try { bar.refresh(); } catch (_) { /* ignore */ }
    },
    onLocal: () => {
      const repo = tryRepo();
      watchLocal(repo);
      if (repo && (isInstalled(repo) || isLocalInstalled(repo))) startWatch(repo);
      else {
        stopHeadWatch();
        watchedRepo = '';
      }
      void syncGitShim(extensionRoot);
    }
  });

  context.subscriptions.push(
    { dispose: stopHeadWatch },
    { dispose: () => { settingsWatch.forEach((d) => { try { d.dispose(); } catch (_) { /* ignore */ } }); } },
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

function anyLocalOn() {
  const { findRepoRoot } = require('./paths');
  const folders = vscode.workspace.workspaceFolders || [];
  for (let i = 0; i < folders.length; i++) {
    try {
      const repo = findRepoRoot(folders[i].uri.fsPath);
      if (repo && isLocalInstalled(repo)) return true;
    } catch (_) { /* 这个目录不是仓库 */ }
  }
  return false;
}

function pathList(value) {
  return String(value || '').split(';').map((s) => s.trim()).filter(Boolean);
}

function samePath(a, b) {
  try { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
  catch (_) { return false; }
}

// git.path 只能写用户设置。本地配置开着，或用户设置里已经是替身时，改成当前扩展的 exe。
// 关掉本地配置不改回。重新加载也会走退出，分不出卸载，所以退出时不恢复。
async function syncGitShim(extensionRoot) {
  const { ensureGitShim, shimExePath, isShimGitExe, isShimBin } = require('./git_shim');
  const exe = shimExePath(extensionRoot);
  const gitCfg = vscode.workspace.getConfiguration('git');
  const gitInspect = gitCfg.inspect('path');
  const raw = gitInspect && gitInspect.globalValue;
  const cur = Array.isArray(raw) ? (raw[0] || '') : (raw || '');
  const keep = anyLocalOn() || isShimGitExe(cur);
  if (!keep) return;
  try { ensureGitShim(extensionRoot); }
  catch (e) {
    warnActivate('git shim', e);
    return;
  }
  if (!samePath(String(cur), exe)) {
    try { await gitCfg.update('path', exe, vscode.ConfigurationTarget.Global); }
    catch (e) { warnActivate('git.path', e); }
  }
  const term = vscode.workspace.getConfiguration('terminal.integrated');
  const inspected = term.inspect('env.windows');
  const env = Object.assign({}, (inspected && inspected.globalValue) || {});
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const bin = path.dirname(exe);
  const left = pathList(env[key]).filter((p) => !isShimBin(p));
  // 只写替身目录会盖掉终端原有的 PATH。没有别的值时接到 ${env:PATH} 后面。
  const next = (!left.length || (left.length === 1 && left[0] === '${env:PATH}'))
    ? (bin + ';${env:PATH}')
    : (bin + ';' + left.join(';'));
  if (env[key] === next) return;
  env[key] = next;
  try { await term.update('env.windows', env, vscode.ConfigurationTarget.Global); }
  catch (e) { warnActivate('终端 PATH', e); }
}

module.exports = { activate, deactivate };
