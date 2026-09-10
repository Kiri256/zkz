'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { showInfoAuto } = require('./toast');
const {
  uiState,
  syncUiContext,
  log,
  withProgress,
  output
} = require('./shared');
const { resolvePair } = require('./pair');
const {
  runGit,
  syncDaily,
  syncToUtf8Forced,
  assertCheckoutComplete,
  publishBranch,
  forcePush,
  askPullSandbox,
  pullW1Safe,
  fetchW1Safe,
  fetchW1All
} = require('./git');
const { invalidateBranchCache } = require('./branch_cache');
const { openW1BrowseFile } = require('./blame');
const { openW1WorktreeFile, resolveW1OpenUri } = require('./w1_fs');
const { diffSandboxW1 } = require('./pair_diff');
const { showPairDiffBatch } = require('./pair_diff_batch');
const { assertNotSyncing, withSyncLock } = require('./sync_gate');
const { confirmBeforeW1Commit } = require('./sync_hint');
const { promptCommitMessage, finishCommitMessage } = require('./commit_ui');
const {
  gitRevUri,
  showCommit,
  openCommitFile,
  filterW1Files,
  pickW1File
} = require('./history_diff');
const {
  pickStashRef,
  filterBranches,
  pickBranch,
  checkoutItem,
  checkoutTo
} = require('./branch_ops');
const {
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
} = require('./w1_ops');

const { invokeOptional } = require('./optional');

