'use strict';
const vscode = require('vscode');

/** 信息类通知默认展示时长（毫秒）——过长会挡操作 */
const INFO_TOAST_MS = 4000;

/**
 * 信息提示：约 ms 后自动关闭（Progress 通知）。
 * 需要按钮选择的仍用 showInformationMessage。
 */
function showInfoAuto(message, ms) {
  const title = String(message || '');
  const wait = ms == null ? INFO_TOAST_MS : Number(ms);
  if (!title) return Promise.resolve();
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    () => new Promise((resolve) => setTimeout(resolve, wait > 0 ? wait : INFO_TOAST_MS))
  );
}

module.exports = { showInfoAuto, INFO_TOAST_MS };
