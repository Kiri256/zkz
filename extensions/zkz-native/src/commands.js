'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { isInstalled } = require('./git_config');
const { enable, disable, refresh, statusSnapshot } = require('./bootstrap');
const { loadTable } = require('./enc_table');
const { roundtripOk, parseMapped } = require('./encoding');
const { slashRel } = require('./paths');
const { syncKeilTree, copyArtifactsBack, copyDebugAxf } = require('./keil_tree');

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
  return 'zkz-native: ' + on + ' / 表 ' + st.tableCount + ' 项' + pending;
}

async function cmdEnable(extensionRoot, onStatus) {
  const repo = resolveRepo();
  emit('enable ' + repo);
  const st = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '启用 zkz-native', cancellable: false },
    () => enable(repo, extensionRoot)
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
  const st = disable(repo);
  emit('disabled');
  void vscode.window.showInformationMessage('zkz-native 已关闭。工作区已按仓库原编码检出。');
  if (onStatus) onStatus(statusSnapshot(repo));
  return st;
}

async function cmdRefresh(extensionRoot, onStatus) {
  const repo = resolveRepo();
  const st = await refresh(repo, extensionRoot, { force: true });
  void vscode.window.showInformationMessage(formatStatus(st));
  if (onStatus) onStatus(st);
  return st;
}

function cmdStatus() {
  const repo = resolveRepo();
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
  const repo = resolveRepo();
  const r = syncKeilTree(repo, emit);
  return r;
}

function cmdCopyArtifacts() {
  const repo = resolveRepo();
  return copyArtifactsBack(repo, emit);
}

function cmdCopyDebugAxf() {
  const repo = resolveRepo();
  copyDebugAxf(repo, emit);
  return ['debug axf -> .zkz/output.axf'];
}

function register(context, extensionRoot, onStatus) {
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
    vscode.commands.registerCommand('zkz-native.enable', wrap(() => cmdEnable(extensionRoot, onStatus))),
    vscode.commands.registerCommand('zkz-native.disable', wrap(() => cmdDisable(onStatus))),
    vscode.commands.registerCommand('zkz-native.refreshTable', wrap(() => cmdRefresh(extensionRoot, onStatus))),
    vscode.commands.registerCommand('zkz-native.checkRoundtrip', wrap(cmdCheckRoundtrip)),
    vscode.commands.registerCommand('zkz-native.status', wrap(cmdStatus)),
    vscode.commands.registerCommand('zkz-native.isEnabled', () => cmdIsEnabled()),
    vscode.commands.registerCommand('zkz-native.resolveRoot', () => cmdResolveRoot()),
    vscode.commands.registerCommand('zkz-native.syncKeilTree', wrap(cmdSyncKeilTree)),
    vscode.commands.registerCommand('zkz-native.copyArtifacts', wrap(cmdCopyArtifacts)),
    vscode.commands.registerCommand('zkz-native.copyDebugAxf', wrap(cmdCopyDebugAxf))
  );
}

module.exports = {
  register,
  formatStatus,
  resolveRepo,
  cmdIsEnabled
};
