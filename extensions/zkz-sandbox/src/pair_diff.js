'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { showInfoAuto } = require('./toast');
const { GIT_SCHEME } = require('./shared');
const { resolvePair, assertSandboxSync } = require('./pair');
const { resolveW1OpenUri } = require('./w1_fs');
const { bufferToText } = require('./encoding');

const MAX_DIFF_BYTES = 4 * 1024 * 1024;

function relUnderRoot(abs, root) {
  if (!abs || !root) return null;
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function emptyUri(filePosix) {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: '/' + filePosix,
    query: JSON.stringify({ w1: '', rev: '__empty__', file: filePosix })
  });
}

function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  const n = Math.min(buf.length, 8192);
  let nul = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) nul++;
  }
  return nul > 0;
}

function normalizeText(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function resolveRelFromArg(arg, pair) {
  if (!arg) return null;
  if (typeof arg === 'string') return String(arg).replace(/\\/g, '/');
  if (arg.data && arg.data.file) return String(arg.data.file).replace(/\\/g, '/');
  // explorer/context 或编辑器传入 Uri
  if (arg.scheme === 'file' && arg.fsPath) {
    return relUnderRoot(arg.fsPath, pair.sandbox) || relUnderRoot(arg.fsPath, pair.w1);
  }
  if (arg.fsPath) {
    return relUnderRoot(arg.fsPath, pair.sandbox) || relUnderRoot(arg.fsPath, pair.w1);
  }
  // 多选时有时是 Uri[]
  if (Array.isArray(arg) && arg[0]) return resolveRelFromArg(arg[0], pair);
  return null;
}

/**
 * 真源(GBK) ↔ 沙箱(UTF-8) 同路径对比。
 * 优先用当前编辑器 / 资源管理器选中路径；否则让用户输入。
 */
async function diffSandboxW1(arg) {
  assertSandboxSync();
  const pair = resolvePair();
  let rel = resolveRelFromArg(arg, pair);

  if (!rel) {
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document && ed.document.uri.scheme === 'file') {
      rel = relUnderRoot(ed.document.uri.fsPath, pair.sandbox)
        || relUnderRoot(ed.document.uri.fsPath, pair.w1);
    }
  }

  if (!rel) {
    const typed = await vscode.window.showInputBox({
      prompt: '\u8f93\u5165\u76f8\u5bf9\u8def\u5f84\uff08\u76f8\u5bf9\u6c99\u7bb1/\u672c\u6e90\u6839\uff09',
      placeHolder: 'core/core_common/yt_version.h'
    });
    if (!typed) return;
    rel = typed.replace(/\\/g, '/').replace(/^[/\\]+/, '');
  }

  const sandAbs = path.join(pair.sandbox, ...rel.split('/').filter(Boolean));
  const w1Abs = path.join(pair.w1, ...rel.split('/').filter(Boolean));
  const sandOk = fs.existsSync(sandAbs) && fs.statSync(sandAbs).isFile();
  const w1Ok = fs.existsSync(w1Abs) && fs.statSync(w1Abs).isFile();
  if (!sandOk && !w1Ok) {
    vscode.window.showWarningMessage('\u4e24\u4fa7\u90fd\u4e0d\u5b58\u5728: ' + rel);
    return;
  }

  let w1Buf = null;
  let sandBuf = null;
  try {
    if (w1Ok) w1Buf = fs.readFileSync(w1Abs);
    if (sandOk) sandBuf = fs.readFileSync(sandAbs);
  } catch (e) {
    vscode.window.showErrorMessage('\u8bfb\u53d6\u6587\u4ef6\u5931\u8d25: ' + (e && e.message ? e.message : e));
    return;
  }

  if ((w1Buf && w1Buf.length > MAX_DIFF_BYTES) || (sandBuf && sandBuf.length > MAX_DIFF_BYTES)) {
    vscode.window.showWarningMessage('\u6587\u4ef6\u8d85\u8fc7 4MB\uff0c\u8bf7\u7528\u5916\u90e8\u5de5\u5177\u5bf9\u6bd4: ' + rel);
    return;
  }
  if ((w1Buf && looksBinary(w1Buf)) || (sandBuf && looksBinary(sandBuf))) {
    vscode.window.showWarningMessage('\u4e8c\u8fdb\u5236\u6587\u4ef6\u4e0d\u652f\u6301\u6587\u672c\u5bf9\u6bd4: ' + rel);
    return;
  }

  // 解码后文本一致则不必打开 diff（换行统一为 \n）
  if (w1Ok && sandOk) {
    const leftText = normalizeText(bufferToText(w1Buf));
    const rightText = normalizeText(sandBuf.toString('utf8'));
    if (leftText === rightText) {
      void showInfoAuto('\u672c\u6e90\u4e0e\u6c99\u7bb1\u5185\u5bb9\u4e00\u81f4: ' + rel, 3500);
      return;
    }
  }

  let left;
  let right;
  if (w1Ok) {
    left = await resolveW1OpenUri(pair.w1, rel);
  } else {
    left = emptyUri(rel);
  }
  if (sandOk) {
    const suri = vscode.Uri.file(sandAbs);
    try { await vscode.workspace.openTextDocument(suri); } catch (_) { /* ignore */ }
    right = suri;
  } else {
    right = emptyUri(rel);
  }

  const title = path.posix.basename(rel) + ' (\u672c\u6e90 \u2194 \u6c99\u7bb1)';
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
  if (!w1Ok) void showInfoAuto('\u672c\u6e90\u7f3a\u5931\uff0c\u4ec5\u663e\u793a\u6c99\u7bb1: ' + rel);
  else if (!sandOk) void showInfoAuto('\u6c99\u7bb1\u7f3a\u5931\uff0c\u4ec5\u663e\u793a\u672c\u6e90: ' + rel);
}

module.exports = { diffSandboxW1, relUnderRoot };
