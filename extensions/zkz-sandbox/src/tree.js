'use strict';
const vscode = require('vscode');
const path = require('path');
const { uiState } = require('./shared');
const { resolvePair, assertW1Git } = require('./pair');
const { runGit, getW1RemoteSyncState, formatRemoteSyncSuffix } = require('./git');
const { isGitManageEnabled } = require('./git_manage');
const { Node, statusLetter, iconForStatus } = require('./tree_nodes');
const treeChanges = require('./tree_changes');
const treeBranches = require('./tree_branches');
const treeW1 = require('./tree_w1');

class W1Provider {
  /**
   * @param {'all'|'changes'|'branches'|'files'} section
   * @param {object|null} shared 三视图共享缓存/事件
   */
  constructor(section, shared) {
    this.section = section || 'all';
    this._shared = shared || null;
    if (shared) {
      this._onDidChangeTreeData = shared.emitter;
      this.onDidChangeTreeData = shared.emitter.event;
    } else {
      this._onDidChangeTreeData = new vscode.EventEmitter();
      this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    this._refreshTimer = null;
    if (!shared) {
      this.pair = null;
      this._w1FilesCache = null;
      this._statusCache = null;
      this._syncCache = null;
    }
  }

  get pair() { return this._shared ? this._shared.pair : this._pairLocal; }
  set pair(v) {
    if (this._shared) this._shared.pair = v;
    else this._pairLocal = v;
  }
  get _w1FilesCache() { return this._shared ? this._shared.w1FilesCache : this._w1FilesCacheLocal; }
  set _w1FilesCache(v) {
    if (this._shared) this._shared.w1FilesCache = v;
    else this._w1FilesCacheLocal = v;
  }
  get _statusCache() { return this._shared ? this._shared.statusCache : this._statusCacheLocal; }
  set _statusCache(v) {
    if (this._shared) this._shared.statusCache = v;
    else this._statusCacheLocal = v;
  }
  get _syncCache() { return this._shared ? this._shared.syncCache : this._syncCacheLocal; }
  set _syncCache(v) {
    if (this._shared) this._shared.syncCache = v;
    else this._syncCacheLocal = v;
  }

  async _cachedStatusPorcelain() {
    const now = Date.now();
    if (this._statusCache && (now - this._statusCache.at) < 2500) return this._statusCache.text;
    const text = await runGit(this.pair.w1, ['status', '--porcelain', '-uall']);
    this._statusCache = { at: now, text: text };
    return text;
  }

  async _cachedRemoteSync() {
    const now = Date.now();
    if (this._syncCache && (now - this._syncCache.at) < 2500) return this._syncCache.st;
    const st = await getW1RemoteSyncState(this.pair.w1);
    this._syncCache = { at: now, st: st };
    return st;
  }
  refresh() {
    this._w1FilesCache = null;
    this._statusCache = null;
    this._syncCache = null;
    // 200ms 合并，避免连续 refresh 打爆 git
    if (this._shared) {
      if (this._shared.refreshTimer) return;
      this._shared.refreshTimer = setTimeout(() => {
        this._shared.refreshTimer = null;
        this._shared.emitter.fire();
      }, 200);
      return;
    }
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._onDidChangeTreeData.fire();
    }, 200);
  }

  /** 仅刷新工作区更改列表（git status），不抓取远程、不动分支缓存 */
  refreshChanges() {
    this._statusCache = null;
    if (this._shared) {
      if (this._shared.refreshTimer) return;
      this._shared.refreshTimer = setTimeout(() => {
        this._shared.refreshTimer = null;
        this._shared.emitter.fire();
      }, 200);
      return;
    }
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._onDidChangeTreeData.fire();
    }, 200);
  }

  /** 仅刷新本源文件树（重扫文件夹），不 fetch、不刷 git status */
  refreshFiles() {
    this._w1FilesCache = null;
    if (this._shared) {
      if (this._shared.refreshTimer) return;
      this._shared.refreshTimer = setTimeout(() => {
        this._shared.refreshTimer = null;
        this._shared.emitter.fire();
      }, 200);
      return;
    }
    if (this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._onDidChangeTreeData.fire();
    }, 200);
  }
  getTreeItem(e) { return e; }

  async _ensurePair() {
    this.pair = resolvePair();
    assertW1Git(this.pair.w1);
    return this.pair;
  }

  async _rootHeaderNode() {
    await this._ensurePair();
    const cur = (await runGit(this.pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const syncSt = await this._cachedRemoteSync();
    const header = new Node(
      path.basename(this.pair.w1),
      vscode.TreeItemCollapsibleState.Expanded,
      'header',
      { syncSt }
    );
    header.description = cur + formatRemoteSyncSuffix(syncSt);
    header.iconPath = new vscode.ThemeIcon('repo');
    const tipLines = [
      this.pair.w1,
      'HEAD: ' + cur,
      syncSt.upstream ? ('upstream: ' + syncSt.upstream) : (syncSt.unpublished ? '\u65e0\u8fdc\u7a0b\u4e0a\u6e38\uff08\u672a\u53d1\u5e03\uff09' : '\u65e0 upstream'),
    ];
    if (syncSt.dirty) tipLines.push('\u5de5\u4f5c\u533a\u6709\u672a\u63d0\u4ea4\u4fee\u6539');
    if (syncSt.ahead > 0) tipLines.push('\u672a\u63a8\u9001: ' + syncSt.ahead + ' \u4e2a\u63d0\u4ea4');
    if (syncSt.behind > 0) tipLines.push('\u843d\u540e\u8fdc\u7a0b: ' + syncSt.behind + ' \u4e2a\u63d0\u4ea4');
    header.tooltip = tipLines.join('\n');
    return header;
  }

  async getChildren(element) {
    try {
      // 真源：侧栏仍显示，Git 管理禁用（下列 tip）；沙箱走完整树
      if (!isGitManageEnabled()) {
        if (element) return [];
        let w1Path = '';
        try { w1Path = resolvePair().w1; } catch (_) { w1Path = ''; }
        const tip = new Node(
          'Git \u7ba1\u7406\u672a\u542f\u7528\uff08\u771f\u6e90\uff09',
          vscode.TreeItemCollapsibleState.None,
          'info',
          {}
        );
        tip.description = '\u8bf7\u7528\u5185\u7f6e Source Control';
        tip.iconPath = new vscode.ThemeIcon('info');
        tip.tooltip = [
          w1Path || '\u771f\u6e90\u5de5\u4f5c\u533a',
          '',
          'zkz Sandbox \u7ba1\u7406\uff08\u5206\u652f/\u63d0\u4ea4/\u672c\u6e90\u6587\u4ef6\uff09\u4ec5\u5728 *U \u6c99\u7bb1\u542f\u7528\u3002',
          '\u5b8f\u5fbd\u7ae0\u3001ToUtf/ToGb\u3001FFFD \u4ecd\u53ef\u7528\u3002'
        ].join('\n');
        return [tip];
      }

      // 拆分视图：根下直接出内容，不再套「更改/分支/本源文件」分组
      if (!element && this.section === 'changes') {
        await this._ensurePair();
        const syncSt = await this._cachedRemoteSync();
        const items = [];
        if (syncSt.ahead > 0 || syncSt.unpublished) {
          const label = syncSt.unpublished
            ? ('\u672a\u4e0a\u4f20\u8fdc\u7a0b' + (syncSt.ahead > 0 ? (' (' + syncSt.ahead + ')') : ' \u00b7 \u672a\u53d1\u5e03'))
            : ('\u672a\u4e0a\u4f20\u8fdc\u7a0b (' + syncSt.ahead + ')');
          items.push(new Node(label, vscode.TreeItemCollapsibleState.Expanded, 'group-unpushed', { syncSt }));
        }
        items.push(...(await this._changeChildren()));
        return items;
      }
      if (!element && this.section === 'branches') {
        await this._ensurePair();
        // 根下直接列分支，不再挂仓库名顶行（如 b_01 - zkz）
        return this._branchChildren();
      }
      if (!element && this.section === 'files') {
        await this._ensurePair();
        return this._w1FileChildren();
      }

      if (!element) {
        return [await this._rootHeaderNode()];
      }

      if (element.kind === 'header') {
        // 分支视图：header 下只挂分支；旧 all 视图挂全部组
        if (this.section === 'branches') {
          return [new Node('\u5206\u652f', vscode.TreeItemCollapsibleState.Expanded, 'group-branches', {})];
        }
        const status = (await this._cachedStatusPorcelain()).trim();
        const n = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
        const modeTip = uiState.viewMode === 'tree' ? '\u6811' : '\u5217\u8868';
        const syncSt = await this._cachedRemoteSync();
        const groups = [];
        if (syncSt.ahead > 0 || syncSt.unpublished) {
          const label = syncSt.unpublished
            ? ('\u672a\u4e0a\u4f20\u8fdc\u7a0b' + (syncSt.ahead > 0 ? (' (' + syncSt.ahead + ')') : ' \u00b7 \u672a\u53d1\u5e03'))
            : ('\u672a\u4e0a\u4f20\u8fdc\u7a0b (' + syncSt.ahead + ')');
          groups.push(new Node(
            label,
            vscode.TreeItemCollapsibleState.Expanded,
            'group-unpushed',
            { syncSt }
          ));
        }
        groups.push(
          new Node(`\u66f4\u6539 (${n}) \u00b7 ${modeTip}`, n ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed, 'group-changes', {}),
          new Node('\u5206\u652f', vscode.TreeItemCollapsibleState.Expanded, 'group-branches', {}),
          new Node(
            (uiState.fileFilter
              ? (`\u672c\u6e90\u6587\u4ef6 \u00b7 \u7b5b\u9009:${uiState.fileFilter} \u00b7 ${modeTip}`)
              : (`\u672c\u6e90\u6587\u4ef6 \u00b7 ${modeTip}`)),
            uiState.fileFilter
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.Collapsed,
            'group-w1-files',
            {}
          )
        );
        return groups;
      }

      if (element.kind === 'group-unpushed') return this._unpushedChildren(element);
      if (element.kind === 'group-changes') return this._changeChildren();
      if (element.kind === 'folder') return this._folderChildren(element);
      if (element.kind === 'group-branches') return this._branchChildren();
      if (element.kind === 'group-w1-files') return this._w1FileChildren();
      if (element.kind === 'w1-folder') return this._w1FolderChildren(element);
      if (element.kind === 'w1-file') return this._w1FileCommitChildren(element);
      if (element.kind === 'branch-local' || element.kind === 'branch-remote') {
        return this._commitChildren(element);
      }
      if (element.kind === 'commit') return this._commitFileChildren(element);
      if (element.kind === 'commit-folder') return this._commitFileLevel(element.data.files, element.data.prefix, element.data.hash);
      return [];
    } catch (e) {
      const tip = new Node(String(e.message || e), vscode.TreeItemCollapsibleState.None, 'info', {});
      tip.iconPath = new vscode.ThemeIcon('error');
      return [tip];
    }
  }

  async _loadChanges() { return treeChanges.loadChanges(this); }
  _makeChangeItem(ch, treeMode) { return treeChanges.makeChangeItem(this, ch, treeMode); }
  async _changeChildren() { return treeChanges.changeChildren(this); }
  _folderChildren(element) { return treeChanges.folderChildren(this, element); }
  _singleSubfolder(changes, prefix) { return treeChanges.singleSubfolder(this, changes, prefix); }
  _buildTreeLevel(changes, prefix) { return treeChanges.buildTreeLevel(this, changes, prefix); }

  async _unpushedChildren(element) { return treeBranches.unpushedChildren(this, element); }
  async _branchChildren() { return treeBranches.branchChildren(this); }
  async _commitChildren(branchItem) { return treeBranches.commitChildren(this, branchItem); }
  async _commitFileChildren(commitItem) { return treeBranches.commitFileChildren(this, commitItem); }
  _makeCommitFileItem(f, treeMode) { return treeBranches.makeCommitFileItem(this, f, treeMode); }
  _commitFileLevel(files, prefix, hash) { return treeBranches.commitFileLevel(this, files, prefix, hash); }

  async _loadW1Files() { return treeW1.loadW1Files(this); }
  _makeW1FileItem(f, treeMode) { return treeW1.makeW1FileItem(this, f, treeMode); }
  async _w1FileCommitChildren(element) { return treeW1.w1FileCommitChildren(this, element); }
  async _w1FileChildren() { return treeW1.w1FileChildren(this); }
  _w1FolderChildren(element) { return treeW1.w1FolderChildren(this, element); }
  _buildW1TreeLevel(files, prefix) { return treeW1.buildW1TreeLevel(this, files, prefix); }
}

/** 侧栏三视图：更改 / 分支 / 本源文件（共享缓存） */
function createSplitProviders() {
  const shared = {
    emitter: new vscode.EventEmitter(),
    pair: null,
    statusCache: null,
    syncCache: null,
    w1FilesCache: null,
    refreshTimer: null
  };
  const changes = new W1Provider('changes', shared);
  const branches = new W1Provider('branches', shared);
  const files = new W1Provider('files', shared);
  return {
    get pair() { return shared.pair; },
    set pair(v) { shared.pair = v; },
    get _w1FilesCache() { return shared.w1FilesCache; },
    set _w1FilesCache(v) { shared.w1FilesCache = v; },
    refresh() {
      shared.statusCache = null;
      shared.syncCache = null;
      shared.w1FilesCache = null;
      if (shared.refreshTimer) return;
      shared.refreshTimer = setTimeout(() => {
        shared.refreshTimer = null;
        shared.emitter.fire();
      }, 200);
    },
    /** 仅刷新更改（status），不 fetch、不清分支/远端 sync 缓存 */
    refreshChanges() {
      shared.statusCache = null;
      if (shared.refreshTimer) return;
      shared.refreshTimer = setTimeout(() => {
        shared.refreshTimer = null;
        shared.emitter.fire();
      }, 200);
    },
    /** 仅刷新本源文件树（重扫文件夹） */
    refreshFiles() {
      shared.w1FilesCache = null;
      if (shared.refreshTimer) return;
      shared.refreshTimer = setTimeout(() => {
        shared.refreshTimer = null;
        shared.emitter.fire();
      }, 200);
    },
    async _loadChanges() { return changes._loadChanges(); },
    changes,
    branches,
    files,
    shared
  };
}

module.exports = { Node, W1Provider, statusLetter, iconForStatus, createSplitProviders };
