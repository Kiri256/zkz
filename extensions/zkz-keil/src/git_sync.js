'use strict';

const vscode = require('vscode');

/**
 * 调用 zkz-sandbox 的同步命令。silent 时不弹完成提示。
 * 命令不存在：只打印，返回 false。命令在但执行失败：仍抛给调用方。
 */
async function invokeGitSync(commandId, emit) {
  let ids = [];
  try { ids = await vscode.commands.getCommands(true); } catch (_) { ids = []; }
  if (ids.indexOf(commandId) < 0) {
    if (emit) emit('skip ' + commandId + ' (not found)');
    return false;
  }
  if (emit) emit(commandId);
  const result = await vscode.commands.executeCommand(commandId, { silent: true });
  if (Array.isArray(result)) {
    result.forEach((line) => { if (emit && line) emit('  ' + line); });
  } else if (result && emit) {
    emit('  ' + result);
  }
  return true;
}

module.exports = { invokeGitSync };
