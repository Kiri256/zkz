'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { bufferToText } = require('./encoding');
const {
  GIT_SCHEME,
  output,
  syncUiContext,
  log
} = require('./shared');
const {
  resolvePair,
  isSandboxWorkspace,
  assertW1Git
} = require('./pair');
const { registerW1EditFs } = require('./w1_fs');
const { clearIgnoredW1Repositories, ignoreW1InBuiltinGit } = require('./scm');
const {
  refreshGitManageFromWorkspace,
  assertGitManage
} = require('./git_manage');
const { assertNotSyncing } = require('./sync_gate');

/** 分支预取：启动一次；获焦不再预取（打开侧栏分支视图时再刷） */
const PREFETCH_COOLDOWN_MS = 90000;
let gLastPrefetchAt = 0;
let gGitManageActivated = false;
/** @type {vscode.Disposable[]} */
let gBootTreeRegs = [];

/** 未配对到本源 Git 时的轻量命令（配对后走 activateGitManage 全量注册） */
function registerLightCommands(context) {
  const wrap = (fn) => async (...args) => {
    try { await fn(...args); }
    catch (e) {
      vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
    }
  };
  const entries = [
    ['zkz-sandbox.showOutput', () => output.show(true)],
    ['zkz-sandbox.diffSandboxW1', async (arg) => {
      await require('./pair_diff').diffSandboxW1(arg);
    }],
    ['zkz-sandbox.diffSandboxW1Batch', async () => {
      await require('./pair_diff_batch').showPairDiffBatch();
    }],
    ['zkz-sandbox.openW1Explorer', async () => {
      const pair = resolvePair();
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pair.w1));
    }],
    ['zkz-sandbox.openW1Terminal', async () => {
      const pair = resolvePair();
      const name = '\u771f\u6e90 ' + path.basename(pair.w1);
      let term = vscode.window.terminals.find((t) => t.name === name);
      if (!term) term = vscode.window.createTerminal({ name: name, cwd: pair.w1 });
      term.show(true);
    }]
  ];
  for (const [id, fn] of entries) {
    context.subscriptions.push(vscode.commands.registerCommand(id, wrap(fn)));
  }
}

function registerGitContentProvider(context, runGitBuffer) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      async provideTextDocumentContent(uri) {
        try {
          const q = JSON.parse(uri.query || '{}');
          const w1root = q.w1;
          const rev = q.rev;
          const file = q.file;
          if (!file) return '';
          if (rev === '__empty__') return '';
          if (rev === '__worktree__') {
            if (!w1root) return '';
            const full = path.join(w1root, file);
            if (!fs.existsSync(full)) return '';
            return bufferToText(fs.readFileSync(full));
          }
          if (!w1root || !rev) return '';
          const buf = await runGitBuffer(w1root, ['show', rev + ':' + file]);
          return bufferToText(buf);
        } catch (e) {
          log('git show content: ' + (e && e.message ? e.message : e));
          return '';
        }
      }
    })
  );
}

