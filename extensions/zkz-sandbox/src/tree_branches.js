'use strict';
const vscode = require('vscode');
const path = require('path');
const { uiState } = require('./shared');
const { Node } = require('./tree_nodes');
const { singleSubfolder } = require('./tree_changes');
const { runGit, getW1RemoteSyncState } = require('./git');
const { formatRelativeZh, formatCommitTimeLine } = require('./time_fmt');
const { loadBranches } = require('./branch_cache');

async function unpushedChildren(p, element) {
  const syncSt = (element && element.data && element.data.syncSt) || await getW1RemoteSyncState(p.pair.w1);
  let rangeArgs;
  if (syncSt.hasUpstream && syncSt.upstream) {
    rangeArgs = [syncSt.upstream + '..HEAD'];
  } else if (syncSt.unpublished) {
    // Local commits not on any remote
    rangeArgs = ['HEAD', '--not', '--remotes'];
  } else {
    rangeArgs = ['@{u}..HEAD'];
  }
  let out = '';
  try {
    out = await runGit(p.pair.w1, ['log'].concat(rangeArgs, [
      '-n',
      '40',
      '--format=%h%x09%ct%x09%an%x09%s'
    ]));
  } catch (e) {
    const tip = new Node(String(e && e.message ? e.message : e), vscode.TreeItemCollapsibleState.None, 'info', {});
    tip.iconPath = new vscode.ThemeIcon('error');
    return [tip];
  }
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    const empty = new Node(
      syncSt.unpublished ? '\u5206\u652f\u5c1a\u672a\u53d1\u5e03\u5230\u8fdc\u7a0b' : '\u65e0\u672a\u63a8\u9001\u63d0\u4ea4',
      vscode.TreeItemCollapsibleState.None,
      'info',
      {}
    );
    empty.iconPath = new vscode.ThemeIcon(syncSt.unpublished ? 'cloud-upload' : 'info');
    empty.description = syncSt.unpublished ? '\u70b9\u5de5\u5177\u680f\u63a8\u9001\u4ee5\u53d1\u5e03' : '';
    return [empty];
  }
  return lines.map((line) => {
    const parts = line.split('\t');
    const hash = parts[0] || '';
    const dateUnix = Number(parts[1] || 0) || 0;
    const author = parts[2] || '';
    const subject = parts.slice(3).join('\t') || hash;
    const item = new Node(subject, vscode.TreeItemCollapsibleState.Collapsed, 'commit', {
      hash,
      author,
      subject,
      ref: 'HEAD',
      dateUnix,
      unpushed: true
    });
    item.description = (formatRelativeZh(dateUnix) ? formatRelativeZh(dateUnix) + '  ' : '') + author + '  ' + hash;
    item.iconPath = new vscode.ThemeIcon('cloud-upload');
    item.tooltip = [
      '\u672a\u4e0a\u4f20\u8fdc\u7a0b',
      hash,
      author,
      subject,
      formatCommitTimeLine(dateUnix),
      '',
      '\u5c55\u5f00\u67e5\u770b\u8be5\u63d0\u4ea4\u4fee\u6539\u7684\u6587\u4ef6'
    ].filter(Boolean).join('\n');
    return item;
  });
}

async function branchChildren(p) {
  const w1 = p.pair.w1;
  const branches = await loadBranches(w1);
  const filter = (uiState.branchFilter || '').trim().toLowerCase();

  const filterRow = new Node(
    filter ? ('筛选: ' + filter) : '输入筛选...',
    vscode.TreeItemCollapsibleState.None,
    'branch-filter',
    {}
  );
  filterRow.iconPath = new vscode.ThemeIcon('search');
  filterRow.description = '点击输入，筛选下方列表';
  filterRow.command = {
    command: 'zkz-sandbox.filterBranches',
    title: 'filter',
    arguments: [{}]
  };

  const pickRow = new Node(
    '筛选并选择...',
    vscode.TreeItemCollapsibleState.None,
    'branch-pick',
    {}
  );
  pickRow.iconPath = new vscode.ThemeIcon('filter');
  pickRow.description = '输入即筛选并签出';
  pickRow.command = {
    command: 'zkz-sandbox.pickBranch',
    title: 'pick',
    arguments: [{}]
  };

  const items = [filterRow, pickRow];
  for (const b of branches) {
    if (filter) {
      const hay = (b.name + ' ' + b.author + ' ' + b.subject).toLowerCase();
      if (!hay.includes(filter)) continue;
    }
    const item = new Node(
      b.name,
      vscode.TreeItemCollapsibleState.Collapsed,
      b.isRemote ? 'branch-remote' : 'branch-local',
      { ref: b.ref, isRemote: b.isRemote, current: b.current }
    );
    const tip = b.isRemote ? '远程分支' : '分支';
    item.description = (b.dateRel || '') + (b.current ? '  HEAD' : '') + '  ' + tip;
    item.iconPath = new vscode.ThemeIcon(
      b.current ? 'check' : (b.isRemote ? 'cloud' : 'git-branch')
    );
    item.tooltip = [
      b.name,
      formatCommitTimeLine(b.dateUnix),
      (b.author ? b.author + ' • ' : '') + (b.subject || ''),
      '',
      '展开查看提交记录；右侧勾选签出'
    ].filter((s) => s !== undefined && s !== null).join('\n');
    items.push(item);
  }
  return items;
}

