'use strict';
const vscode = require('vscode'), path = require('path'), fs = require('fs'); const { execFile } = require('child_process'); const { log, showInfoAuto } = require('./shared');
const { getUtf8Path } = require('./pair');
function syncEngine() { return require('./sync_engine'); }
function invalidateBranchCacheLocal(w1) {
  try { require('./branch_cache').invalidateBranchCache(w1); } catch (_) { /* ignore */ }
}
function runGit(cwd, args) {
  const cmd = 'git ' + args.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  log(cwd + ' > ' + cmd);
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 40 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (stderr) log(stderr.toString().trim());
      if (e) {
        const raw = (stderr || e.message || '').trim() || String(e);
        const msg = translateGitError(cleanGitErrorMessage(raw) || raw);
        log('ERROR: ' + msg);
        reject(new Error(msg));
      } else {
        resolve((stdout || '').toString());
      }
    });
  });
}

function runGitBuffer(cwd, args) {
  const cmd = 'git ' + args.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
  log(cwd + ' > ' + cmd + ' [buffer]');
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 40 * 1024 * 1024,
      encoding: 'buffer'
    }, (e, stdout, stderr) => {
      if (stderr && stderr.length) log(stderr.toString('utf8').trim());
      if (e) {
        const msg = (stderr ? stderr.toString('utf8') : (e.message || '')).trim() || String(e);
        log('ERROR: ' + msg);
        reject(new Error(msg));
      } else {
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''));
      }
    });
  });
}

function syncDaily(action, w1) {
  return syncEngine().runDaily(action, w1, getUtf8Path(w1), null, log);
}

function syncToUtf8Forced(w1, extraArgs) {
  const args = extraArgs || [];
  return syncEngine().runToUtf8({
    w1,
    sandbox: getUtf8Path(w1),
    log,
    force: true,
    full: args.indexOf('-Full') >= 0,
    syncLibs: args.indexOf('-SyncLibs') >= 0,
    includeLibs: args.indexOf('-IncludeLibs') >= 0,
    changedOnly: args.indexOf('-ChangedOnly') >= 0
  });
}

/** Business then libs-only (after -SyncLibs became libs-only). */
async function syncToUtf8BizAndLibs(w1) {
  await syncToUtf8Forced(w1, []);
  await syncToUtf8Forced(w1, ['-SyncLibs']);
}

async function withProgress(title, fn) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    async () => fn()
  );
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitGitIndexLockGone(w1, timeoutMs) {
  const gitDirRaw = (await runGit(w1, ['rev-parse', '--git-dir'])).trim();
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.join(w1, gitDirRaw);
  const lockPath = path.join(gitDir, 'index.lock');
  const t0 = Date.now();
  while (fs.existsSync(lockPath)) {
    if (Date.now() - t0 > (timeoutMs || 20000)) {
      throw new Error('\u7b49\u5f85 git index.lock \u91ca\u653e\u8d85\u65f6: ' + lockPath);
    }
    await sleepMs(80);
  }
}

