'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : null;
}

function readMeta(sandbox) {
  const p = path.join(sandbox, '.zkz', '.workspace_sync_meta.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function dirMtimeMs(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  try { return fs.statSync(dir).mtimeMs; } catch (_) { return null; }
}

function isUnderRoot(abs, root) {
  if (!abs || !root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return !!(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 沙箱中未保存的业务文档 */
function dirtySandboxDocs(sandbox) {
  const out = [];
  for (const d of vscode.workspace.textDocuments) {
    if (!d.isDirty || d.uri.scheme !== 'file') continue;
    if (isUnderRoot(d.uri.fsPath, sandbox)) out.push(d.uri.fsPath);
  }
  return out;
}

/**
 * 已打开的沙箱文件 mtime 晚于基准时间（比目录 mtime 更可靠）
 */
function openSandboxFilesNewerThan(sandbox, thanMs) {
  if (thanMs == null) return [];
  const out = [];
  for (const d of vscode.workspace.textDocuments) {
    if (d.uri.scheme !== 'file') continue;
    const fp = d.uri.fsPath;
    if (!isUnderRoot(fp, sandbox)) continue;
    try {
      if (fs.statSync(fp).mtimeMs > thanMs + 2000) out.push(fp);
    } catch (_) { /* ignore */ }
  }
  return out;
}

/**
 * 粗判是否需要 ToGb：未保存，或已打开沙箱文件晚于上次 ToGb/ToUtf
 */
function sandboxMayNeedToGb(pair) {
  const meta = readMeta(pair.sandbox) || {};
  const fromUtfAt = parseTime(meta.lastFromUtf8At);
  const syncedAt = parseTime(meta.syncedAt);
  const baseline = fromUtfAt || syncedAt;
  const newer = openSandboxFilesNewerThan(pair.sandbox, baseline);
  if (newer.length) {
    return {
      need: true,
      reason: '\u5df2\u6253\u5f00\u7684\u6c99\u7bb1\u6587\u4ef6\u665a\u4e8e\u4e0a\u6b21' +
        (fromUtfAt ? ' ToGb' : ' ToUtf') +
        '\uff08' + newer.length + '\u4e2a\uff09'
    };
  }
  // 本会话已保存过的沙箱文件（比仅看打开文件更准）
  try {
    const { savedSandboxRels } = require('./session_edits');
    const n = savedSandboxRels().length;
    if (n > 0) {
      return {
        need: true,
        reason: '\u672c\u4f1a\u8bdd\u5df2\u4fdd\u5b58 ' + n + ' \u4e2a\u6c99\u7bb1\u6587\u4ef6\uff0c\u53ef\u80fd\u5c1a\u672a ToGb'
      };
    }
  } catch (_) { /* ignore */ }
  return { need: false, reason: '' };
}

/** 本源 core 晚于上次 ToUtf → 沙箱可能偏旧 */
function sandboxMayNeedToUtf(pair) {
  const meta = readMeta(pair.sandbox) || {};
  const w1Core = dirMtimeMs(path.join(pair.w1, 'core'));
  const syncedAt = parseTime(meta.syncedAt);
  if (syncedAt && w1Core && w1Core > syncedAt + 8000) {
    return { need: true, reason: '\u672c\u6e90 core \u665a\u4e8e\u4e0a\u6b21 ToUtf\uff0c\u6c99\u7bb1\u53ef\u80fd\u504f\u65e7' };
  }
  return { need: false, reason: '' };
}

function collectSyncHints(pair) {
  const dirty = dirtySandboxDocs(pair.sandbox);
  const toGb = sandboxMayNeedToGb(pair);
  const toUtf = sandboxMayNeedToUtf(pair);
  const hints = [];
  if (dirty.length) {
    hints.push('\u6c99\u7bb1\u6709 ' + dirty.length + ' \u4e2a\u672a\u4fdd\u5b58\u6587\u4ef6');
  }
  if (toGb.need) hints.push(toGb.reason);
  if (toUtf.need) hints.push(toUtf.reason);
  return {
    dirtyPaths: dirty,
    needToGb: !!(dirty.length || toGb.need),
    needToUtf: toUtf.need,
    hints
  };
}

/**
 * 提交本源前：提醒未保存 / 可能未 ToGb。返回 false 表示用户取消。
 */
async function confirmBeforeW1Commit(pair) {
  const h = collectSyncHints(pair);
  if (!h.dirtyPaths.length && !h.needToGb) return true;
  // needToGb 可能仅来自 dirty；去重提示
  const lines = [
    '\u63d0\u4ea4\u5bf9\u8c61\u662f\u771f\u6e90\uff08\u4e0d\u662f\u6c99\u7bb1\uff09\u3002',
    ...h.hints.map((s) => '\u2022 ' + s),
    '',
    '\u82e5\u6c99\u7bb1\u6539\u52a8\u9700\u5165\u5e93\uff0c\u8bf7\u5148\u4fdd\u5b58\u5e76 ToGb\u3002'
  ];
  const choice = await vscode.window.showWarningMessage(
    lines.join('\n'),
    { modal: true },
    '\u7ee7\u7eed\u63d0\u4ea4',
    '\u5148 ToGb',
    '\u53d6\u6d88'
  );
  if (choice === '\u5148 ToGb') {
    vscode.window.showInformationMessage('Use zkz Sandbox: Sync Menu and run ToGb before committing.');
    return false;
  }
  return choice === '\u7ee7\u7eed\u63d0\u4ea4';
}

module.exports = {
  readMeta,
  collectSyncHints,
  confirmBeforeW1Commit,
  dirtySandboxDocs,
  sandboxMayNeedToGb,
  sandboxMayNeedToUtf
};