async function commitChildren(p, branchItem) {
  const ref = branchItem.data && branchItem.data.ref;
  if (!ref) return [];
  const out = await runGit(p.pair.w1, [
    'log',
    ref,
    '-n',
    '40',
    '--format=%h%x09%ct%x09%an%x09%s'
  ]);
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    const empty = new Node('暂无提交记录', vscode.TreeItemCollapsibleState.None, 'info', {});
    empty.iconPath = new vscode.ThemeIcon('info');
    return [empty];
  }
  return lines.map((line) => {
    const parts = line.split('\t');
    const hash = parts[0] || '';
    const dateUnix = Number(parts[1] || 0) || 0;
    const author = parts[2] || '';
    const subject = parts.slice(3).join('\t') || hash;
    const timeLine = formatCommitTimeLine(dateUnix);
    const item = new Node(subject, vscode.TreeItemCollapsibleState.Collapsed, 'commit', {
      hash,
      author,
      subject,
      ref,
      dateUnix
    });
    item.description = (formatRelativeZh(dateUnix) ? formatRelativeZh(dateUnix) + '  ' : '') + author + '  ' + hash;
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.tooltip = [
      hash,
      author,
      subject,
      timeLine,
      '',
      '展开查看该提交修改的文件'
    ].filter(Boolean).join('\n');
    return item;
  });
}

async function commitFileChildren(p, commitItem) {
  const hash = commitItem.data && commitItem.data.hash;
  if (!hash) return [];
  // name-status: M/A/D/R... + path
  const out = await runGit(p.pair.w1, [
    'diff-tree',
    '--no-commit-id',
    '--name-status',
    '-r',
    '-M',
    hash
  ]);
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    const empty = new Node('无文件变更', vscode.TreeItemCollapsibleState.None, 'info', {});
    empty.iconPath = new vscode.ThemeIcon('info');
    return [empty];
  }
  const files = lines.map((line) => {
    const parts = line.split('\t');
    let status = (parts[0] || 'M').charAt(0);
    let file = parts[parts.length - 1] || '';
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      file = parts[2];
    }
    file = file.replace(/\\/g, '/');
    return { status, file, hash };
  });
  // 与「更改」共用列表/树切换
  if (uiState.viewMode === 'list') {
    const items = files.map((f) => makeCommitFileItem(p, f, false));
    items.sort((a, b) => String(a.data.file).localeCompare(String(b.data.file)));
    return items;
  }
  return commitFileLevel(p, files, '', hash);
}

function makeCommitFileItem(p, f, treeMode) {
  const base = path.posix.basename(f.file);
  const dir = path.posix.dirname(f.file);
  const item = new Node(
    base,
    vscode.TreeItemCollapsibleState.None,
    'commit-file',
    { hash: f.hash, file: f.file, status: f.status }
  );
  // 与更改一致：语言文件图标
  item.resourceUri = vscode.Uri.file(path.join(p.pair.w1, f.file));
  if (treeMode) {
    item.description = f.status;
  } else {
    item.description = (dir && dir !== '.' ? dir + '  ' : '') + f.status;
  }
  item.tooltip = f.file + ' [' + f.status + ']';
  item.command = {
    command: 'zkz-sandbox.openCommitFile',
    title: 'open',
    arguments: [item]
  };
  return item;
}

function commitFileLevel(p, files, prefix, hash) {
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
    // 压缩单子目录链（与更改树一致）
    for (;;) {
      const sub = singleSubfolder(p, childFiles, childPrefix);
      if (!sub) break;
      label = label + '/' + sub;
      childPrefix = childPrefix + sub + '/';
    }
    const node = new Node(label, vscode.TreeItemCollapsibleState.Expanded, 'commit-folder', {
      prefix: childPrefix,
      files: childFiles,
      hash
    });
    node.iconPath = new vscode.ThemeIcon('folder');
    node.description = String(childFiles.length);
    items.push(node);
  }
  leafs.sort((a, b) => path.posix.basename(a.file).localeCompare(path.posix.basename(b.file)));
  for (const f of leafs) items.push(makeCommitFileItem(p, f, true));
  return items;
}

module.exports = { unpushedChildren, branchChildren, commitChildren, commitFileChildren, makeCommitFileItem, commitFileLevel };