/** 沙箱/真源：加载 git/tree/commands（状态栏/宏已先挂好） */
function activateGitManage(context, providerHolder) {
  if (gGitManageActivated) return;
  gGitManageActivated = true;
  log('activateGitManage: loading git/tree/commands...');

  const {
    runGit,
    runGitBuffer,
    getW1RemoteSyncState,
    translateGitError
  } = require('./git');
  const { loadBranches } = require('./branch_cache');
  const {
    scheduleBlameUpdate,
    scheduleBlameSelectionUpdate,
    disposeBlameDecoration
  } = require('./blame');
  const { createSplitProviders } = require('./tree');

  const provider = createSplitProviders();
  providerHolder.provider = provider;
  // createTreeView：便于「更改」标题旁显示文件数 / badge
  const changesView = vscode.window.createTreeView('zkzSandboxChanges', {
    treeDataProvider: provider.changes,
    showCollapseAll: true
  });
  provider.shared.changesView = changesView;
  const branchesView = vscode.window.createTreeView('zkzSandboxBranches', {
    treeDataProvider: provider.branches,
    showCollapseAll: true
  });
  context.subscriptions.push(
    changesView,
    branchesView,
    vscode.window.registerTreeDataProvider('zkzSandboxFiles', provider.files)
  );
  for (const d of gBootTreeRegs) {
    try { d.dispose(); } catch (_) { /* ignore */ }
  }
  gBootTreeRegs = [];
  registerGitContentProvider(context, runGitBuffer);
  try { provider.refresh(); } catch (_) { /* ignore */ }

  const wrap = (fn) => async (...args) => {
    try { await fn(...args); }
    catch (e) {
      const raw = String(e && e.message ? e.message : e);
      vscode.window.showErrorMessage(translateGitError(raw));
    }
  };
  const wrapGit = (fn) => wrap(async (...args) => {
    if (!assertGitManage()) return;
    if (!assertNotSyncing()) return;
    await fn(...args);
  });
  const w1 = async () => {
    const pair = resolvePair();
    assertW1Git(pair.w1);
    return pair;
  };

  require('./commands').registerCommands(context, { provider, wrap, wrapGit, w1 });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed) return;
      // 切编辑器：才允许 git blame（有缓存则直接画）
      scheduleBlameUpdate(ed);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!e || !e.textEditor) return;
      // 跟选只动装饰，不重复跑 git blame
      scheduleBlameSelectionUpdate(e.textEditor);
    }),
    { dispose: () => disposeBlameDecoration() }
  );

  const prefetchBranches = (force) => {
    const now = Date.now();
    if (!force && (now - gLastPrefetchAt) < PREFETCH_COOLDOWN_MS) return;
    try {
      const pair = resolvePair();
      if (pair && pair.w1 && fs.existsSync(path.join(pair.w1, '.git'))) {
        gLastPrefetchAt = now;
        loadBranches(pair.w1).catch((e) => log('branch prefetch: ' + (e && e.message ? e.message : e)));
      }
    } catch (e) {
      log('branch prefetch skip: ' + (e && e.message ? e.message : e));
    }
  };
  // 启动轻量预取一次；获焦不再预取，可见「分支」侧栏时再刷
  setTimeout(() => prefetchBranches(true), 2500);
  context.subscriptions.push(branchesView.onDidChangeVisibility((e) => {
    if (e && e.visible) prefetchBranches(false);
  }));

  log('activateGitManage: done');
}

function activate(context) {
  const sandboxOn = isSandboxWorkspace();
  const gitManageOn = refreshGitManageFromWorkspace();
  let pairedOn = false;
  try {
    resolvePair();
    pairedOn = true;
  } catch (_) {
    pairedOn = false;
  }
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.sandbox', sandboxOn);
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.gitManage', gitManageOn);
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.paired', pairedOn);
  void vscode.commands.executeCommand('setContext', 'zkzSandbox.syncing', false);
  log('gitManage=' + gitManageOn + ' sandbox=' + sandboxOn + ' paired=' + pairedOn);
  try {
    const p0 = resolvePair();
    log('pair w1=' + p0.w1);
    log('pair sandbox=' + p0.sandbox);
  } catch (_) { /* ignore */ }

  // W1 edit FS: used when opening W1 files from diff; keep registered
  registerW1EditFs(context);
  context.subscriptions.push(output);
  syncUiContext();

  try {
    const pair0 = resolvePair();
    void clearIgnoredW1Repositories();
    void ignoreW1InBuiltinGit(pair0.w1);
  } catch (_) { /* ignore */ }

  const providerHolder = {
    provider: {
      pair: null,
      refresh() { /* no-op until Git manage loaded */ }
    }
  };

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    const sb = isSandboxWorkspace();
    const gitOn = refreshGitManageFromWorkspace();
    let paired = false;
    try { resolvePair(); paired = true; } catch (_) { paired = false; }
    void vscode.commands.executeCommand('setContext', 'zkzSandbox.sandbox', sb);
    void vscode.commands.executeCommand('setContext', 'zkzSandbox.gitManage', gitOn);
    void vscode.commands.executeCommand('setContext', 'zkzSandbox.paired', paired);
    if (paired) {
      if (!gGitManageActivated) {
        activateGitManage(context, providerHolder);
      } else {
        providerHolder.provider.refresh();
      }
    }
  }));

  // unpaired: hide sidebar. paired: mount views (tip on W1; full Git on sandbox)
  if (!pairedOn) {
    void vscode.commands.executeCommand('setContext', 'zkzSandbox.gitManage', false);
    void vscode.commands.executeCommand('setContext', 'zkzSandbox.paired', false);
    registerLightCommands(context);
    log('light mode: unpaired, hide zkz activity bar');
    return;
  }

  // paired: mount sidebar; Git ops gated by zkzSandbox.gitManage / assertGitManage
  try {
    activateGitManage(context, providerHolder);
  } catch (e) {
    log('activateGitManage fail: ' + (e && e.message ? e.message : e));
    vscode.window.showErrorMessage('zkz Sandbox \u52a0\u8f7d\u5931\u8d25: ' + (e && e.message ? e.message : e));
  }
}

function deactivate() { }

module.exports = { activate, deactivate };
