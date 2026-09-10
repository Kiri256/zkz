'use strict';
const { showInfoAuto } = require('./toast');
const { isSandboxWorkspace, resolvePair } = require('./pair');

/** @type {boolean} */
let gGitManageEnabled = false;

function isGitManageEnabled() {
  return !!gGitManageEnabled;
}

function setGitManageEnabled(on) {
  gGitManageEnabled = !!on;
  return gGitManageEnabled;
}

/** Git manage only in *U sandbox */
function refreshGitManageFromWorkspace() {
  return setGitManageEnabled(isSandboxWorkspace());
}

/** Show activity-bar button when W1/sandbox pair resolves */
function isPairedWorkspace() {
  try {
    resolvePair();
    return true;
  } catch (_) {
    return false;
  }
}

function assertGitManage() {
  if (gGitManageEnabled) return true;
  void showInfoAuto(
    '\u5f53\u524d\u4e3a\u771f\u6e90\u5de5\u4f5c\u533a\uff1aGit \u7ba1\u7406\u5df2\u7981\u7528\uff0c\u8bf7\u5728 *U \u6c99\u7bb1\u4f7f\u7528\u3002\u5b8f\u4ecd\u53ef\u7528\uff1b\u540c\u6b65/\u5bf9\u6bd4\u8bf7\u6253\u5f00\u6c99\u7bb1\u3002'
  );
  return false;
}

module.exports = {
  isGitManageEnabled,
  setGitManageEnabled,
  refreshGitManageFromWorkspace,
  isPairedWorkspace,
  assertGitManage
};
