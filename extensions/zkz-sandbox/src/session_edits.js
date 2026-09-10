'use strict';
const path = require('path');

/** 本会话内已保存的沙箱相对路径（用于 ToGb 提示） */
const gSavedRels = new Set();

function noteSandboxSave(sandboxRoot, absPath) {
  if (!sandboxRoot || !absPath) return;
  const rel = path.relative(path.resolve(sandboxRoot), path.resolve(absPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  const top = rel.split(/[/\\]/)[0].toLowerCase();
  if (top === 'user' || top === 'libraries' || top === 'freertos' || top === '.git') return;
  gSavedRels.add(rel.replace(/\\/g, '/'));
}

function savedSandboxRels() {
  return [...gSavedRels];
}

function clearSavedAfterToGb() {
  gSavedRels.clear();
}

function countSavedAfter(baselineMs) {
  // 集合本身即「本次会话保存过」；baseline 仅作 API 兼容
  void baselineMs;
  return gSavedRels.size;
}

module.exports = {
  noteSandboxSave,
  savedSandboxRels,
  clearSavedAfterToGb,
  countSavedAfter
};
