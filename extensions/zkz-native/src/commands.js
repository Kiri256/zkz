'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { isInstalled } = require('./git_config');
const { enable, disable, refresh, statusSnapshot } = require('./bootstrap');
const { loadTable } = require('./enc_table');
const { roundtripOk, parseMapped } = require('./encoding');
const { slashRel } = require('./paths');
const { syncKeilTree, copyDebugAxf } = require('./keil_tree');
const { seedOverlay, restoreOverlay } = require('./overlay');
const { withLock } = require('./lock');
const { FILTER_FAIL_LIMIT } = require('./observe');

function output() {
  if (!output._ch) output._ch = vscode.window.createOutputChannel('zkz Native');
  return output._ch;
}

function emit(msg) {
  output().appendLine(String(msg == null ? '' : msg));
}

function isProjectRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, 'Project'))) return true;
  if (fs.existsSync(path.join(dir, 'core')) || fs.existsSync(path.join(dir, 'User'))) return true;
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  return false;
}

function resolveRepo() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) throw new Error('未打开工作区');
  for (const f of folders) {
    let cur = f.uri.fsPath;
    for (let i = 0; i < 6; i++) {
      if (isProjectRoot(cur)) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return folders[0].uri.fsPath;
}

function cmdResolveRoot() {
  return { root: resolveRepo() };
}

function formatStatus(st) {
  const on = st.installed ? 'on' : 'off';
  const pending = (st.unstable && st.unstable.length) ? (' / ' + st.unstable.length + ' 待处理') : '';
  const rt = (st.roundtripFails && st.roundtripFails.length) ? (' / ' + st.roundtripFails.length + ' 往返失败') : '';
  const drift = st.tableDrift ? ' / 表过期' : '';
  const ff = (st.filterFails >= FILTER_FAIL_LIMIT) ? (' / filter 失败×' + st.filterFails) : '';
  const libN = (st.libWarnings && st.libWarnings.length) ? (' / 库编码 ' + st.libWarnings.length) : '';
  return 'zkz-native: ' + on + ' / 表 ' + st.tableCount + ' 项' + pending + rt + drift + ff + libN;
}

async function cmdEnable(extensionRoot, onStatus) {
  const repo = resolveRepo();
  emit('enable ' + repo);
  const st = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '启用 zkz-native', cancellable: false },
    () => withLock(repo, () => enable(repo, extensionRoot))
  );
  if (st.unstable && st.unstable.length) {
    emit('往返不稳定文件（未提交）:');
    st.unstable.forEach((l) => emit('  ' + l));
    void vscode.window.showWarningMessage('zkz-native 已启用，但有 ' + st.unstable.length + ' 个往返不稳定文件，见输出');
  } else {
    void vscode.window.showInformationMessage(formatStatus(st));
  }
  emit(formatStatus(st));
  if (onStatus) onStatus(st);
  return st;
}

async function cmdDisable(onStatus) {
  const repo = resolveRepo();
  const st = await withLock(repo, () => disable(repo));
  const leftover = (st && st.leftover) || [];
  emit('disabled leftover=' + leftover.length);
  leftover.forEach((l) => emit('  ' + l));
  if (leftover.length) {
    void vscode.window.showWarningMessage('zkz-native 已关闭，但仍有 ' + leftover.length + ' 个文件未能写回原编码，请关闭这些文件后重试 Disable');
  } else {
    void vscode.window.showInformationMessage('zkz-native 已关闭。工作区已按仓库原编码检出。过滤器已卸，git 不再依赖 filter 进程。');
  }
  if (onStatus) onStatus(statusSnapshot(repo));
  return st;
}

function requireInstalled() {
  const repo = resolveRepo();
  if (!isInstalled(repo)) throw new Error('zkz-native 过滤器未启用');
  return repo;
}

async function cmdRefresh(extensionRoot, onStatus) {
  const repo = requireInstalled();
  const st = await withLock(repo, () => refresh(repo, extensionRoot, { force: true }));
  void vscode.window.showInformationMessage(formatStatus(st));
  if (onStatus) onStatus(st);
  return st;
}

function cmdStatus() {
  const repo = resolveRepo();
  if (!isInstalled(repo)) {
    void vscode.window.showInformationMessage('zkz-native 过滤器未启用');
    return { installed: false };
  }
  const st = statusSnapshot(repo);
  void vscode.window.showInformationMessage(formatStatus(st));
  return st;
}

