'use strict';

const vscode = require('vscode');
const { findProjectRoot } = require('../../shared/project_root');
const { isInstalled } = require('./git_config');
const { enable, disable, refresh, statusSnapshot, statusLines } = require('./bootstrap');
const { git } = require('./git_exec');
const { syncKeilTree } = require('./keil_tree');
const { installLocalConfig, uninstallLocalConfig, isLocalInstalled } = require('./git_config');
const { withLock } = require('./lock');
const { dismissCommitReject } = require('./observe');

function output() {
  if (!output._ch) output._ch = vscode.window.createOutputChannel('zkz Native');
  return output._ch;
}

function emit(msg) {
  output().appendLine(String(msg == null ? '' : msg));
}

let onStatusFn = null;
let onFlash = null;
let onLocalFn = null;

// 结果写到输出。flash 是状态栏上停留几秒的短句。
function note(msg, flash) {
  emit(msg);
  if (flash && onFlash) onFlash(flash);
}

function restage(rels) {
  const repo = requireInstalled();
  const list = (rels || []).filter(Boolean);
  if (!list.length) return null;
  return withLock(repo, () => {
    git(repo, ['add', '--renormalize', '--'].concat(list));
    dismissCommitReject(repo, list, 'restage');
    note('已重新暂存 ' + list.join('、'), '已重新暂存');
    if (onStatusFn) onStatusFn();
    return list;
  });
}

function activeEditorPath() {
  try {
    const ed = vscode.window.activeTextEditor;
    const uri = ed && ed.document && ed.document.uri;
    if (uri && uri.scheme === 'file') return uri.fsPath;
  } catch (_) { /* ignore */ }
  return '';
}

function resolveRepo(filePath) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) throw new Error('未打开工作区');
  const hint = filePath || activeEditorPath();
  const found = findProjectRoot(folders.map(function (f) { return f.uri.fsPath; }), hint);
  if (!found) throw new Error('无法解析工程根目录');
  return found;
}

function emitStatus(st) {
  statusLines(st).forEach(emit);
}

async function cmdEnable(extensionRoot, onStatus) {
  const repo = resolveRepo();
  emit('enable ' + repo);
  const st = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '启用 zkz-native', cancellable: false },
    () => withLock(repo, () => enable(repo, extensionRoot))
  );
  const shown = statusSnapshot(repo);
  emitStatus(shown);
  if (shown.unstable && shown.unstable.length) {
    note('有文件未能对齐编码表');
  } else {
    note('过滤器已启用', 'native 已启用');
  }
  if (onStatus) onStatus(shown);
  return st;
}

async function cmdDisable(onStatus) {
  const repo = resolveRepo();
  const st = await withLock(repo, () => disable(repo));
  const leftover = (st && st.leftover) || [];
  emit('disabled leftover=' + leftover.length);
  leftover.forEach((l) => emit('  ' + l));
  if (leftover.length) {
    note('有文件未能写回原编码');
    void vscode.window.showWarningMessage('有文件正被占用，关闭编辑器后可以再试。', '重试关闭').then((choice) => {
      if (choice === '重试关闭') void vscode.commands.executeCommand('zkz-native.disable');
    });
  } else {
    emit('工作区已按编码表编回原编码，未提交的修改仍留在工作区。');
    note('过滤器已关闭', 'native 已关闭');
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
  const shown = statusSnapshot(repo);
  emitStatus(shown);
  note('编码表已刷新', 'native 已刷新');
  if (onStatus) onStatus(shown);
  return st;
}

function cmdSyncKeilTree() {
  const repo = requireInstalled();
  return withLock(repo, () => {
    const r = syncKeilTree(repo, emit);
    const n = (r && r.libWarnings && r.libWarnings.length) || 0;
    if (n) emit(n + ' 个库文件编码疑似漂移或损坏。库不过滤，不会自动改回。');
    if (onStatusFn) onStatusFn();
    return r;
  });
}

function cmdToggleLocal(extensionRoot) {
  const repo = resolveRepo();
  return withLock(repo, () => {
    const settings = require('../../shared/zkz_settings');
    const next = !isLocalInstalled(repo);
    settings.set(repo, 'native', 'local', next);
    if (!next) {
      uninstallLocalConfig(repo);
      note('本地配置已关闭', '本地配置 关');
      if (onStatusFn) onStatusFn();
      if (onLocalFn) onLocalFn();
      return false;
    }
    installLocalConfig(repo, extensionRoot);
    note('本地配置已打开', '本地配置 开');
    if (onStatusFn) onStatusFn();
    if (onLocalFn) onLocalFn();
    return true;
  });
}

function register(context, extensionRoot, hooks) {
  onStatusFn = typeof hooks === 'function' ? hooks : (hooks && hooks.onStatus);
  onFlash = hooks && hooks.onFlash;
  onLocalFn = hooks && hooks.onLocal;
  const onStatus = onStatusFn;
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
    vscode.commands.registerCommand('zkz-native.syncKeilTree', wrap(cmdSyncKeilTree)),
    vscode.commands.registerCommand('zkz-native.toggleLocalConfig', wrap(() => cmdToggleLocal(extensionRoot)))
  );
}

module.exports = {
  register,
  resolveRepo,
  note,
  restage
};
