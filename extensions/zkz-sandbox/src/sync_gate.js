'use strict';
const vscode = require('vscode');
const { showInfoAuto } = require('./toast');

/** 同步进行中时禁止提交/签出等，避免半同步提交 */
let gSyncing = false;
let gSyncKind = '';

function isSyncing() {
  return !!gSyncing;
}

function syncKind() {
  return gSyncKind || '';
}

function setSyncing(on, kind) {
  gSyncing = !!on;
  gSyncKind = on ? String(kind || '') : '';
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.syncing', gSyncing);
  return gSyncing;
}

function assertNotSyncing() {
  if (!gSyncing) return true;
  void showInfoAuto(
    '\u540c\u6b65\u8fdb\u884c\u4e2d' +
    (gSyncKind ? ('\uff08' + gSyncKind + '\uff09') : '') +
    '\uff0c\u8bf7\u7a0d\u5019\u518d\u64cd\u4f5c Git'
  );
  return false;
}

async function withSyncLock(kind, fn) {
  if (gSyncing) {
    throw new Error('\u5df2\u6709\u540c\u6b65\u5728\u8fdb\u884c\uff08' + (gSyncKind || '?') + '\uff09');
  }
  setSyncing(true, kind);
  try {
    return await fn();
  } finally {
    setSyncing(false);
  }
}

module.exports = {
  isSyncing,
  syncKind,
  setSyncing,
  assertNotSyncing,
  withSyncLock
};
