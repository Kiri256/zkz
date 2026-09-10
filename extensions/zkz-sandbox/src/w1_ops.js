'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { showInfoAuto } = require('./toast');
const { log } = require('./shared');
const { resolvePair, assertW1Git } = require('./pair');
const { openW1WorktreeFile } = require('./w1_fs');
const { showFileCommitHistory } = require('./history_diff');

let gW1Clipboard = null;

function setW1Clipboard(uris, cut) {
  gW1Clipboard = { uris: uris.slice(), cut: !!cut };
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.w1Clipboard', uris.length > 0);
}

function w1ItemAbsPath(item, provider) {
  const pair = (provider && provider.pair) || resolvePair();
  if (!pair || !pair.w1) throw new Error('\u65e0\u6cd5\u89e3\u6790\u672c\u6e90\u8def\u5f84');
  if (item && item.resourceUri && item.resourceUri.fsPath) {
    return item.resourceUri.fsPath;
  }
  if (item && item.kind === 'w1-file' && item.data && item.data.file) {
    return path.join(pair.w1, ...String(item.data.file).split('/').filter(Boolean));
  }
  if (item && item.kind === 'w1-folder' && item.data && item.data.prefix != null) {
    const pref = String(item.data.prefix || '').replace(/\/$/, '');
    return pref ? path.join(pair.w1, ...pref.split('/').filter(Boolean)) : pair.w1;
  }
  throw new Error('\u8bf7\u9009\u62e9\u672c\u6e90\u6587\u4ef6\u6216\u6587\u4ef6\u5939');
}

function w1ItemDir(item, provider) {
  const abs = w1ItemAbsPath(item, provider);
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  } catch (_) { /* ignore */ }
  return path.dirname(abs);
}

async function w1RevealInOS(item, provider) {
  const abs = w1ItemAbsPath(item, provider);
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(abs));
}

async function w1OpenTerminal(item, provider) {
  const dir = w1ItemDir(item, provider);
  const name = '\u672c\u6e90 ' + path.basename(dir);
  let term = vscode.window.terminals.find((t) => t.name === name);
  if (!term) term = vscode.window.createTerminal({ name: name, cwd: dir });
  term.show(true);
}

async function w1FindInFolder(item, provider) {
  const dir = w1ItemDir(item, provider);
  await vscode.commands.executeCommand('workbench.action.findInFiles', {
    query: '',
    filesToInclude: dir
  });
}

async function w1CopyPath(item, provider) {
  const abs = w1ItemAbsPath(item, provider);
  await vscode.env.clipboard.writeText(abs);
  void showInfoAuto('\u5df2\u590d\u5236\u8def\u5f84');
}

async function w1CopyRelativePath(item, provider) {
  const pair = (provider && provider.pair) || resolvePair();
  const abs = w1ItemAbsPath(item, provider);
  const rel = path.relative(pair.w1, abs).replace(/\\/g, '/');
  await vscode.env.clipboard.writeText(rel);
  void showInfoAuto('\u5df2\u590d\u5236\u76f8\u5bf9\u8def\u5f84');
}

async function w1Copy(item, provider) {
  const abs = w1ItemAbsPath(item, provider);
  setW1Clipboard([abs], false);
  await vscode.env.clipboard.writeText(abs);
  void showInfoAuto('\u5df2\u590d\u5236\uff08\u53ef\u5728\u672c\u6e90\u6811\u4e2d\u7c98\u8d34\uff09');
}

async function w1Cut(item, provider) {
  const abs = w1ItemAbsPath(item, provider);
  setW1Clipboard([abs], true);
  await vscode.env.clipboard.writeText(abs);
  void showInfoAuto('\u5df2\u526a\u5207\uff08\u7c98\u8d34\u5230\u76ee\u6807\u6587\u4ef6\u5939\uff09');
}

function copyPathRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyPathRecursive(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

function rmPathRecursive(target) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      rmPathRecursive(path.join(target, name));
    }
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

async function w1Paste(item, provider) {
  if (!gW1Clipboard || !gW1Clipboard.uris.length) {
    void showInfoAuto('\u526a\u8d34\u677f\u4e3a\u7a7a');
    return;
  }
  const destDir = w1ItemDir(item, provider);
  for (const src of gW1Clipboard.uris) {
    if (!fs.existsSync(src)) continue;
    const base = path.basename(src);
    let dst = path.join(destDir, base);
    if (fs.existsSync(dst)) {
      const stamp = Date.now().toString(36);
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      dst = path.join(destDir, stem + '_copy_' + stamp + ext);
    }
    copyPathRecursive(src, dst);
    if (gW1Clipboard.cut) {
      try { rmPathRecursive(src); } catch (e) {
        log('cut remove fail: ' + (e && e.message ? e.message : e));
      }
    }
  }
  if (gW1Clipboard.cut) setW1Clipboard([], false);
  if (provider) {
    provider._w1FilesCache = null;
    provider.refresh();
  }
  void showInfoAuto('\u7c98\u8d34\u5b8c\u6210');
}

