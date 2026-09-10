'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { showInfoAuto } = require('./toast');
const {
  GIT_SCHEME,
  output,
  uiState,
  withProgress
} = require('./shared');
const { resolvePair, assertW1Git } = require('./pair');
const { runGit } = require('./git');
const { formatCommitTimeLine } = require('./time_fmt');
const { openW1WorktreeFile } = require('./w1_fs');
const { loadW1AllFiles, listW1Files } = require('./w1_files');

async function showFileCommitHistory(w1, filePosix) {
  const fmt = '%H%x09%h%x09%an%x09%at%x09%s';
  let logOut = '';
  try {
    logOut = await runGit(w1, [
      '-c', 'core.quotepath=false',
      'log', '--follow', '-n', '100',
      '--format=' + fmt,
      '--', filePosix
    ]);
  } catch (e) {
    throw new Error('\u8bfb\u53d6\u6587\u4ef6\u63d0\u4ea4\u5386\u53f2\u5931\u8d25: ' + (e && e.message ? e.message : e));
  }
  const lines = logOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    void showInfoAuto('\u8be5\u6587\u4ef6\u65e0\u63d0\u4ea4\u5386\u53f2: ' + filePosix);
    return;
  }
  const items = lines.map((line) => {
    const parts = line.split('\t');
    const hash = parts[0] || '';
    const short = parts[1] || hash.slice(0, 7);
    const author = parts[2] || '';
    const at = Number(parts[3] || 0);
    const subject = parts.slice(4).join('\t') || '';
    const when = at ? formatCommitTimeLine(at) : '';
    return {
      label: '$(git-commit) ' + short + '  ' + subject,
      description: author,
      detail: when + '  ' + filePosix,
      hash,
      short,
      subject,
      file: filePosix
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '\u300c' + filePosix + '\u300d\u7684\u63d0\u4ea4\u5386\u53f2\uff08' + items.length + '\u6761\uff0c\u53ef\u641c\u7d22\uff09',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(info) \u67e5\u770b\u63d0\u4ea4\u8be6\u60c5', id: 'detail' },
      { label: '$(file) \u6253\u5f00\u8be5\u7248\u672c\u6587\u4ef6', id: 'open' },
      { label: '$(diff) \u4e0e\u5de5\u4f5c\u533a\u5bf9\u6bd4', id: 'diffWork' },
      { label: '$(diff) \u4e0e\u4e0a\u4e00\u7248\u5bf9\u6bd4', id: 'diffParent' },
      { label: '$(folder-opened) \u6253\u5f00\u5de5\u4f5c\u533a\u6587\u4ef6', id: 'openWork' }
    ],
    { placeHolder: picked.short + ' ' + picked.subject }
  );
  if (!action) return;

  if (action.id === 'detail') {
    await showCommit({ data: { hash: picked.hash } }, { pair: { w1 } });
    return;
  }
  if (action.id === 'open') {
    const uri = gitRevUri(w1, picked.hash, filePosix);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  if (action.id === 'diffWork') {
    const left = gitRevUri(w1, picked.hash, filePosix);
    const right = gitRevUri(w1, '__worktree__', filePosix);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      filePosix + ' (' + picked.short + ' \u2194 \u5de5\u4f5c\u533a)'
    );
    return;
  }
  if (action.id === 'diffParent') {
    await openCommitFile(
      { data: { hash: picked.hash, file: filePosix, status: 'M' } },
      { pair: { w1 } }
    );
    return;
  }
  if (action.id === 'openWork') {
    await openW1WorktreeFile(w1, filePosix);
  }
}

