'use strict';

const vscode = require('vscode');
const { log } = require('./shared');

/**
 * 调用可选命令。zkz-sandbox.* 找不到时再试 zkz-code.*。
 * 接口不存在或执行失败：只打日志，不抛错。
 */
async function invokeOptional(command) {
  const alts = [command];
  if (String(command).indexOf('zkz-sandbox.') === 0) {
    alts.push('zkz-code.' + String(command).slice('zkz-sandbox.'.length));
  }
  // refreshStatus 两包都有：同步条 + 宏徽章都要刷
  const runAll = /\.refreshStatus$/.test(String(command));
  try {
    const ids = await vscode.commands.getCommands(true);
    let any = false;
    for (const id of alts) {
      if (!ids.includes(id)) continue;
      await vscode.commands.executeCommand(id);
      any = true;
      if (!runAll) return true;
    }
    if (any) return true;
    log('skip ' + alts.join(' / ') + ' (not found)');
  } catch (e) {
    log('skip ' + command + ': ' + (e && e.message ? e.message : e));
  }
  return false;
}

module.exports = { invokeOptional };