function cmdIsEnabled() {
  try {
    return isInstalled(resolveRepo());
  } catch (_) {
    return false;
  }
}

function cmdCheckRoundtrip() {
  requireInstalled();
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    throw new Error('请先打开一个 .c/.h 文件');
  }
  const repo = resolveRepo();
  const rel = slashRel(path.relative(repo, editor.document.uri.fsPath));
  const table = loadTable(repo);
  const kind = parseMapped(table[rel] || 'Utf8').kind;
  const text = editor.document.getText();
  if (kind !== 'Gbk') {
    void vscode.window.showInformationMessage(rel + ' 表=' + kind + '，无需 cp936 往返');
    return { ok: true, kind: kind };
  }
  const ok = roundtripOk(text);
  if (!ok) void vscode.window.showErrorMessage(rel + ': cp936 无法无损编码，提交会被拦截');
  else void vscode.window.showInformationMessage(rel + ': cp936 往返通过');
  return { ok: ok, kind: kind };
}

function cmdSyncKeilTree() {
  const repo = requireInstalled();
  return withLock(repo, () => {
    const r = syncKeilTree(repo, emit);
    const n = (r && r.libWarnings && r.libWarnings.length) || 0;
    if (n) {
      void vscode.window.showWarningMessage(
        'zkz-native: ' + n + ' 个库文件编码疑似漂移或损坏。库不过滤，不会自动改回。见 .zkz/lib-encoding-warnings.json'
      );
      try {
        const { markLibWarningsNotified } = require('./lib_encoding');
        markLibWarningsNotified(repo);
      } catch (_) { /* ignore */ }
    }
    return r;
  });
}

function cmdCopyDebugAxf() {
  const repo = requireInstalled();
  copyDebugAxf(repo, emit);
  return ['debug axf -> .zkz/output.axf'];
}

function cmdSaveConfigOverlay() {
  const repo = requireInstalled();
  const r = seedOverlay(repo);
  emit('config overlay seeded ' + r.seeded.length);
  r.seeded.forEach((f) => emit('  ' + f));
  void vscode.window.showInformationMessage('已把 ' + r.seeded.length + ' 个本地配置设为权威，切分支后会提示是否还原');
  return r;
}

function cmdRestoreConfigOverlay() {
  const repo = requireInstalled();
  const r = restoreOverlay(repo);
  emit('config overlay restored ' + r.restored.length);
  void vscode.window.showInformationMessage('已还原 ' + r.restored.length + ' 个本地配置');
  return r;
}

function register(context, extensionRoot, hooks) {
  const onStatus = typeof hooks === 'function' ? hooks : (hooks && hooks.onStatus);
  const onActive = hooks && hooks.onActive;
  const wrap = (fn) => async () => {
    try { return await fn(); }
    catch (e) {
      const msg = String(e && e.message ? e.message : e);
      emit(msg);
      void vscode.window.showErrorMessage(msg);
      throw e;
    }
  };
  context.subscriptions.push(
    output(),
    vscode.commands.registerCommand('zkz-native.enable', wrap(async () => {
      const st = await cmdEnable(extensionRoot, onStatus);
      if (onActive) onActive(true);
      return st;
    })),
    vscode.commands.registerCommand('zkz-native.disable', wrap(async () => {
      const st = await cmdDisable(onStatus);
      if (onActive) onActive(false);
      return st;
    })),
    vscode.commands.registerCommand('zkz-native.refreshTable', wrap(() => cmdRefresh(extensionRoot, onStatus))),
    vscode.commands.registerCommand('zkz-native.checkRoundtrip', wrap(cmdCheckRoundtrip)),
    vscode.commands.registerCommand('zkz-native.status', wrap(cmdStatus)),
    vscode.commands.registerCommand('zkz-native.isEnabled', () => cmdIsEnabled()),
    vscode.commands.registerCommand('zkz-native.resolveRoot', () => cmdResolveRoot()),
    vscode.commands.registerCommand('zkz-native.syncKeilTree', wrap(cmdSyncKeilTree)),
    vscode.commands.registerCommand('zkz-native.copyDebugAxf', wrap(cmdCopyDebugAxf)),
    vscode.commands.registerCommand('zkz-native.saveConfigOverlay', wrap(cmdSaveConfigOverlay)),
    vscode.commands.registerCommand('zkz-native.restoreConfigOverlay', wrap(cmdRestoreConfigOverlay))
  );
}

module.exports = {
  register,
  formatStatus,
  resolveRepo,
  cmdIsEnabled
};
