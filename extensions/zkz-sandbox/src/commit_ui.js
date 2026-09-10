'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { showInfoAuto } = require('./toast');

let gCommitMsgWaiter = null;

async function finishCommitMessage(accept) {
  const w = gCommitMsgWaiter;
  if (!w) return;
  gCommitMsgWaiter = null;
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.commitMsgOpen', false);
  for (const it of w.items) {
    try { it.dispose(); } catch (_) { /* ignore */ }
  }
  let msg = null;
  if (accept) {
    try {
      if (w.doc && w.doc.isDirty) await w.doc.save();
    } catch (_) { /* ignore */ }
    try {
      const rawMsg = fs.readFileSync(w.tmpEdit, 'utf8');
      const lines = rawMsg.split(/\r?\n/).filter((l) => !l.startsWith('#'));
      msg = lines.join('\n').replace(/^\s+|\s+$/g, '');
    } catch (_) {
      msg = null;
    }
    if (!msg) {
      void showInfoAuto('\u63d0\u4ea4\u8bf4\u660e\u4e3a\u7a7a\uff0c\u5df2\u53d6\u6d88');
      w.resolve(null);
      return;
    }
  }
  w.resolve(msg);
}

/** Multiline commit message: editor + sticky status-bar buttons */
async function promptCommitMessage() {
  if (gCommitMsgWaiter) {
    void showInfoAuto('\u5df2\u6709\u63d0\u4ea4\u8bf4\u660e\u7f16\u8f91\u5728\u8fdb\u884c\u4e2d');
    return null;
  }
  const hint =
    '\n\n' +
    '# \u5728\u4e0a\u65b9\u8f93\u5165\u63d0\u4ea4\u8bf4\u660e\uff08\u652f\u6301\u591a\u884c\uff09\u3002\u4ee5 # \u5f00\u5934\u7684\u884c\u4e3a\u6ce8\u91ca\uff0c\u4e0d\u4f1a\u5199\u5165\u63d0\u4ea4\u3002\n' +
    '# \u7f16\u8f91\u5b8c\u6210\u540e\uff0c\u70b9\u51fb\u5e95\u90e8\u72b6\u6001\u680f\u300c\u5b8c\u6210\u63d0\u4ea4\u300d\uff08\u4e0d\u4f1a\u81ea\u52a8\u6d88\u5931\uff09\u3002\n';
  const tmpEdit = path.join(os.tmpdir(), 'zkz-sandbox-COMMIT_EDITMSG.txt');
  fs.writeFileSync(tmpEdit, hint, 'utf8');
  const doc = await vscode.workspace.openTextDocument(tmpEdit);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const start = new vscode.Position(0, 0);
  editor.selection = new vscode.Selection(start, start);
  editor.revealRange(new vscode.Range(start, start));

  const accept = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  accept.text = '$(check) \u5b8c\u6210\u63d0\u4ea4';
  accept.tooltip = '\u4f7f\u7528\u5f53\u524d\u7f16\u8f91\u5668\u5185\u5bb9\u63d0\u4ea4';
  accept.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  accept.command = 'zkz-sandbox.commitMessageAccept';
  accept.show();

  const cancel = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
  cancel.text = '$(close) \u53d6\u6d88\u63d0\u4ea4';
  cancel.command = 'zkz-sandbox.commitMessageCancel';
  cancel.show();

  const tip = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 998);
  tip.text = '$(edit) \u8bf7\u586b\u5199\u63d0\u4ea4\u8bf4\u660e\uff08\u53ef\u56de\u8f66\u6362\u884c\uff09';
  tip.show();

  void vscode.commands.executeCommand('setContext', 'zkzSandbox.commitMsgOpen', true);
  return await new Promise((resolve) => {
    gCommitMsgWaiter = {
      resolve,
      doc,
      tmpEdit,
      items: [accept, cancel, tip],
    };
  });
}

module.exports = { promptCommitMessage, finishCommitMessage };