async function browseW1File(provider, historyOnly) {
  const pair = provider.pair || resolvePair();
  assertW1Git(pair.w1);
  const files = await withProgress('\u5217\u672c\u6e90\u6587\u4ef6...', async () => listW1Files(pair.w1));
  if (!files.length) {
    void showInfoAuto('\u672c\u6e90\u6ca1\u6709\u53ef\u6d4f\u89c8\u7684\u8ddf\u8e2a\u6587\u4ef6');
    return;
  }
  const items = files.map((f) => {
    const base = path.posix.basename(f);
    const dir = path.posix.dirname(f);
    return {
      label: '$(file) ' + base,
      description: dir === '.' ? '' : dir,
      detail: f,
      file: f
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '\u641c\u7d22\u672c\u6e90\u6587\u4ef6\uff08\u5171 ' + files.length + ' \u4e2a\uff0c\u8f93\u5165\u8def\u5f84\u5173\u952e\u5b57\uff09',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) return;
  const filePosix = picked.file;
  if (historyOnly) {
    await showFileCommitHistory(pair.w1, filePosix);
    return;
  }
  await openW1WorktreeFile(pair.w1, filePosix);
}

async function filterW1Files(arg, provider) {
  const value = await vscode.window.showInputBox({
    prompt: '\u7b5b\u9009\u672c\u6e90\u6587\u4ef6\uff08\u8def\u5f84\u5173\u952e\u5b57\uff0c\u7a7a\u683c=AND\uff09',
    value: uiState.fileFilter,
    placeHolder: '\u4f8b: yt_system  \u6216  core dispense\uff1b\u7559\u7a7a\u6e05\u9664'
  });
  if (value === undefined) return;
  uiState.fileFilter = value.trim();
  provider.refresh();
}

async function pickW1File(provider, historyOnly) {
  const pair = provider.pair || resolvePair();
  assertW1Git(pair.w1);
  let files;
  if (provider && provider._w1FilesCache && Array.isArray(provider._w1FilesCache)) {
    files = provider._w1FilesCache;
  } else {
    files = await loadW1AllFiles(pair.w1);
    if (provider) provider._w1FilesCache = files;
  }

    if (!files.length) {
    void showInfoAuto('\u672c\u6e90\u6ca1\u6709\u53ef\u641c\u7d22\u7684\u8ddf\u8e2a\u6587\u4ef6');
    return;
  }
  const preset = (uiState.fileFilter || '').trim();
  const items = files.map((f) => {
    const base = path.posix.basename(f.file);
    const dir = path.posix.dirname(f.file);
    return {
      label: '$(file) ' + base,
      description: dir === '.' ? '' : dir,
      detail: f.file,
      file: f.file
    };
  });
  const picked = await new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    let settled = false;
    qp.items = items;
    qp.placeholder = '\u641c\u7d22\u672c\u6e90\u6587\u4ef6\uff08\u5171 ' + files.length + ' \u4e2a\uff0c\u8f93\u5165\u8def\u5f84\u5173\u952e\u5b57\uff09';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    if (preset) qp.value = preset;
    qp.onDidAccept(() => {
      const sel = qp.selectedItems && qp.selectedItems[0];
      settled = true;
      qp.hide();
      resolve(sel || null);
    });
    qp.onDidHide(() => {
      if (!settled) resolve(null);
      qp.dispose();
    });
    qp.show();
  });
  if (!picked) return;
  const filePosix = picked.file;
  if (historyOnly) {
    await showFileCommitHistory(pair.w1, filePosix);
    return;
  }
  await openW1WorktreeFile(pair.w1, filePosix);
}

function gitRevUri(w1, rev, file) {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: '/' + String(file).replace(/\\/g, '/'),
    query: JSON.stringify({ w1, rev, file: String(file).replace(/\\/g, '/') })
  });
}

async function showCommit(item, provider) {
  const pair = provider.pair || resolvePair();
  assertW1Git(pair.w1);
  const hash = item && item.data && item.data.hash;
  if (!hash) return;
  const detail = await runGit(pair.w1, ['show', '-s', '--format=fuller', '--stat', hash]);
  output.clear();
  output.appendLine(detail);
  output.show(true);
}

async function openCommitFile(item, provider) {
  const pair = provider.pair || resolvePair();
  assertW1Git(pair.w1);
  const hash = item && item.data && item.data.hash;
  const file = item && item.data && item.data.file;
  const status = (item && item.data && item.data.status) || 'M';
  if (!hash || !file) return;
  const title = file + ' (' + hash.slice(0, 7) + ')';
  if (status === 'A') {
    const right = gitRevUri(pair.w1, hash, file);
    const doc = await vscode.workspace.openTextDocument(right);
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  if (status === 'D') {
    const left = gitRevUri(pair.w1, hash + '^', file);
    const doc = await vscode.workspace.openTextDocument(left);
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  const left = gitRevUri(pair.w1, hash + '^', file);
  const right = gitRevUri(pair.w1, hash, file);
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

module.exports = {
  showFileCommitHistory,
  filterW1Files,
  pickW1File,
  gitRevUri,
  showCommit,
  openCommitFile
};
