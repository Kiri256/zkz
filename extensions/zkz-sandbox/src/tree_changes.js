'use strict';
const vscode = require('vscode');
const path = require('path');
const { uiState } = require('./shared');
const { Node, statusLetter } = require('./tree_nodes');

async function loadChanges(p) {
  const out = await p._cachedStatusPorcelain();
  const lines = out.split(/\r?\n/).map((s) => s.trimEnd()).filter(Boolean);
  return lines.map((line) => {
    const xy = line.slice(0, 2);
    let file = line.slice(3);
    // rename/copy: "R  old -> new"
    if ((xy[0] === 'R' || xy[0] === 'C') && file.includes(' -> ')) {
      file = file.split(' -> ').pop();
    }
    file = file.replace(/^"/, '').replace(/"$/, '').replace(/\\/g, '/');
    const letter = statusLetter(xy);
    const staged = xy[0] !== ' ' && xy[0] !== '?';
    return { file, xy, letter, staged };
  });
}

function makeChangeItem(p, ch, treeMode) {
  const base = path.posix.basename(ch.file);
  const dir = path.posix.dirname(ch.file);
  const item = new Node(
    base,
    vscode.TreeItemCollapsibleState.None,
    ch.staged ? 'change-staged' : 'change-unstaged',
    { file: ch.file.replace(/\//g, path.sep), xy: ch.xy }
  );
  // 列表/树统一：语言文件图标（resourceUri）+ 状态字母描述，避免树用文档图标、列表用 C 图标不一致
  item.resourceUri = vscode.Uri.file(path.join(p.pair.w1, ch.file));
  if (treeMode) {
    item.description = ch.letter;
  } else {
    item.description = (dir && dir !== '.' ? dir + '  ' : '') + ch.letter;
  }
  item.command = { command: 'zkz-sandbox.openChange', title: '打开', arguments: [item] };
  item.tooltip = path.join(p.pair.w1, ch.file) + ' [' + ch.xy + ']';
  return item;
}

/** 更新「更改」视图标题旁数量 / badge（需 createTreeView） */
function updateChangesChrome(p, total) {
  const view = p && p._shared && p._shared.changesView;
  if (!view) return;
  const n = total | 0;
  try {
    view.description = n > 0 ? (String(n) + ' \u4e2a\u6587\u4ef6') : '';
    view.badge = n > 0
      ? { value: n, tooltip: '\u5171 ' + n + ' \u4e2a\u53d8\u66f4\u6587\u4ef6' }
      : undefined;
  } catch (_) { /* ignore */ }
}

async function changeChildren(p) {
  const changes = await loadChanges(p);
  updateChangesChrome(p, changes.length);
  if (!changes.length) {
    const clean = new Node('\u5de5\u4f5c\u533a\u5e72\u51c0', vscode.TreeItemCollapsibleState.None, 'info', {});
    clean.iconPath = new vscode.ThemeIcon('check');
    return [clean];
  }
  if (uiState.viewMode === 'list') {
    const items = changes.map((ch) => makeChangeItem(p, ch, false));
    items.sort((a, b) => String(a.data.file).localeCompare(String(b.data.file)));
    return items;
  }
  // 树：只返回根级文件夹/文件
  return buildTreeLevel(p, changes, '');
}

function folderChildren(p, element) {
  const prefix = element.data.prefix || '';
  return buildTreeLevel(p, element.data.changes || [], prefix);
}

function singleSubfolder(p, changes, prefix) {
  const folders = new Set();
  let fileCount = 0;
  for (const ch of changes) {
    const rel = prefix ? (ch.file.startsWith(prefix) ? ch.file.slice(prefix.length) : ch.file) : ch.file;
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) continue;
    if (parts.length === 1) fileCount++;
    else folders.add(parts[0]);
  }
  if (fileCount === 0 && folders.size === 1) return [...folders][0];
  return null;
}

function buildTreeLevel(p, changes, prefix) {
  /** @type {Map<string, any[]>} */
  const folders = new Map();
  const files = [];
  for (const ch of changes) {
    const rel = prefix ? (ch.file.startsWith(prefix) ? ch.file.slice(prefix.length) : ch.file) : ch.file;
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) continue;
    if (parts.length === 1) {
      files.push(ch);
    } else {
      const folder = parts[0];
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(ch);
    }
  }
  const items = [];
  const folderNames = [...folders.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of folderNames) {
    let label = name;
    let childPrefix = prefix + name + '/';
    const childChanges = folders.get(name);
    // 压缩单子目录链，避免 core → core_common 多一层无意义缩进
    for (;;) {
      const sub = singleSubfolder(p, childChanges, childPrefix);
      if (!sub) break;
      label = label + '/' + sub;
      childPrefix = childPrefix + sub + '/';
    }
    const node = new Node(label, vscode.TreeItemCollapsibleState.Expanded, 'folder', {
      prefix: childPrefix,
      changes: childChanges
    });
    node.iconPath = new vscode.ThemeIcon('folder');
    node.description = String(childChanges.length);
    items.push(node);
  }
  files.sort((a, b) => path.posix.basename(a.file).localeCompare(path.posix.basename(b.file)));
  for (const ch of files) items.push(makeChangeItem(p, ch, true));
  return items;
}

module.exports = {
  loadChanges,
  makeChangeItem,
  changeChildren,
  folderChildren,
  singleSubfolder,
  buildTreeLevel,
  updateChangesChrome
};
