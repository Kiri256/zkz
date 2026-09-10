'use strict';
const vscode = require('vscode');

/**
 * 不再把本源写入 git.ignoredRepositories。
 * 路径形如 "... - 1" / "... - 1U" 时，忽略本源曾导致沙箱自带 Git 异常。
 * 保留空实现，兼容旧调用点。
 */
async function ignoreW1InBuiltinGit(_w1) {
  /* no-op */
}

/** 清除工作区里由旧版扩展写入的 git.ignoredRepositories */
async function clearIgnoredW1Repositories() {
  try {
    const cfg = vscode.workspace.getConfiguration('git');
    const key = 'ignoredRepositories';
    const cur = cfg.get(key);
    if (!Array.isArray(cur) || !cur.length) return;
    // 清空后让内置 Git 重新识别本源/沙箱仓库
    await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  } catch (_) {
    /* ignore */
  }
}

module.exports = { ignoreW1InBuiltinGit, clearIgnoredW1Repositories };
