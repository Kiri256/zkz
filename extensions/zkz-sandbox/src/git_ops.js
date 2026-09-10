'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { log, showInfoAuto } = require('./shared');
const { invokeOptional } = require('./optional');

/** lazy：避免与 git.js 循环依赖在加载期炸掉 */
function core() { return require('./git'); }

async function publishBranch(pair, branchName) {
  let name = (branchName || '').trim();
  if (!name) {
    name = (await core().runGit(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }
  if (!name || name === 'HEAD') {
    throw new Error('\u5f53\u524d\u5904\u4e8e detached HEAD\uff0c\u8bf7\u5148\u7b7e\u51fa\u5230\u672c\u5730\u5206\u652f');
  }
  // 已配置 upstream：普通推送
  let hasUpstream = false;
  try {
    await core().runGit(pair.w1, ['rev-parse', '--abbrev-ref', name + '@{u}']);
    hasUpstream = true;
  } catch (_) {
    hasUpstream = false;
  }
  if (hasUpstream) {
    await core().withProgress('git push\uff08\u672c\u6e90\uff09', async () => {
      await core().runGit(pair.w1, ['push']);
    });
    void showInfoAuto('\u63a8\u9001\u5b8c\u6210');
    return;
  }
  const remotes = (await core().runGit(pair.w1, ['remote']))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!remotes.length) {
    throw new Error('\u6ca1\u6709\u914d\u7f6e\u8fdc\u7a0b\uff08git remote\uff09');
  }
  // 远程已有同名分支则推送并设 upstream；否则首次发布
  let remoteWithBranch = null;
  for (const r of remotes) {
    try {
      await core().runGit(pair.w1, ['rev-parse', '--verify', 'refs/remotes/' + r + '/' + name]);
      remoteWithBranch = r;
      break;
    } catch (_) { /* next */ }
  }
  let remote = remoteWithBranch;
  if (!remote) {
    remote = remotes[0];
    if (remotes.length > 1) {
      const picked = await vscode.window.showQuickPick(
        remotes.map((r) => ({
          label: r,
          description: r === 'origin' ? '\u9ed8\u8ba4' : '',
        })),
        { placeHolder: '\u9009\u62e9\u8981\u53d1\u5e03\u5230\u7684\u8fdc\u7a0b' }
      );
      if (!picked) return;
      remote = picked.label;
    }
  }
  const firstPublish = !remoteWithBranch;
  await core().withProgress(
    (firstPublish ? 'git push -u ' : 'git push -u ') + remote + ' ' + name + '\uff08\u672c\u6e90\uff09',
    async () => {
      await core().runGit(pair.w1, ['push', '-u', remote, name]);
    }
  );
  void showInfoAuto(firstPublish
    ? ('\u5df2\u53d1\u5e03: ' + remote + '/' + name)
    : '\u63a8\u9001\u5b8c\u6210');
}

async function forcePush(pair) {
  const branch = (await core().runGit(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') {
    throw new Error('\u5f53\u524d\u5904\u4e8e detached HEAD\uff0c\u8bf7\u5148\u7b7e\u51fa\u5230\u672c\u5730\u5206\u652f');
  }
  let upstream = '';
  try {
    upstream = (await core().runGit(pair.w1, ['rev-parse', '--abbrev-ref', '@{u}'])).trim();
  } catch (_) {
    upstream = '';
  }
  const tip = upstream
    ? ('\u8fdc\u7a0b: ' + upstream)
    : '\u5f53\u524d\u5206\u652f\u5c1a\u65e0 upstream\uff0c\u5c06\u5c1d\u8bd5\u5f3a\u5236\u63a8\u9001\u9ed8\u8ba4\u8fdc\u7a0b';
  const ok = await vscode.window.showWarningMessage(
    '\u5f3a\u5236\u4e0a\u4f20\u5c06\u7528\u672c\u6e90\u5f53\u524d\u5206\u652f\u8986\u76d6\u8fdc\u7a0b\uff08git push --force-with-lease\uff09\u3002\n' +
    '\u5206\u652f: ' + branch + '\n' + tip + '\n\u786e\u5b9a\u7ee7\u7eed\uff1f',
    { modal: true },
    '\u5f3a\u5236\u4e0a\u4f20'
  );
  if (ok !== '\u5f3a\u5236\u4e0a\u4f20') return;
  await core().withProgress('git push --force-with-lease\uff08\u672c\u6e90\uff09', async () => {
    await core().runGit(pair.w1, ['push', '--force-with-lease']);
  });
  void showInfoAuto('\u5f3a\u5236\u4e0a\u4f20\u5b8c\u6210');
}


const SANDBOX_BRANCH = 'maUtf';
const SANDBOX_FOUNDATION_REF = 'origin/maUtf';

function sandboxHasGit(sandbox) {
  return !!(sandbox && fs.existsSync(path.join(sandbox, '.git')));
}

/**
 * Reset sandbox to utf\u5960\u57fa: ensure maUtf then reset --hard origin/maUtf.
 * No fetch / no pin commit — local origin/maUtf ref is enough.
 */
async function resetSandboxToFoundation(sandbox) {
  if (!sandboxHasGit(sandbox)) {
    log('sandbox has no .git, skip reset to foundation');
    return { ok: false, reason: 'no-git' };
  }
  try {
    await core().runGit(sandbox, ['rev-parse', '--verify', SANDBOX_FOUNDATION_REF]);
  } catch (_) {
    throw new Error(
      '\u6c99\u7bb1\u7f3a\u5c11 ' + SANDBOX_FOUNDATION_REF +
      '（utf\u5960\u57fa）\uff0c\u8bf7\u5148 fetch \u6216\u68c0\u67e5\u8fdc\u7a0b'
    );
  }
  // Ensure on maUtf, then hard reset (drop dirty worktree / local commits after foundation)
  let onBranch = '';
  try {
    onBranch = (await core().runGit(sandbox, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch (_) {
    onBranch = '';
  }
  if (onBranch !== SANDBOX_BRANCH) {

    try {
      await core().runGit(sandbox, ['checkout', SANDBOX_BRANCH]);
    } catch (_) {
      await core().runGit(sandbox, ['checkout', '-B', SANDBOX_BRANCH, SANDBOX_FOUNDATION_REF]);
    }
  }
  await core().runGit(sandbox, ['reset', '--hard', SANDBOX_FOUNDATION_REF]);
  const head = (await core().runGit(sandbox, ['rev-parse', '--short', 'HEAD'])).trim();
  const subj = (await core().runGit(sandbox, ['log', '-1', '--format=%s'])).trim();
  log('sandbox reset --hard ' + SANDBOX_FOUNDATION_REF + ' @ ' + head + ' 「' + subj + '」');
  return { ok: true, head, subject: subj };
}

async function checkoutW1Ref(pair, ref, label, isRemote) {
  const expectBranch = isRemote
    ? (ref.includes('/') ? ref.replace(/^[^/]+\//, '') : label)
    : ref;
  if (isRemote) {
    await core().runGit(pair.w1, ['checkout', '-B', expectBranch, ref]);
    await core().assertCheckoutComplete(pair.w1, { branch: expectBranch });
    core().invalidateBranchCacheLocal(pair.w1);
    return { branch: expectBranch };
  }
  await core().runGit(pair.w1, ['checkout', ref]);
  const headName = (await core().runGit(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (headName === 'HEAD') {
    await core().assertCheckoutComplete(pair.w1, { commitish: ref });
    core().invalidateBranchCacheLocal(pair.w1);
    return { commitish: ref };
  }
  await core().assertCheckoutComplete(pair.w1, { branch: expectBranch });
  core().invalidateBranchCacheLocal(pair.w1);
  return { branch: expectBranch };
}

async function commitSandboxMessage(sandbox, message) {
  await core().runGit(sandbox, ['add', '-A']);
  try {
    await core().runGit(sandbox, ['commit', '-m', message]);
  } catch (e) {
    const msg = String((e && e.message) || e || '');
    if (/nothing to commit|no changes added|working tree clean/i.test(msg)) {
      await core().runGit(sandbox, ['commit', '--allow-empty', '-m', message]);
    } else {
      throw e;
    }
  }
  const head = (await core().runGit(sandbox, ['rev-parse', '--short', 'HEAD'])).trim();
  const subj = (await core().runGit(sandbox, ['log', '-1', '--format=%s'])).trim();
  log('sandbox commit @ ' + head + ' \u300c' + subj + '\u300d');
  return { head, subject: subj };
}

/**
 * Full switch: sandbox reset --hard utf\u5960\u57fa -> W1 checkout -> Force ToUtf.
 */
async function checkoutAndResetSandbox(pair, provider, opts) {
  const ref = opts.ref;
  const label = opts.label;
  const isRemote = !!opts.isRemote;

  if (!sandboxHasGit(pair.sandbox)) {
    const cont = await vscode.window.showWarningMessage(
      '\u6c99\u7bb1\u4e0d\u662f Git \u4ed3\u5e93\uff0c\u5c06\u4ec5\u7b7e\u51fa\u672c\u6e90\u5e76 ToUtf\uff08\u65e0\u6cd5 reset maUtf\uff09\u3002\n\u672c\u6e90: ' + label,
      { modal: true },
      '\u7ee7\u7eed'
    );
    if (cont !== '\u7ee7\u7eed') return;
  } else {
    const ok = await vscode.window.showWarningMessage(
      '\u6c99\u7bb1 reset \u2192 \u5207\u771f\u6e90 \u2192 ToUtf\uff1a\n' +
      '1) \u6c99\u7bb1 reset --hard \u2192 origin/maUtf\uff08utf\u5960\u57fa\uff09\n' +
      '2) \u672c\u6e90\u7b7e\u51fa: ' + label + '\n' +
      '3) Force ToUtf\uff08\u4e1a\u52a1\uff0c\u4e0d\u542b\u5e93\uff09',
      { modal: true },
      '\u786e\u8ba4\u7b7e\u51fa'
    );
    if (ok !== '\u786e\u8ba4\u7b7e\u51fa') return;
  }

  const { withSyncLock, assertNotSyncing } = require('./sync_gate');
  if (!assertNotSyncing()) return;
  // ToUtf 写 yt_version 前冻结宏基线，避免 disk/status 抢先对齐
  await invokeOptional('zkz-sandbox.beginYtMacroCheckoutGuard');
  try {
    await withSyncLock('checkout+ToUtf', async () => {
      await core().withProgress('\u6c99\u7bb1 reset \u2192 \u5207\u771f\u6e90 \u2192 ToUtf: ' + label, async () => {
        if (sandboxHasGit(pair.sandbox)) {
          await resetSandboxToFoundation(pair.sandbox);
        }
        await checkoutW1Ref(pair, ref, label, isRemote);
        await core().syncToUtf8Forced(pair.w1, []);
      });
    });
  } catch (e) {
    void invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
    throw e;
  }

  if (provider) provider.refresh();
  // ToUtf 后磁盘 yt_version 可能已变：对齐宏基线（内含 end guard）
  await invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
  const headNow = (await core().runGit(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  void showInfoAuto(
    (headNow === 'HEAD'
      ? ('\u672c\u6e90\u5df2\u7b7e\u51fa\u63d0\u4ea4: ' + (await core().runGit(pair.w1, ['rev-parse', '--short', 'HEAD'])).trim())
      : ('\u672c\u6e90\u5df2\u7b7e\u51fa: ' + headNow)) +
    '；\u6c99\u7bb1\u5df2 reset utf\u5960\u57fa\u5e76 ToUtf'
  );
}

/**
 * sandbox reset --hard utf\u5960\u57fa -> W1 checkout (no ToUtf).
 */
async function checkoutResetThenW1(pair, provider, opts) {
  const ref = opts.ref;
  const label = opts.label;
  const isRemote = !!opts.isRemote;

  if (!sandboxHasGit(pair.sandbox)) {
    const cont = await vscode.window.showWarningMessage(
      '\u6c99\u7bb1\u4e0d\u662f Git \u4ed3\u5e93\uff0c\u5c06\u4ec5\u7b7e\u51fa\u672c\u6e90\uff08\u65e0\u6cd5 reset maUtf\uff09\u3002\n\u672c\u6e90: ' + label,
      { modal: true },
      '\u7ee7\u7eed'
    );
    if (cont !== '\u7ee7\u7eed') return;
  } else {
    const ok = await vscode.window.showWarningMessage(
      'reset \u2192 \u5207\u771f\u6e90\uff1a\n' +
      '1) \u6c99\u7bb1 reset --hard \u2192 origin/maUtf\uff08utf\u5960\u57fa\uff09\n' +
      '2) \u672c\u6e90\u7b7e\u51fa: ' + label + '\n' +
      '\uff08\u4e0d\u81ea\u52a8 ToUtf\uff09',
      { modal: true },
      '\u786e\u8ba4\u7b7e\u51fa'
    );
    if (ok !== '\u786e\u8ba4\u7b7e\u51fa') return;
  }

  const { assertNotSyncing } = require('./sync_gate');
  if (!assertNotSyncing()) return;
  await invokeOptional('zkz-sandbox.beginYtMacroCheckoutGuard');
  try {
    await core().withProgress('reset \u2192 \u5207\u771f\u6e90: ' + label, async () => {
      if (sandboxHasGit(pair.sandbox)) {
        await resetSandboxToFoundation(pair.sandbox);
      }
      await checkoutW1Ref(pair, ref, label, isRemote);
    });
  } catch (e) {
    void invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
    throw e;
  }

  if (provider) provider.refresh();
  await invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
  const headNow = (await core().runGit(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  void showInfoAuto(
    (headNow === 'HEAD'
      ? ('\u672c\u6e90\u5df2\u7b7e\u51fa\u63d0\u4ea4: ' + (await core().runGit(pair.w1, ['rev-parse', '--short', 'HEAD'])).trim())
      : ('\u672c\u6e90\u5df2\u7b7e\u51fa: ' + headNow)) +
    (sandboxHasGit(pair.sandbox) ? '；\u6c99\u7bb1\u5df2 reset utf\u5960\u57fa' : '')
  );
  await askPullSandbox(pair, provider);
}

/**
 * Checkout branch tip, then:
 * W1 reset HEAD~1 -> sandbox reset utf\u5960\u57fa -> ToUtf -> sandbox commit "1"
 * -> W1 back to tip -> mixed undo last commit -> ToUtf.
 */
async function checkoutPrevCommitSandboxDance(pair, provider, opts) {
  const ref = opts.ref;
  const label = opts.label;
  const isRemote = !!opts.isRemote;

  if (!sandboxHasGit(pair.sandbox)) {
    void vscode.window.showErrorMessage(
      '\u6c99\u7bb1\u4e0d\u662f Git \u4ed3\u5e93\uff0c\u65e0\u6cd5\u6267\u884c\u6b64\u6d41\u7a0b\uff08\u9700 reset maUtf + \u6c99\u7bb1\u63d0\u4ea4\uff09'
    );
    return;
  }

  const ok = await vscode.window.showWarningMessage(
    '\u7b7e\u51fa\u540e HEAD~1 \u5960\u57fa\u63d0\u4ea4\uff1a\n' +
    '1) \u672c\u6e90\u7b7e\u51fa: ' + label + '\n' +
    '2) \u771f\u6e90 reset --hard HEAD~1\n' +
    '3) \u6c99\u7bb1 reset --hard \u2192 origin/maUtf\uff08utf\u5960\u57fa\uff09\n' +
    '4) Force ToUtf\n' +
    '5) \u6c99\u7bb1 commit -m "1"\n' +
    '6) \u771f\u6e90 reset --hard \u56de\u5230\u5206\u652f\u5c16\n' +
    '7) \u771f\u6e90 reset --mixed HEAD~1\uff08\u64a4\u9500\u4e0a\u4e00\u6b21\u4fee\u6539\uff0c\u6539\u52a8\u7559\u5de5\u4f5c\u533a\u3001\u4e0d\u6682\u5b58\uff09\n' +
    '8) Force ToUtf\n' +
    '\n\u8b66\u544a\uff1a\u4f1a\u4e22\u5f03\u771f\u6e90/\u6c99\u7bb1\u672a\u63d0\u4ea4\u66f4\u6539\uff1b\u7ed3\u675f\u540e\u771f\u6e90 HEAD \u5728\u5c16\u4e0a\u4e00\u63d0\u4ea4\u3002',
    { modal: true },
    '\u786e\u8ba4\u6267\u884c'
  );
  if (ok !== '\u786e\u8ba4\u6267\u884c') return;

  const { withSyncLock, assertNotSyncing } = require('./sync_gate');
  if (!assertNotSyncing()) return;
  await invokeOptional('zkz-sandbox.beginYtMacroCheckoutGuard');
  let tipSha = '';
  let tipShort = '';
  let sandboxCommitShort = '';
  try {
    await withSyncLock('checkout+HEAD~1+ToUtf', async () => {
      await core().withProgress('\u7b7e\u51fa + HEAD~1 \u5960\u57fa\u63d0\u4ea4: ' + label, async () => {
        await checkoutW1Ref(pair, ref, label, isRemote);
        tipSha = (await core().runGit(pair.w1, ['rev-parse', 'HEAD'])).trim();
        tipShort = (await core().runGit(pair.w1, ['rev-parse', '--short', 'HEAD'])).trim();
        try {
          await core().runGit(pair.w1, ['rev-parse', '--verify', 'HEAD~1']);
        } catch (_) {
          throw new Error(
            '\u771f\u6e90\u5206\u652f\u6ca1\u6709\u4e0a\u4e00\u4e2a\u63d0\u4ea4\uff08HEAD~1\uff09\uff0c\u65e0\u6cd5\u6267\u884c\u6b64\u6d41\u7a0b'
          );
        }
        await core().runGit(pair.w1, ['reset', '--hard', 'HEAD~1']);
        await resetSandboxToFoundation(pair.sandbox);
        await core().syncToUtf8Forced(pair.w1, []);
        const c = await commitSandboxMessage(pair.sandbox, '1');
        sandboxCommitShort = c.head;
        await core().runGit(pair.w1, ['reset', '--hard', tipSha]);
        // \u4e0e\u4fa7\u680f\u300c\u64a4\u9500\u4e0a\u4e00\u6b21\u4fee\u6539\u300d\u4e00\u81f4\uff1amixed \u64a4\u9500\u5c16\u63d0\u4ea4\uff0c\u6539\u52a8\u7559\u5de5\u4f5c\u533a\u3001\u4e0d\u6682\u5b58
        await core().runGit(pair.w1, ['reset', '--mixed', 'HEAD~1']);
        await core().syncToUtf8Forced(pair.w1, []);
      });
    });
  } catch (e) {
    // Best-effort restore tip if we already moved W1 away
    if (tipSha) {
      try {
        const cur = (await core().runGit(pair.w1, ['rev-parse', 'HEAD'])).trim();
        if (cur !== tipSha) {
          await core().runGit(pair.w1, ['reset', '--hard', tipSha]);
          log('restored W1 tip after failure: ' + tipShort);
        }
      } catch (re) {
        log('restore W1 tip failed: ' + String((re && re.message) || re));
      }
    }
    void invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
    throw e;
  }

  if (provider) provider.refresh();
  await invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
  const headNow = (await core().runGit(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const headShort = (await core().runGit(pair.w1, ['rev-parse', '--short', 'HEAD'])).trim();
  void showInfoAuto(
    (headNow === 'HEAD'
      ? ('\u672c\u6e90 HEAD: ' + headShort)
      : ('\u672c\u6e90: ' + headNow + ' @ ' + headShort)) +
    '\uff08\u5df2 mixed \u64a4\u9500\u5c16\u63d0\u4ea4 ' + tipShort + '\uff0c\u6539\u52a8\u5728\u5de5\u4f5c\u533a\uff09' +
    '；\u6c99\u7bb1\u5df2\u63d0\u4ea4 1 @ ' + sandboxCommitShort + ' \u5e76 ToUtf'
  );
}

async function askPullSandbox(pair, provider) {
  // Align with daily ToUtf: business only, no libs
  const pull = await vscode.window.showInformationMessage(
    '\u662f\u5426\u7acb\u523b\u5c06\u672c\u6e90\u53d8\u66f4\u62c9\u53d6\u5230\u6c99\u7bb1\uff1f\uff08\u4e1a\u52a1\uff0c\u4e0d\u542b\u5e93\uff09',
    '\u62c9\u53d6\u5230\u6c99\u7bb1',
    '\u7a0d\u540e'
  );
  if (pull === '\u62c9\u53d6\u5230\u6c99\u7bb1') {
    const { withSyncLock, assertNotSyncing } = require('./sync_gate');
    if (!assertNotSyncing()) return;
    await invokeOptional('zkz-sandbox.beginYtMacroCheckoutGuard');
    try {
      await withSyncLock('ToUtf', async () => {
        await core().withProgress('\u62c9\u53d6\u672c\u6e90 \u2192 \u6c99\u7bb1', async () => {
          await core().syncToUtf8Forced(pair.w1, []);
        });
      });
    } catch (e) {
      void invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
      throw e;
    }
    void showInfoAuto('\u6c99\u7bb1\u5df2\u5237\u65b0\uff08\u4e1a\u52a1\uff0c\u4e0d\u542b\u5e93\uff09');
    await invokeOptional('zkz-sandbox.syncYtVersionAfterCheckout');
  }
  if (provider) provider.refresh();
}



module.exports = {
  publishBranch,
  forcePush,
  sandboxHasGit,
  resetSandboxToFoundation,
  checkoutW1Ref,
  checkoutAndResetSandbox,
  checkoutResetThenW1,
  checkoutPrevCommitSandboxDance,
  askPullSandbox
};