async function w1Rename(item, provider) {
  const abs = w1ItemAbsPath(item, provider);
  const oldName = path.basename(abs);
  const next = await vscode.window.showInputBox({
    prompt: '\u91cd\u547d\u540d',
    value: oldName
  });
  if (next === undefined || !next.trim() || next.trim() === oldName) return;
  const dst = path.join(path.dirname(abs), next.trim());
  if (fs.existsSync(dst)) throw new Error('\u76ee\u6807\u5df2\u5b58\u5728: ' + dst);
  fs.renameSync(abs, dst);
  if (provider) {
    provider._w1FilesCache = null;
    provider.refresh();
  }
  void showInfoAuto('\u5df2\u91cd\u547d\u540d\u4e3a ' + next.trim());
}

async function w1Delete(item, provider) {
  const abs = w1ItemAbsPath(item, provider);
  const ok = await vscode.window.showWarningMessage(
    '\u786e\u5b9a\u5220\u9664\u672c\u6e90\u9879\uff1f\n' + abs,
    { modal: true },
    '\u5220\u9664'
  );
  if (ok !== '\u5220\u9664') return;
  rmPathRecursive(abs);
  if (provider) {
    provider._w1FilesCache = null;
    provider.refresh();
  }
  void showInfoAuto('\u5df2\u5220\u9664');
}

async function w1NewFile(item, provider) {
  const dir = w1ItemDir(item, provider);
  const name = await vscode.window.showInputBox({
    prompt: '\u65b0\u5efa\u6587\u4ef6\u540d\uff08\u5efa\u8bae .c / .h\uff09',
    placeHolder: 'yt_example.c'
  });
  if (name === undefined || !name.trim()) return;
  const abs = path.join(dir, name.trim());
  if (fs.existsSync(abs)) throw new Error('\u5df2\u5b58\u5728: ' + abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(0));
  if (provider) {
    provider._w1FilesCache = null;
    provider.refresh();
  }
  const pair = (provider && provider.pair) || resolvePair();
  const rel = path.relative(pair.w1, abs).replace(/\\/g, '/');
  await openW1WorktreeFile(pair.w1, rel);
}

async function w1NewFolder(item, provider) {
  const dir = w1ItemDir(item, provider);
  const name = await vscode.window.showInputBox({
    prompt: '\u65b0\u5efa\u6587\u4ef6\u5939\u540d',
    placeHolder: 'new_module'
  });
  if (name === undefined || !name.trim()) return;
  const abs = path.join(dir, name.trim());
  if (fs.existsSync(abs)) throw new Error('\u5df2\u5b58\u5728: ' + abs);
  fs.mkdirSync(abs, { recursive: true });
  if (provider) {
    provider._w1FilesCache = null;
    provider.refresh();
  }
  void showInfoAuto('\u5df2\u65b0\u5efa\u6587\u4ef6\u5939');
}

async function w1AddToChat(item, provider, newChat) {
  const abs = w1ItemAbsPath(item, provider);
  const uri = vscode.Uri.file(abs);
  const candidates = newChat
    ? ['composer.newAgentChat', 'aichat.newchataction', 'workbench.action.chat.newChat']
    : ['composer.addfilestocomposer', 'aipopup.action.addFileToCursorChat', 'workbench.action.chat.attachContext'];
  for (const cmd of candidates) {
    try {
      await vscode.commands.executeCommand(cmd, uri);
      return;
    } catch (_) { /* try next */ }
  }
  await vscode.env.clipboard.writeText(abs);
  void showInfoAuto('\u5df2\u590d\u5236\u8def\u5f84\uff0c\u8bf7\u5728 Chat \u4e2d\u7c98\u8d34\u9644\u4ef6');
}

async function w1ShowFileHistory(item, provider) {
  const pair = (provider && provider.pair) || resolvePair();
  assertW1Git(pair.w1);
  if (!item || item.kind !== 'w1-file' || !item.data || !item.data.file) return;
  await showFileCommitHistory(pair.w1, String(item.data.file).replace(/\\/g, '/'));
}

module.exports = {
  setW1Clipboard,
  w1ItemAbsPath,
  w1ItemDir,
  w1RevealInOS,
  w1OpenTerminal,
  w1FindInFolder,
  w1CopyPath,
  w1CopyRelativePath,
  w1Copy,
  w1Cut,
  w1Paste,
  w1Rename,
  w1Delete,
  w1NewFile,
  w1NewFolder,
  w1AddToChat,
  w1ShowFileHistory
};
