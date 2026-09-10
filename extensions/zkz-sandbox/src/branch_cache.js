'use strict';
const vscode=require('vscode');const {runGit}=require('./git');
const {formatRelativeZh,formatDateTimeZh,formatCommitTimeLine}=require('./time_fmt');
/** Branch list cache: avoid for-each-ref stall on every status-bar click */
const branchListCache = { key: '', at: 0, items: null, inflight: null };
const BRANCH_CACHE_MS = 60000; // 1 min fresh
const ICON_GIT_BRANCH = new vscode.ThemeIcon('git-branch');
const ICON_GIT_CLOUD = new vscode.ThemeIcon('cloud');
const ICON_GIT_CHECK = new vscode.ThemeIcon('check');

function invalidateBranchCache(w1) {
  // Only clear when w1 omitted, unknown, or matches current cache key
  if (!w1 || !branchListCache.key || branchListCache.key === w1) {
    branchListCache.items = null;
    branchListCache.at = 0;
    branchListCache.inflight = null;
  }
}

function hasBranchCache(w1) {
  return !!(branchListCache.key === w1 && branchListCache.items && branchListCache.items.length);
}

function hasFreshBranchCache(w1) {
  return !!(
    hasBranchCache(w1) &&
    (Date.now() - branchListCache.at) < BRANCH_CACHE_MS
  );
}

function peekBranchCache(w1) {
  return hasBranchCache(w1) ? branchListCache.items.slice() : null;
}

/**
 * Show branch QuickPick immediately (busy while loading).
 * Uses stale cache when present; refreshes in background if stale/forced.
 */
async function pickBranchFromList(w1, opts) {
  const withRemoteHint = !!(opts && opts.withRemoteHint);
  const placeHolder = (opts && opts.placeHolder) || '\u8f93\u5165\u4ee5\u7b5b\u9009\u5206\u652f\uff08\u672c\u5730 + \u8fdc\u7a0b\uff09';
  const extraItems = (opts && opts.extraItems) || [];

  const qp = vscode.window.createQuickPick();
  qp.placeholder = placeHolder;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;

  const applyItems = (branches) => {
    qp.items = branchesToQuickPickItems(branches, withRemoteHint).concat(extraItems);
  };

  const stale = peekBranchCache(w1);
  if (stale) {
    applyItems(stale);
    qp.busy = !hasFreshBranchCache(w1);
  } else {
    qp.busy = true;
    qp.placeholder = '\u52a0\u8f7d\u5206\u652f\u2026';
    qp.items = [];
  }

  const picked = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      qp.hide();
      qp.dispose();
    };
    qp.onDidAccept(() => {
      const sel = qp.selectedItems && qp.selectedItems[0];
      finish(sel || null);
    });
    qp.onDidHide(() => finish(null));
    qp.show();

    // Load / refresh without blocking the picker UI
    void (async () => {
      try {
        const needForce = !hasFreshBranchCache(w1);
        const branches = await loadBranches(w1, needForce ? { force: true } : undefined);
        if (settled) return;
        applyItems(branches);
        qp.placeholder = placeHolder;
        qp.busy = false;
      } catch (e) {
        if (settled) return;
        qp.busy = false;
        qp.placeholder = '\u52a0\u8f7d\u5206\u652f\u5931\u8d25: ' + (e && e.message ? e.message : e);
        if (!stale) {
          vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
          finish(null);
        }
      }
    })();
  });

  return picked;
}

/** 本地+远程分支，按提交时间降序；远程保留 origin/ 前缀 */
async function loadBranches(w1, opts) {
  const force = !!(opts && opts.force);
  if (!force && hasFreshBranchCache(w1)) {
    return branchListCache.items.map((b) => Object.assign({}, b, {
      dateRel: formatRelativeZh(b.dateUnix),
      dateAbs: formatDateTimeZh(b.dateUnix)
    }));
  }
  // Share in-flight for-each-ref even when force (avoid duplicate spawn)
  if (branchListCache.key === w1 && branchListCache.inflight) {
    return (await branchListCache.inflight).slice();
  }

  const job = (async () => {
    // 单次 for-each-ref（含 %(HEAD)），避免再 spawn rev-parse
    const out = await runGit(w1, [
      'for-each-ref',
      '--sort=-committerdate',
      'refs/heads/',
      'refs/remotes/',
      '--format=%(HEAD)%09%(refname)%09%(refname:short)%09%(committerdate:unix)%09%(authorname)%09%(subject)'
    ]);
    const items = [];
    // 注意：不可对整行 trim()——%(HEAD) 为空时行首是 tab，trim 会吃掉导致字段错位（分支名变成 unix 时间戳）
    for (const line of out.split(/\r?\n/)) {
      const raw = String(line).replace(/\s+$/, '');
      if (!raw) continue;
      const parts = raw.split('\t');
      let isHeadMark = false;
      let full = '';
      let name = '';
      let dateUnix = 0;
      let author = '';
      let subject = '';
      // Git for-each-ref: 当前分支 %(HEAD)=*；其它分支常为单个空格（不是空串）
      const headField = String(parts[0] == null ? '' : parts[0]).trim();
      if (headField === '*' || headField === '') {
        isHeadMark = headField === '*';
        full = parts[1] || '';
        name = parts[2] || '';
        dateUnix = Number(parts[3] || 0) || 0;
        author = parts[4] || '';
        subject = parts.slice(5).join('\t') || '';
      } else if ((parts[0] || '').startsWith('refs/')) {
        // 兼容异常输出（无前导 HEAD 字段）
        isHeadMark = false;
        full = parts[0] || '';
        name = parts[1] || '';
        dateUnix = Number(parts[2] || 0) || 0;
        author = parts[3] || '';
        subject = parts.slice(4).join('\t') || '';
      } else {
        continue;
      }
      if (!name || name.endsWith('/HEAD') || full.endsWith('/HEAD')) continue;
      // 防御：名称若整段是 unix 秒，说明仍错位，跳过以免签出报 unknown revision
      if (/^\d{9,12}$/.test(name)) continue;
      const isRemote = full.startsWith('refs/remotes/');
      items.push({
        name,
        ref: name,
        isRemote,
        dateUnix,
        dateRel: formatRelativeZh(dateUnix),
        dateAbs: formatDateTimeZh(dateUnix),
        author,
        subject,
        current: isHeadMark && !isRemote
      });
    }
    branchListCache.key = w1;
    branchListCache.at = Date.now();
    branchListCache.items = items;
    branchListCache.inflight = null;
    return items;
  })();

  branchListCache.key = w1;
  branchListCache.inflight = job;
  try {
    return (await job).slice();
  } catch (e) {
    if (branchListCache.inflight === job) branchListCache.inflight = null;
    throw e;
  }
}

function branchesToQuickPickItems(branches, withRemoteHint) {
  return branches.map((b) => ({
    label: b.name,
    description:
      (b.dateRel || '') +
      (b.current ? '  HEAD' : '') +
      (withRemoteHint ? (b.isRemote ? '  远程分支' : '  分支') : ''),
    detail: (b.author ? b.author + ' • ' : '') + (b.subject || ''),
    iconPath: b.current ? ICON_GIT_CHECK : (b.isRemote ? ICON_GIT_CLOUD : ICON_GIT_BRANCH),
    ref: b.ref,
    isRemote: b.isRemote
  }));
}


module.exports={branchListCache,invalidateBranchCache,hasBranchCache,hasFreshBranchCache,peekBranchCache,pickBranchFromList,loadBranches,branchesToQuickPickItems};