async function assertCheckoutComplete(w1, expect) {
  await waitGitIndexLockGone(w1, 20000);
  let headName = '';
  let headSha = '';
  let lastErr = null;
  for (let i = 0; i < 25; i++) {
    try {
      headName = (await runGit(w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      headSha = (await runGit(w1, ['rev-parse', 'HEAD'])).trim();
      if (!/^[0-9a-f]{40}$/i.test(headSha)) {
        throw new Error('HEAD SHA \u65e0\u6548: ' + headSha);
      }
      if (expect && expect.branch) {
        if (headName === expect.branch) {
          log('checkout verified: branch=' + headName + ' @ ' + headSha.slice(0, 9));
          return { head: headName, sha: headSha };
        }
      } else if (expect && expect.commitish) {
        const want = (await runGit(w1, ['rev-parse', expect.commitish + '^{commit}'])).trim();
        if (headSha.toLowerCase() === want.toLowerCase()) {
          log('checkout verified: detached/commit @ ' + headSha.slice(0, 9));
          return { head: headName, sha: headSha };
        }
      } else {
        log('checkout verified: HEAD=' + headName + ' @ ' + headSha.slice(0, 9));
        return { head: headName, sha: headSha };
      }
      lastErr = new Error(
        '\u5206\u652f\u5207\u6362\u5c1a\u672a\u5230\u4f4d\uff1a\u671f\u671b ' +
        (expect.branch || expect.commitish) +
        '\uff0c\u5f53\u524d ' + headName + ' @ ' + headSha.slice(0, 9)
      );
    } catch (e) {
      lastErr = e;
    }
    await sleepMs(120);
  }
  throw lastErr || new Error('\u5206\u652f\u5207\u6362\u786e\u8ba4\u5931\u8d25');
}

async function getW1RemoteSyncState(w1) {
  let dirty = false;
  try {
    dirty = (await runGit(w1, ['status', '--porcelain'])).trim().length > 0;
  } catch (_) { /* ignore */ }

  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let upstream = '';
  let unpublished = false;

  try {
    upstream = (await runGit(w1, ['rev-parse', '--abbrev-ref', '@{u}'])).trim();
    hasUpstream = !!upstream;
    const ab = (await runGit(w1, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim();
    const parts = ab.split(/\s+/).filter(Boolean);
    ahead = parseInt(parts[0], 10) || 0;
    behind = parseInt(parts[1], 10) || 0;
  } catch (_) {
    // No configured upstream: try origin/<branch>, else mark unpublished
    try {
      const br = (await runGit(w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      if (br && br !== 'HEAD') {
        try {
          await runGit(w1, ['rev-parse', '--verify', 'refs/remotes/origin/' + br]);
          ahead = parseInt((await runGit(w1, ['rev-list', '--count', 'origin/' + br + '..HEAD'])).trim(), 10) || 0;
          behind = parseInt((await runGit(w1, ['rev-list', '--count', 'HEAD..origin/' + br])).trim(), 10) || 0;
          hasUpstream = true;
          upstream = 'origin/' + br;
        } catch (_2) {
          unpublished = true;
        }
      }
    } catch (_3) { /* ignore */ }
  }

  return { ahead, behind, hasUpstream, upstream, dirty, unpublished };
}

/** Short suffix for tree header: " * ↑2 ↓1" / " * 未发布" */
function formatRemoteSyncSuffix(st) {
  if (!st) return '';
  let s = '';
  if (st.dirty) s += ' *';
  if (st.unpublished) s += ' \u672a\u53d1\u5e03';
  else {
    if (st.ahead > 0) s += ' \u2191' + st.ahead;
    if (st.behind > 0) s += ' \u2193' + st.behind;
  }
  return s;
}

/** Sandbox working branch / foundation (utf\u5960\u57fa = origin/maUtf) */
function cleanGitErrorMessage(msg) {
  return String(msg || '')
    .split(/\r?\n/)
    .map((s) => s.trimEnd())
    .filter((line) => {
      if (!line) return false;
      if (/post-quantum key exchange/i.test(line)) return false;
      if (/store now, decrypt later/i.test(line)) return false;
      if (/openssh\.com\/pq/i.test(line)) return false;
      if (/^WARNING:\s*connection is not using/i.test(line)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function isCaseRefConflictError(e) {
  const msg = String(e && e.message ? e.message : e);
  return /case-insensitive filesystem/i.test(msg) || /only differ in casing/i.test(msg) || /reftable/i.test(msg);
}

async function getUpstreamRemoteBranch(w1) {
  const branch = (await runGit(w1, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') {
    throw new Error('\u5f53\u524d\u4e3a detached HEAD\uff0c\u65e0\u6cd5\u4ec5\u62c9\u53d6\u5f53\u524d\u5206\u652f');
  }
  let remote = 'origin';
  let upstreamBranch = branch;
  try {
    const up = (await runGit(w1, ['rev-parse', '--abbrev-ref', '@{u}'])).trim(); // origin/foo
    if (up && up.includes('/')) {
      const i = up.indexOf('/');
      remote = up.slice(0, i);
      upstreamBranch = up.slice(i + 1);
    }
  } catch (_) {
    try {
      remote = (await runGit(w1, ['remote'])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || 'origin';
    } catch (_2) {
      remote = 'origin';
    }
  }
  return { remote, branch, upstreamBranch };
}

/**
 * pull --ff-only; on Windows case-ref conflicts, fetch/merge only current upstream branch.
 */

function translateGitError(msg) {
  const x = String(msg || '');
  const l = x.toLowerCase();
  if (/authentication failed|permission denied|could not read username|publickey/.test(l)) {
    return '\u8ba4\u8bc1\u5931\u8d25\uff1a\u8bf7\u68c0\u67e5 Git \u8d26\u53f7\u3001\u4ee4\u724c\u6216 SSH \u5bc6\u94a5\u3002\n' + x;
  }
  if (/non-fast-forward|fetch first|updates were rejected/.test(l)) {
    return '\u63a8\u9001\u88ab\u62d2\u7edd\uff08\u975e\u5feb\u8fdb\uff09\uff1a\u8bf7\u5148\u62c9\u53d6\u5e76\u5904\u7406\u5408\u5e76\u3002\n' + x;
  }
  if (/diverg/.test(l)) {
    return '\u672c\u5730\u4e0e\u8fdc\u7a0b\u5df2\u5206\u53c9\uff0c\u8bf7\u89e3\u51b3\u5408\u5e76\u540e\u7ee7\u7eed\u3002\n' + x;
  }
  if (/case-insensitive filesystem|only differ in casing|cannot lock ref/.test(l)) {
    return '\u8fdc\u7a0b\u5b58\u5728\u4ec5\u5927\u5c0f\u5199\u4e0d\u540c\u7684\u5206\u652f\u5f15\u7528\uff08Windows \u65e0\u6cd5\u5168\u91cf fetch\uff09\u3002\u5df2/\u8bf7\u6539\u4e3a\u4ec5\u64cd\u4f5c\u5f53\u524d\u5206\u652f\u3002\n' + x;
  }
  if (/could not resolve host|failed to connect|network is unreachable|timed out|connection reset/.test(l)) {
    return '\u7f51\u7edc\u6216\u8fdc\u7a0b\u8fde\u63a5\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc/VPN/\u4ee3\u7406\u3002\n' + x;
  }
  if (/conflict|unmerged|fix conflicts/.test(l)) {
    return '\u5408\u5e76\u51b2\u7a81\uff1a\u8bf7\u5148\u89e3\u51b3\u51b2\u7a81\u540e\u7ee7\u7eed\u3002\n' + x;
  }
  if (/index\.lock|another git process/.test(l)) {
    return 'Git index.lock \u88ab\u5360\u7528\uff1a\u8bf7\u7a0d\u5019\u91cd\u8bd5\uff0c\u6216\u68c0\u67e5\u662f\u5426\u6709\u5176\u4ed6 Git \u8fdb\u7a0b\u3002\n' + x;
  }
  if (/not a git repository/.test(l)) {
    return '\u5f53\u524d\u76ee\u5f55\u4e0d\u662f Git \u4ed3\u5e93\u3002\n' + x;
  }
  return x;
}

/**
 * \u9ed8\u8ba4\u4ec5 fetch \u5f53\u524d\u4e0a\u6e38\u5206\u652f\uff08\u907f\u514d Windows \u5927\u5c0f\u5199\u5f15\u7528\u51b2\u7a81\uff09\u3002
 * all=true \u65f6\u5c1d\u8bd5 fetch --all --prune\u3002
 */
async function fetchW1Safe(w1, all) {
  if (all) return fetchW1All(w1);
  const { remote, upstreamBranch } = await getUpstreamRemoteBranch(w1);
  log('fetch current: ' + remote + ' ' + upstreamBranch);
  try {
    await runGit(w1, ['fetch', '--prune', remote, upstreamBranch]);
  } catch (e) {
    if (!isCaseRefConflictError(e)) throw e;
    await runGit(w1, ['fetch', remote, upstreamBranch]);
  }
  return { mode: 'current', remote, upstreamBranch };
}

async function fetchW1All(w1) {
  try {
    await runGit(w1, ['fetch', '--all', '--prune']);
    return { mode: 'all' };
  } catch (e) {
    if (!isCaseRefConflictError(e)) throw e;
    const { remote, upstreamBranch } = await getUpstreamRemoteBranch(w1);
    log('fetch --all failed (case-ref); fallback current: ' + remote + '/' + upstreamBranch);
    await runGit(w1, ['fetch', remote, upstreamBranch]);
    void showInfoAuto(
      '\u5168\u91cf\u6293\u53d6\u56e0\u5927\u5c0f\u5199\u5f15\u7528\u51b2\u7a81\u5931\u8d25\uff0c\u5df2\u6539\u4e3a\u4ec5 fetch \u5f53\u524d\u5206\u652f: ' +
      remote + '/' + upstreamBranch
    );
    return { mode: 'current', remote, upstreamBranch };
  }
}

/**
 * \u9ed8\u8ba4\u4ec5\u62c9\u53d6\u5f53\u524d\u4e0a\u6e38\uff08fetch + ff-only merge\uff09\u3002
 * all=true \u65f6\u5148\u5168\u91cf fetch \u518d merge\u3002
 */
async function pullW1Safe(w1, all) {
  if (all) {
    await fetchW1All(w1);
    await runGit(w1, ['merge', '--ff-only', '@{u}']);
    return { mode: 'all' };
  }
  const { remote, upstreamBranch } = await getUpstreamRemoteBranch(w1);
  log('pull current: ' + remote + ' ' + upstreamBranch);
  await runGit(w1, ['fetch', remote, upstreamBranch]);
  try {
    await runGit(w1, ['merge', '--ff-only', '@{u}']);
  } catch (e1) {
    // \u65e0 upstream \u6216 @{u} \u4e0d\u53ef\u7528\u65f6\u7528 FETCH_HEAD
    await runGit(w1, ['merge', '--ff-only', 'FETCH_HEAD']);
  }
  return { mode: 'current', remote, upstreamBranch };
}


const gitOps = require('./git_ops');

module.exports = {
  runGit,
  runGitBuffer,
  syncDaily,
  syncToUtf8Forced,
  syncToUtf8BizAndLibs,
  withProgress,
  sleepMs,
  waitGitIndexLockGone,
  assertCheckoutComplete,
  invalidateBranchCacheLocal,
  getW1RemoteSyncState,
  formatRemoteSyncSuffix,
  cleanGitErrorMessage,
  translateGitError,
  isCaseRefConflictError,
  getUpstreamRemoteBranch,
  pullW1Safe,
  fetchW1Safe,
  fetchW1All,
  publishBranch: gitOps.publishBranch,
  forcePush: gitOps.forcePush,
  sandboxHasGit: gitOps.sandboxHasGit,
  resetSandboxToFoundation: gitOps.resetSandboxToFoundation,
  checkoutW1Ref: gitOps.checkoutW1Ref,
  checkoutAndResetSandbox: gitOps.checkoutAndResetSandbox,
  checkoutResetThenW1: gitOps.checkoutResetThenW1,
  checkoutPrevCommitSandboxDance: gitOps.checkoutPrevCommitSandboxDance,
  askPullSandbox: gitOps.askPullSandbox
};
