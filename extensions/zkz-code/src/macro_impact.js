'use strict';
/**
 * 手动清空 .cache/clangd/index 并软重启。自动路径只重启，不删索引。
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { log } = require('./util');

function diffMacroValues(prev, next) {
  const a = prev || {};
  const b = next || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const k of keys) {
    const av = a[k] == null ? '' : String(a[k]);
    const bv = b[k] == null ? '' : String(b[k]);
    if (av !== bv) changed.push(k);
  }
  changed.sort();
  return changed;
}

function clangdIndexDir(workspaceRoot) {
  return path.join(workspaceRoot, '.cache', 'clangd', 'index');
}

/** 删掉 index 目录。同级的预编译头不动。目录确实没了才算 wiped。 */
function wipeClangdIndex(workspaceRoot) {
  const indexDir = clangdIndexDir(workspaceRoot);
  if (!fs.existsSync(indexDir)) return { removed: 0, indexDir: indexDir, wiped: true };
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(indexDir);
  } catch (e) {
    log('wipe idx fail: ' + (e && e.message ? e.message : e));
    return { removed: 0, indexDir: indexDir, wiped: false };
  }
  for (let i = 0; i < entries.length; i++) {
    try {
      fs.rmSync(path.join(indexDir, entries[i]), { recursive: true, force: true });
      removed++;
    } catch (e) {
      log('wipe idx fail: ' + entries[i] + ' ' + (e && e.message ? e.message : e));
    }
  }
  try { fs.rmSync(indexDir, { recursive: true, force: true }); } catch (_) { /* 还有删不掉的分片 */ }
  return { removed: removed, indexDir: indexDir, wiped: !fs.existsSync(indexDir) };
}

async function restartClangdSoft() {
  for (const cmd of ['clangd.restart', 'clangd.restartLanguageServer']) {
    try {
      await vscode.commands.executeCommand(cmd);
      return true;
    } catch (_) { /* try next */ }
  }
  return false;
}

/**
 * 清空 index 目录并重启。第一次删不掉时先重启再删，清掉后再重启。
 * @returns {Promise<{ removed: number, restarted: boolean, wiped: boolean, wipeIncomplete: boolean, indexDir: string }>}
 */
async function clearClangdIndex(workspaceRoot) {
  let wiped = wipeClangdIndex(workspaceRoot);
  let removed = wiped.removed;
  let restarted = false;
  if (!wiped.wiped) {
    restarted = await restartClangdSoft();
    const again = wipeClangdIndex(workspaceRoot);
    removed += again.removed;
    wiped = again;
  }
  const restartedAfter = await restartClangdSoft();
  log(
    'clangd index clear removed=' + removed +
    ' wiped=' + wiped.wiped +
    ' indexDir=' + wiped.indexDir
  );
  return {
    removed: removed,
    restarted: restarted || restartedAfter,
    wiped: wiped.wiped,
    wipeIncomplete: !wiped.wiped,
    indexDir: wiped.indexDir
  };
}

module.exports = {
  diffMacroValues,
  wipeClangdIndex,
  clearClangdIndex,
  restartClangdSoft,
  clangdIndexDir
};
