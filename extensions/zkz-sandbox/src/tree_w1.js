'use strict';
const vscode = require('vscode');
const path = require('path');
const { uiState } = require('./shared');
const { Node } = require('./tree_nodes');
const { singleSubfolder } = require('./tree_changes');
const { loadW1AllFiles, matchFileFilter } = require('./w1_files');
const { formatRelativeZh, formatDateTimeZh, formatCommitTimeLine } = require('./time_fmt');
const { runGit } = require('./git');

async function loadW1Files(p) {
  if (p._w1FilesCache && Array.isArray(p._w1FilesCache)) return p._w1FilesCache;
  const files = await loadW1AllFiles(p.pair.w1);
  p._w1FilesCache = files;
  return files;
}

function makeW1FileItem(p, f, treeMode) {
  const base = path.posix.basename(f.file);
  const dir = path.posix.dirname(f.file);
  const item = new Node(
    base,
    vscode.TreeItemCollapsibleState.Collapsed,
    'w1-file',
    { file: f.file }
  );
  item.resourceUri = vscode.Uri.file(path.join(p.pair.w1, f.file));
  if (!treeMode) {
    item.description = dir && dir !== '.' ? dir : '';
  }
  item.tooltip = path.join(p.pair.w1, f.file) +
    '\n\u5de6\u952e\u6253\u5f00\uff08\u9009\u4e2d\u884c\u884c\u5c3e\u663e\u793a\u63d0\u4ea4\uff09\uff1b\u5c55\u5f00\u53ef\u770b\u63d0\u4ea4\u5217\u8868\uff1b\u53f3\u952e\u53ef\u67e5\u5386\u53f2';
  item.command = {
    command: 'zkz-sandbox.openW1BrowseFile',
    title: 'open',
    arguments: [item]
  };
  return item;
}

async function w1FileCommitChildren(p, fileItem) {
  const filePosix = fileItem && fileItem.data && fileItem.data.file;
  if (!filePosix) return [];
  const out = await runGit(p.pair.w1, [
    '-c', 'core.quotepath=false',
    'log', '--follow', '-n', '30',
    '--format=%h%x09%H%x09%ct%x09%an%x09%s',
    '--', filePosix
  ]);
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    const empty = new Node('\u6682\u65e0\u63d0\u4ea4\u8bb0\u5f55', vscode.TreeItemCollapsibleState.None, 'info', {});
    empty.iconPath = new vscode.ThemeIcon('info');
    return [empty];
  }
  return lines.map((line) => {
    const parts = line.split('\t');
    const short = parts[0] || '';
    const hash = parts[1] || short;
    const dateUnix = Number(parts[2] || 0) || 0;
    const author = parts[3] || '';
    const subject = parts.slice(4).join('\t') || '';
    const item = new Node(
      short + '  ' + subject,
      vscode.TreeItemCollapsibleState.None,
      'commit',
      { hash: hash, file: filePosix }
    );
    item.description = (formatRelativeZh(dateUnix) || '') + (author ? '  ' + author : '');
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.tooltip = [short, formatCommitTimeLine(dateUnix), author, subject, '', '\u70b9\u51fb\u67e5\u770b\u63d0\u4ea4\u8be6\u60c5'].filter(Boolean).join('\n');
    item.command = {
      command: 'zkz-sandbox.showCommit',
      title: 'show',
      arguments: [item]
    };
    return item;
  });
}

async function w1FileChildren(p) {
  const all = await loadW1Files(p);
  const filter = (uiState.fileFilter || '').trim();
  const files = filter
    ? all.filter((f) => matchFileFilter(f.file, filter))
    : all;

  const filterRow = new Node(
    filter ? ('筛选: ' + filter) : '输入筛选...',
    vscode.TreeItemCollapsibleState.None,
    'w1-filter',
    {}
  );
  filterRow.iconPath = new vscode.ThemeIcon('search');
  filterRow.description = filter
    ? ('\u5339\u914d ' + files.length + '/' + all.length + ' \u00b7 \u70b9\u51fb\u4fee\u6539')
    : '\u771f\u6e90\u5168\u90e8\u6587\u4ef6 \u00b7 \u8def\u5f84\u5173\u952e\u5b57\uff0c\u7a7a\u683c=AND';
  filterRow.command = {
    command: 'zkz-sandbox.filterW1Files',
    title: 'filter',
    arguments: [{}]
  };

  const pickRow = new Node(
    '搜索并打开...',
    vscode.TreeItemCollapsibleState.None,
    'w1-pick',
    {}
  );
  pickRow.iconPath = new vscode.ThemeIcon('filter');
  pickRow.description = '输入即筛选，回车打开';
  pickRow.command = {
    command: 'zkz-sandbox.browseW1File',
    title: 'browse',
    arguments: [{}]
  };

  if (!all.length) {
    const empty = new Node('无文件', vscode.TreeItemCollapsibleState.None, 'info', {});
    empty.iconPath = new vscode.ThemeIcon('info');
    return [filterRow, pickRow, empty];
  }
  if (filter && !files.length) {
    const empty = new Node('无匹配文件', vscode.TreeItemCollapsibleState.None, 'info', {});
    empty.iconPath = new vscode.ThemeIcon('info');
    empty.description = '点击上方「筛选」修改关键字';
    return [filterRow, pickRow, empty];
  }

  let body;
  // 有筛选或列表模式：扁平列表便于扫结果；否则目录树
  if (uiState.viewMode === 'list' || filter) {
    const items = files.map((f) => makeW1FileItem(p, f, false));
    items.sort((a, b) => String(a.data.file).localeCompare(String(b.data.file)));
    body = items;
  } else {
    body = buildW1TreeLevel(p, files, '');
  }
  return [filterRow, pickRow].concat(body);
}

function w1FolderChildren(p, element) {
  const prefix = element.data.prefix || '';
  return buildW1TreeLevel(p, element.data.files || [], prefix);
}

function buildW1TreeLevel(p, files, prefix) {
  const folders = new Map();
  const leafs = [];
  for (const f of files) {
    const rel = prefix ? (f.file.startsWith(prefix) ? f.file.slice(prefix.length) : f.file) : f.file;
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) continue;
    if (parts.length === 1) leafs.push(f);
    else {
      const folder = parts[0];
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(f);
    }
  }
  const items = [];
  for (const name of [...folders.keys()].sort((a, b) => a.localeCompare(b))) {
    let label = name;
    let childPrefix = prefix + name + '/';
    const childFiles = folders.get(name);
    for (;;) {
      const sub = singleSubfolder(p, childFiles, childPrefix);
      if (!sub) break;
      label = label + '/' + sub;
      childPrefix = childPrefix + sub + '/';
    }
    const node = new Node(label, vscode.TreeItemCollapsibleState.Collapsed, 'w1-folder', {
      prefix: childPrefix,
      files: childFiles
    });
    const folderAbs = childPrefix
      ? path.join(p.pair.w1, ...String(childPrefix).replace(/\/$/, '').split('/').filter(Boolean))
      : p.pair.w1;
    node.resourceUri = vscode.Uri.file(folderAbs);
    node.iconPath = new vscode.ThemeIcon('folder');
    node.description = String(childFiles.length);
    items.push(node);
  }
  leafs.sort((a, b) => path.posix.basename(a.file).localeCompare(path.posix.basename(b.file)));
  for (const f of leafs) items.push(makeW1FileItem(p, f, true));
  return items;
}

module.exports = { loadW1Files, makeW1FileItem, w1FileCommitChildren, w1FileChildren, w1FolderChildren, buildW1TreeLevel };