function registerCommands(context, { provider, wrap, wrapGit, w1 }) {
  const entries = [
    // 更改视图：只刷 git status，不 fetch 远端
    ['zkz-sandbox.refreshChanges', wrap, async () => {
      await w1();
      if (typeof provider.refreshChanges === 'function') provider.refreshChanges();
      else provider.refresh();
    }],
    // 本源文件视图：只重扫文件夹内容
    ['zkz-sandbox.refreshFiles', wrap, async () => {
      await w1();
      if (typeof provider.refreshFiles === 'function') provider.refreshFiles();
      else {
        provider._w1FilesCache = null;
        provider.refresh();
      }
    }],
    // 分支视图：抓取远程并重载（原 refresh 逻辑）
    ['zkz-sandbox.refresh', wrap, async () => {
      const pair = await w1();
      // 先清缓存并立刻重绘本地列表，避免「点了刷新没变化」
      invalidateBranchCache(pair.w1);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
      // 再抓取远程（更新 refs/remotes），完成后二次刷新分支内容
      await withProgress('\u5237\u65b0\u5206\u652f\uff08\u6293\u53d6\u8fdc\u7a0b\uff09...', async () => {
        try {
          await fetchW1All(pair.w1);
        } catch (e) {
          log('refresh fetch: ' + (e && e.message ? e.message : e));
          try {
            await fetchW1Safe(pair.w1, false);
          } catch (e2) {
            log('refresh fetch fallback: ' + (e2 && e2.message ? e2.message : e2));
          }
        }
        invalidateBranchCache(pair.w1);
      });
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
    }],
    ['zkz-sandbox.showOutput', wrap, () => output.show(true)],
    ['zkz-sandbox.viewAsList', wrap, () => { uiState.viewMode = 'list'; syncUiContext(); provider.refresh(); }],
    ['zkz-sandbox.viewAsTree', wrap, () => { uiState.viewMode = 'tree'; syncUiContext(); provider.refresh(); }],
    ['zkz-sandbox.pull', wrapGit, async () => {
      const pair = await w1();
      await withProgress('git pull（当前分支）', async () => {
        await pullW1Safe(pair.w1, false);
        await assertCheckoutComplete(pair.w1, {});
      });
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
      await askPullSandbox(pair, provider);
    }],
    ['zkz-sandbox.push', wrapGit, async () => {
      // 远程无此分支则推送，否则首次发布（push -u）；逻辑见 publishBranch
      const pair = await w1();
      await publishBranch(pair, null);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
    }],
    ['zkz-sandbox.forcePush', wrapGit, async () => {
      const pair = await w1();
      await forcePush(pair);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
    }],
    ['zkz-sandbox.publishBranch', wrapGit, async (item) => {
      const pair = await w1();
      let name = null;
      if (item && item.kind === 'branch-local') {
        name = (item.data && (item.data.ref || item.data.name)) || item.label;
      }
      await publishBranch(pair, name);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
    }],
    ['zkz-sandbox.fetch', wrapGit, async () => {
      const pair = await w1();
      await withProgress('git fetch（当前分支）', async () => {
        const r = await fetchW1Safe(pair.w1, false);
        if (r && r.mode === 'current') {
          void showInfoAuto('已抓取当前分支: ' + r.remote + '/' + r.upstreamBranch);
        }
      });
      invalidateBranchCache(pair.w1);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
    }],
    ['zkz-sandbox.fetchAll', wrapGit, async () => {
      const pair = await w1();
      await withProgress('git fetch --all（本源）', async () => {
        await fetchW1All(pair.w1);
      });
      invalidateBranchCache(pair.w1);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
    }],
    ['zkz-sandbox.checkoutTo', wrapGit, async () => checkoutTo(provider)],
    ['zkz-sandbox.checkout', wrapGit, async (item) => checkoutItem(item, provider)],
    ['zkz-sandbox.filterBranches', wrapGit, async (arg) => filterBranches(arg, provider)],
    ['zkz-sandbox.pickBranch', wrapGit, async (arg) => pickBranch(arg, provider)],
    ['zkz-sandbox.showCommit', wrapGit, async (item) => showCommit(item, provider)],
    ['zkz-sandbox.openCommitFile', wrapGit, async (item) => openCommitFile(item, provider)],
    ['zkz-sandbox.commitMessageAccept', wrap, async () => {
      await finishCommitMessage(true);
    }],
    ['zkz-sandbox.commitMessageCancel', wrap, async () => {
      await finishCommitMessage(false);
    }],
    ['zkz-sandbox.commit', wrapGit, async () => {
      const pair = await w1();
      // 提交前：沙箱未保存 / 可能未 ToGb 时提醒（避免只提交了旧本源）
      if (!(await confirmBeforeW1Commit(pair))) return;
      // \u65e0\u6682\u5b58 UI\uff1a\u6709\u6682\u5b58\u5219\u63d0\u4ea4\u6682\u5b58\uff1b\u5426\u5219\u81ea\u52a8 add -A \u540e\u63d0\u4ea4\u5168\u90e8\u5de5\u4f5c\u533a\u66f4\u6539
      let stagedOut = '';
      try {
        stagedOut = (await runGit(pair.w1, ['diff', '--cached', '--name-only'])).trim();
      } catch (_) { stagedOut = ''; }
      if (!stagedOut) {
        const dirty = (await runGit(pair.w1, ['status', '--porcelain'])).trim();
        if (!dirty) {
          void showInfoAuto('\u6ca1\u6709\u53ef\u63d0\u4ea4\u7684\u66f4\u6539');
          return;
        }
        await runGit(pair.w1, ['add', '-A']);
      }
      const msg = await promptCommitMessage();
      if (!msg) return;
      const tmpMsg = path.join(os.tmpdir(), 'zkz-sandbox-commit-msg.txt');
      fs.writeFileSync(tmpMsg, msg, 'utf8');
      await withProgress('git commit\uff08\u672c\u6e90\uff09', async () => {
        await runGit(pair.w1, ['commit', '-F', tmpMsg]);
      });
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
      void showInfoAuto('\u5df2\u63d0\u4ea4\uff08\u672c\u6e90\uff09');
    }],
    ['zkz-sandbox.undoLastCommit', wrapGit, async () => {
      const pair = await w1();
      try {
        await runGit(pair.w1, ['rev-parse', '--verify', 'HEAD~1']);
      } catch (_) {
        void showInfoAuto('没有可撤销的提交（已是根提交或空仓库）');
        return;
      }
      const subject = (await runGit(pair.w1, ['log', '-1', '--format=%s'])).trim();
      const short = (await runGit(pair.w1, ['rev-parse', '--short', 'HEAD'])).trim();
      let pushedHint = '';
      try {
        await runGit(pair.w1, ['rev-parse', '--abbrev-ref', '@{u}']);
        const ahead = (await runGit(pair.w1, ['rev-list', '--count', '@{u}..HEAD'])).trim();
        if (ahead === '0') {
          pushedHint = '\n注意：当前 HEAD 与远程一致，该提交可能已推送；撤销后远程需强制推送才能对齐。';
        }
      } catch (_) {
        // 无上游，忽略
      }
      const ok = await vscode.window.showWarningMessage(
        '撤销上一次提交 ' + short + '「' + subject + '」？\n改动将保留在工作区（不进暂存区）。' + pushedHint,
        { modal: true },
        '撤销'
      );
      if (ok !== '撤销') return;
      await withProgress('撤销上一次提交（本源）', async () => {
        await runGit(pair.w1, ['reset', '--mixed', 'HEAD~1']);
      });
      provider.refresh();
      void showInfoAuto('已撤销提交，改动在工作区（未暂存）');
    }],
    ['zkz-sandbox.openChange', wrapGit, async (item) => {
      // \u66f4\u6539\u5217\u8868\u70b9\u51fb\uff1a\u9ed8\u8ba4\u8fdb\u5165 git \u6bd4\u5bf9\uff08\u5de6 HEAD/\u6682\u5b58\uff0c\u53f3\u5de5\u4f5c\u533a\uff09
      await vscode.commands.executeCommand('zkz-sandbox.openChangeDiff', item);
    }],
    ['zkz-sandbox.openChangeFile', wrapGit, async (item) => {
      const pair = provider.pair || resolvePair();
      if (!item || !item.data || !item.data.file) return;
      const filePosix = String(item.data.file).replace(/\\/g, '/');
      const abs = path.join(pair.w1, ...filePosix.split('/').filter(Boolean));
      if (!fs.existsSync(abs)) {
        void showInfoAuto('\u6587\u4ef6\u4e0d\u5b58\u5728\uff08\u53ef\u80fd\u5df2\u5220\u9664\uff09: ' + filePosix);
        return;
      }
      await openW1WorktreeFile(pair.w1, filePosix);
    }],
    ['zkz-sandbox.openChangeDiff', wrapGit, async (item) => {
      const pair = provider.pair || resolvePair();
      if (!item || !item.data) return;
      const file = item.data.file;
      const xy = item.data.xy || '  ';
      const filePosix = String(file).replace(/\\/g, '/');
      const base = path.posix.basename(filePosix);
      const staged = item.kind === 'change-staged' || (xy[0] !== ' ' && xy[0] !== '?');
      const abs = path.join(pair.w1, ...filePosix.split('/').filter(Boolean));

      // 与 openW1WorktreeFile 同一编码打开路径
      async function preloadW1FileUri() {
        if (!fs.existsSync(abs)) return gitRevUri(pair.w1, '__worktree__', filePosix);
        try {
          return await resolveW1OpenUri(pair.w1, filePosix);
        } catch (_) {
          return gitRevUri(pair.w1, '__worktree__', filePosix);
        }
      }

      let left;
      let right;
      let title;
      if (xy[0] === '?' || xy[1] === '?') {
        left = gitRevUri(pair.w1, '__empty__', filePosix);
        right = await preloadW1FileUri();
        title = base + ' (\u672a\u8ddf\u8e2a)';
      } else if (xy[0] === 'D' || xy[1] === 'D') {
        left = gitRevUri(pair.w1, 'HEAD', filePosix);
        right = gitRevUri(pair.w1, '__empty__', filePosix);
        title = base + ' (\u5df2\u5220\u9664)';
      } else if (staged && xy[1] === ' ') {
        left = gitRevUri(pair.w1, 'HEAD', filePosix);
        right = gitRevUri(pair.w1, ':0', filePosix);
        title = base + ' (\u6682\u5b58\u533a)';
      } else {
        left = gitRevUri(pair.w1, 'HEAD', filePosix);
        right = await preloadW1FileUri();
        title = base + ' (\u5de5\u4f5c\u533a)';
      }
      await vscode.commands.executeCommand('vscode.diff', left, right, title);
    }],
    ['zkz-sandbox.stageFile', wrapGit, async (item) => {
      const pair = provider.pair || resolvePair();
      if (!item || !item.data || !item.data.file) return;
      await runGit(pair.w1, ['add', '--', item.data.file]);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
      void showInfoAuto('\u5df2\u6682\u5b58: ' + item.data.file);
    }],
    ['zkz-sandbox.unstageFile', wrapGit, async (item) => {
      const pair = provider.pair || resolvePair();
      if (!item || !item.data || !item.data.file) return;
      await runGit(pair.w1, ['restore', '--staged', '--', item.data.file]);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
      void showInfoAuto('\u5df2\u53d6\u6d88\u6682\u5b58: ' + item.data.file);
    }],
    ['zkz-sandbox.stageAll', wrapGit, async () => {
      const pair = provider.pair || resolvePair();
      const changes = await provider._loadChanges();
      const unstaged = changes.filter((ch) => ch.xy[0] === '?' || ch.xy[1] !== ' ');
      if (!unstaged.length) {
        void showInfoAuto('\u6ca1\u6709\u53ef\u6682\u5b58\u7684\u66f4\u6539');
        return;
      }
      await runGit(pair.w1, ['add', '-A']);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
      void showInfoAuto('\u5df2\u6682\u5b58\u5168\u90e8\u66f4\u6539 (' + unstaged.length + ')');
    }],
    ['zkz-sandbox.unstageAll', wrapGit, async () => {
      const pair = provider.pair || resolvePair();
      const changes = await provider._loadChanges();
      const staged = changes.filter((ch) => ch.xy[0] !== ' ' && ch.xy[0] !== '?');
      if (!staged.length) {
        void showInfoAuto('\u6ca1\u6709\u5df2\u6682\u5b58\u7684\u66f4\u6539');
        return;
      }
      await runGit(pair.w1, ['restore', '--staged', '.']);
      provider.refresh();
      void invokeOptional('zkz-sandbox.refreshStatus');
      void showInfoAuto('\u5df2\u53d6\u6d88\u5168\u90e8\u6682\u5b58 (' + staged.length + ')');
    }],
    ['zkz-sandbox.discardFile', wrapGit, async (item) => {
      const pair = provider.pair || resolvePair();
      const ok = await vscode.window.showWarningMessage('放弃更改 ' + item.data.file + '？', { modal: true }, '放弃');
      if (ok !== '放弃') return;
      await runGit(pair.w1, ['checkout', '--', item.data.file]);
      provider.refresh();
    }],
    ['zkz-sandbox.discardAllChanges', wrapGit, async () => {
      const pair = provider.pair || resolvePair();
      const changes = await provider._loadChanges();
      if (!changes.length) {
        void showInfoAuto('没有可撤销的更改');
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        '放弃全部 ' + changes.length + ' 个文件的工作区更改？此操作不可恢复。',
        { modal: true },
        '放弃'
      );
      if (ok !== '放弃') return;
      const tracked = changes.filter((ch) => ch.xy[0] !== '?' && ch.xy[1] !== '?');
      const untracked = changes.filter((ch) => ch.xy[0] === '?' || ch.xy[1] === '?');
      if (tracked.length) {
        const files = tracked.map((ch) => ch.file);
        await runGit(pair.w1, ['restore', '--staged', '--worktree', '--', ...files]);
      }
      for (const ch of untracked) {
        await runGit(pair.w1, ['clean', '-fd', '--', ch.file]);
      }
      provider.refresh();
    }],
    ['zkz-sandbox.stash', wrapGit, async () => {
      const pair = await w1();
      const msg = await vscode.window.showInputBox({ prompt: '储存说明（可选）' });
      if (msg === undefined) return;
      if (msg) await runGit(pair.w1, ['stash', 'push', '-m', msg]);
      else await runGit(pair.w1, ['stash', 'push']);
      provider.refresh();
      void showInfoAuto('已储存工作区更改');
    }],
    ['zkz-sandbox.stashPop', wrapGit, async () => {
      const pair = await w1();
      await runGit(pair.w1, ['stash', 'pop']);
      provider.refresh();
      void showInfoAuto('已应用并删除最新储存');
    }],
    ['zkz-sandbox.stashApply', wrapGit, async (item) => {
      const pair = await w1();
      let ref = item && item.data && item.data.ref ? item.data.ref : null;
      if (!ref) {
        ref = await pickStashRef(pair.w1, '选择要应用的储存');
        if (!ref) return;
      }
      await runGit(pair.w1, ['stash', 'apply', ref]);
      provider.refresh();
      void showInfoAuto('已应用储存: ' + ref);
    }],
    ['zkz-sandbox.stashDrop', wrapGit, async (item) => {
      const pair = await w1();
      let ref = item && item.data && item.data.ref ? item.data.ref : null;
      if (!ref) {
        ref = await pickStashRef(pair.w1, '选择要删除的储存');
        if (!ref) return;
      }
      const ok = await vscode.window.showWarningMessage('删除储存 ' + ref + '？', { modal: true }, '删除');
      if (ok !== '删除') return;
      await runGit(pair.w1, ['stash', 'drop', ref]);
      provider.refresh();
      void showInfoAuto('已删除储存: ' + ref);
    }],
    ['zkz-sandbox.branchCreate', wrapGit, async () => {
      const pair = await w1();
      const name = await vscode.window.showInputBox({ prompt: '新分支名称' });
      if (!name) return;
      await withProgress('创建并签出: ' + name, async () => {
        await runGit(pair.w1, ['checkout', '-b', name]);
        await assertCheckoutComplete(pair.w1, { branch: name });
      });
      invalidateBranchCache(pair.w1);
      provider.refresh();
      void showInfoAuto('本源已签出: ' + name);
      await askPullSandbox(pair, provider);
    }],
    ['zkz-sandbox.branchDelete', wrapGit, async (item) => {
      const pair = await w1();
      let name = item && item.kind === 'branch-local' ? (item.data && item.data.ref ? item.data.ref : item.label) : null;
      if (!name) {
        const local = (await runGit(pair.w1, ['branch', '--format=%(refname:short)'])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const picked = await vscode.window.showQuickPick(local, { placeHolder: '删除分支' });
        if (!picked) return;
        name = picked;
      }
      const ok = await vscode.window.showWarningMessage('删除分支 ' + name + '？', { modal: true }, '删除');
      if (ok !== '删除') return;
      await runGit(pair.w1, ['branch', '-D', name]);
      invalidateBranchCache(pair.w1);
      provider.refresh();
    }],
    ['zkz-sandbox.branchRename', wrapGit, async () => {
      const pair = await w1();
      const cur = (await runGit(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const name = await vscode.window.showInputBox({ prompt: '重命名当前分支', value: cur });
      if (!name || name === cur) return;
      await runGit(pair.w1, ['branch', '-m', name]);
      invalidateBranchCache(pair.w1);
      provider.refresh();
    }],
    ['zkz-sandbox.openW1BrowseFile', wrapGit, async (item) => {
      await openW1BrowseFile(item, provider);
    }],
    ['zkz-sandbox.filterW1Files', wrapGit, async (arg) => filterW1Files(arg, provider)],
    // pickW1File 保留为 browseW1File 别名（兼容旧键位/树节点）
    ['zkz-sandbox.pickW1File', wrapGit, async () => {
      await pickW1File(provider, false);
    }],
    ['zkz-sandbox.browseW1File', wrapGit, async () => {
      await pickW1File(provider, false);
    }],
    ['zkz-sandbox.showFileHistory', wrapGit, async () => {
      await pickW1File(provider, true);
    }],
    ['zkz-sandbox.diffSandboxW1', wrap, async (arg) => {
      await diffSandboxW1(arg);
    }],
    ['zkz-sandbox.diffSandboxW1Batch', wrap, async () => {
      await showPairDiffBatch();
    }],
    ['zkz-sandbox.w1RevealInOS', wrapGit, async (item) => w1RevealInOS(item, provider)],
    ['zkz-sandbox.w1OpenTerminal', wrapGit, async (item) => w1OpenTerminal(item, provider)],
    ['zkz-sandbox.w1FindInFolder', wrapGit, async (item) => w1FindInFolder(item, provider)],
    ['zkz-sandbox.w1CopyPath', wrapGit, async (item) => w1CopyPath(item, provider)],
    ['zkz-sandbox.w1CopyRelativePath', wrapGit, async (item) => w1CopyRelativePath(item, provider)],
    ['zkz-sandbox.w1Copy', wrapGit, async (item) => w1Copy(item, provider)],
    ['zkz-sandbox.w1Cut', wrapGit, async (item) => w1Cut(item, provider)],
    ['zkz-sandbox.w1Paste', wrapGit, async (item) => w1Paste(item, provider)],
    ['zkz-sandbox.w1Rename', wrapGit, async (item) => w1Rename(item, provider)],
    ['zkz-sandbox.w1Delete', wrapGit, async (item) => w1Delete(item, provider)],
    ['zkz-sandbox.w1NewFile', wrapGit, async (item) => w1NewFile(item, provider)],
    ['zkz-sandbox.w1NewFolder', wrapGit, async (item) => w1NewFolder(item, provider)],
    ['zkz-sandbox.w1AddToChat', wrapGit, async (item) => w1AddToChat(item, provider, false)],
    ['zkz-sandbox.w1AddToNewChat', wrapGit, async (item) => w1AddToChat(item, provider, true)],
    ['zkz-sandbox.w1ShowFileHistory', wrapGit, async (item) => w1ShowFileHistory(item, provider)],
    ['zkz-sandbox.openW1Explorer', wrap, async () => {
      const pair = await w1();
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pair.w1));
    }],
    ['zkz-sandbox.openW1Terminal', wrap, async () => {
      const pair = await w1();
      const name = '\u771f\u6e90 ' + path.basename(pair.w1);
      let term = vscode.window.terminals.find((t) => t.name === name);
      if (!term) {
        term = vscode.window.createTerminal({ name: name, cwd: pair.w1 });
      }
      term.show(true);
      log('terminal cwd -> ' + pair.w1);
    }],
    ['zkz-sandbox.checkoutBranch', wrapGit, async () => {
      await vscode.commands.executeCommand('workbench.view.extension.zkz-sandbox');
    }],
  ];

  for (const [id, wrapper, fn] of entries) {
    context.subscriptions.push(vscode.commands.registerCommand(id, wrapper(fn)));
  }
}

module.exports = {
  registerCommands,
  initialize: (context) => require('./host').activate(context)
};
