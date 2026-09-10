'use strict';
const vscode = require('vscode');
const { showInfoAuto } = require('./toast');
const { uiState, withProgress } = require('./shared');
const { resolvePair, assertW1Git } = require('./pair');
const {
  runGit,
  askPullSandbox,
  checkoutW1Ref,
  checkoutAndResetSandbox,
  checkoutResetThenW1,
  checkoutPrevCommitSandboxDance
} = require('./git');
const { pickBranchFromList } = require('./branch_cache');
const { invokeOptional } = require('./optional');

async function pickStashRef(w1, placeHolder) {
  const out = await runGit(w1, ['stash', 'list', '--format=%gd%x09%s']);
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    void showInfoAuto('没有储存记录');
    return null;
  }
  const items = lines.map((line) => {
    const parts = line.split('\t');
    const ref = parts[0] || '';
    const msg = parts.slice(1).join('\t') || '';
    return { label: ref, description: msg, ref };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeHolder || '选择储存'
  });
  return picked ? picked.ref : null;
}

async function filterBranches(arg, provider) {
  const value = await vscode.window.showInputBox({
    prompt: '筛选分支（本地 + 远程）',
    value: uiState.branchFilter,
    placeHolder: '输入关键字，留空清除筛选'
  });
  if (value === undefined) return;
  uiState.branchFilter = value.trim();
  provider.refresh();
}

async function pickBranch(arg, provider) {
  const pair = provider.pair || resolvePair();
  assertW1Git(pair.w1);
  const picked = await pickBranchFromList(pair.w1, {
    placeHolder: '输入以筛选分支（本地 + 远程，按时间排序）'
  });
  if (!picked) return;
  await checkoutItem(
    { label: picked.label, data: { ref: picked.ref, isRemote: picked.isRemote } },
    provider
  );
}

async function checkoutItem(item, provider) {
  const pair = provider.pair || resolvePair();
  assertW1Git(pair.w1);
  if (!item || !item.data || !item.data.ref) throw new Error('\u8bf7\u9009\u62e9\u4e00\u4e2a\u5206\u652f');
  const ref = item.data.ref;
  const label = item.label;
  const isRemote = !!item.data.isRemote;
  const mode = await vscode.window.showQuickPick(
    [
      {
        label: '\u6c99\u7bb1 reset \u2192 \u5207\u771f\u6e90 \u2192 ToUtf',
        description: '\u6c99\u7bb1 reset utf\u5960\u57fa \u2192 \u5207\u771f\u6e90 \u2192 ToUtf',
        id: 'reset-toutf'
      },
      {
        label: 'reset \u2192 \u5207\u771f\u6e90',
        description: '\u6c99\u7bb1 reset utf\u5960\u57fa \u2192 \u5207\u771f\u6e90\uff08\u4e0d ToUtf\uff09',
        id: 'reset-w1'
      },
      {
        label: '\u7b7e\u51fa \u2192 \u771f\u6e90 HEAD~1 \u2192 \u5960\u57fa ToUtf \u2192 \u6c99\u7bb1\u63d0\u4ea4 1 \u2192 \u771f\u6e90\u56de\u5c16 \u2192 \u64a4\u9500\u4e0a\u4e00\u6b21\u4fee\u6539 \u2192 ToUtf',
        description: '\u56de\u5c16\u540e mixed \u64a4\u9500\u5c16\u63d0\u4ea4\uff08\u6539\u52a8\u7559\u5de5\u4f5c\u533a\u3001\u4e0d\u6682\u5b58\uff09\u518d ToUtf',
        id: 'prev-commit-dance'
      },
      {
        label: '\u4ec5\u7b7e\u51fa\u672c\u6e90',
        description: '\u4e0d\u81ea\u52a8\u91cd\u7f6e\u6c99\u7bb1\uff08\u65e7\u884c\u4e3a\uff09',
        id: 'w1-only'
      }
    ],
    { placeHolder: '\u7b7e\u51fa\u672c\u6e90: ' + label }
  );
  if (!mode) return;

  if (mode.id === 'reset-toutf') {
    await checkoutAndResetSandbox(pair, provider, { ref, label, isRemote });
    return;
  }
  if (mode.id === 'reset-w1') {
    await checkoutResetThenW1(pair, provider, { ref, label, isRemote });
    return;
  }
  if (mode.id === 'prev-commit-dance') {
    await checkoutPrevCommitSandboxDance(pair, provider, { ref, label, isRemote });
    return;
  }

  // \u4ec5\u7b7e\u51fa\u672c\u6e90\uff08\u65e7\u884c\u4e3a + \u8be2\u95ee\u662f\u5426\u62c9\u6c99\u7bb1\uff09
  // 先冻结基线：本源签出后 vscode.git@W1 / refreshStatus 可能抢先静默对齐
  await invokeOptional('zkz-sandbox.beginYtMacroCheckoutGuard');
  try {
    await withProgress('\u7b7e\u51fa: ' + label, async () => {
      await checkoutW1Ref(pair, ref, label, isRemote);
    });
  } catch (e) {
    void invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
    throw e;
  }
  if (provider) provider.refresh();
  // 宏基线对齐（内含 end guard / refreshStatus）
  // 注意：沙箱未 ToUtf 时 yt_version 可能仍旧；真正有 diff 多在 askPullSandbox 之后
  await invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
  const headNow = (await runGit(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  void showInfoAuto(
    headNow === 'HEAD'
      ? ('\u672c\u6e90\u5df2\u7b7e\u51fa\u63d0\u4ea4: ' + (await runGit(pair.w1, ['rev-parse', '--short', 'HEAD'])).trim())
      : ('\u672c\u6e90\u5df2\u7b7e\u51fa: ' + headNow)
  );
  await askPullSandbox(pair, provider);
}

async function checkoutTo(provider) {
  const pair = resolvePair();
  assertW1Git(pair.w1);
  const picked = await pickBranchFromList(pair.w1, {
    withRemoteHint: true,
    placeHolder: '签出到...（本地 + 远程，按时间排序）',
    extraItems: [{ label: '$(edit) 输入分支 / 提交...', description: '手动', manual: true }]
  });
  if (!picked) return;
  let ref = picked.ref;
  let label = picked.label;
  let isRemote = picked.isRemote;
  if (picked.manual) {
    ref = await vscode.window.showInputBox({ prompt: '分支名或提交哈希' });
    if (!ref) return;
    label = ref;
    isRemote = false;
  }
  await checkoutItem(
    { label, data: { ref, isRemote } },
    provider
  );
}

module.exports = {
  pickStashRef,
  filterBranches,
  pickBranch,
  checkoutItem,
  checkoutTo
};
