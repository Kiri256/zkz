'use strict';

const fs = require('fs');
const { isWorktreeClean, currentHead, readHeadName } = require('./git_exec');
const { buildTable, loadTable, loadMeta, countByKind, noteTableRef, noteTableHead } = require('./enc_table');
const { installGitConfig, uninstallGitConfig, isInstalled } = require('./git_config');
const { installHooks, uninstallHooks } = require('./hooks');
const { atomicWriteJson, nativeStatusPath, ensureZkz, formatLocalNow } = require('./paths');
const { loadRoundtripFailures, loadCp936Drops, loadFilterFail, loadCommitRejects, FILTER_FAIL_LIMIT } = require('./observe');
const { reconcileCommitReject } = require('./precommit');
const { loadLibWarnings, libWarningsNotified } = require('./lib_encoding');
const {
  diskNeedsSmudge,
  smudgeWorktree,
  resmudgeStale,
  restoreOriginalStale,
  worktreeBytes
} = require('./materialize');

function tableDrift(repoRoot) {
  const meta = loadMeta(repoRoot);
  if (!meta) return false;
  if (!meta.ref) {
    noteTableRef(repoRoot, meta);
    return false;
  }
  const name = readHeadName(repoRoot);
  return !!(name && meta.ref !== name);
}

function charPos(message) {
  const m = /at (\d+)/.exec(String(message || ''));
  return m ? Number(m[1]) : undefined;
}

// 状态栏只表示过滤器开或关。编码和库的问题留在悬停和菜单里。
function barLabel(st) {
  if (!st || !st.installed) return 'native 关';
  return 'native 开';
}

// 和状态栏悬停同一份文件名，启用和刷新写到输出。
function statusLines(st) {
  const lines = ['编码表 ' + ((st && st.tableCount) || 0) + ' 项'];
  if (st && st.roundtripFails && st.roundtripFails.length) lines.push('编不回: ' + st.roundtripFails.slice(0, 8).join('、'));
  if (st && st.cp936Drops && st.cp936Drops.length) lines.push('丢掉字符: ' + st.cp936Drops.slice(0, 8).join('、'));
  ((st && st.commitRejects) || []).slice(0, 6).forEach((it) => {
    if (it && it.message) lines.push(it.message);
  });
  if (st && st.unstable && st.unstable.length) lines.push('未对齐: ' + st.unstable.slice(0, 8).join('、'));
  const libs = (st && st.libWarnings) || [];
  if (libs.length) lines.push('库编码: ' + libs.slice(0, 8).map((it) => it.rel).join('、'));
  if (st && (st.filterFails || 0) >= FILTER_FAIL_LIMIT) lines.push('过滤器连续失败，Git 可能不可用');
  if (st && st.tableDrift) lines.push('编码表对应的分支已变，将自动刷新');
  return lines;
}

// 菜单第一项用的动作：能编回的重新暂存，写不回的打开文件。
function encodingActions(st) {
  const rejects = (st && st.commitRejects) || [];
  const restage = [];
  const opens = [];
  const notes = [];
  const seen = new Set();
  rejects.forEach((item) => {
    if (!item) return;
    if (item.action === 'restage' && item.rel) {
      restage.push(item);
      seen.add(item.rel);
      return;
    }
    if (item.action === 'open' && item.rel) {
      opens.push(item);
      seen.add(item.rel);
      return;
    }
    if (item.message) notes.push(item);
  });
  const fails = (st && st.roundtripItems) || [];
  fails.forEach((item) => {
    const rel = item && item.rel;
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    opens.push({
      rel: rel,
      action: 'open',
      message: item.message || (rel + ' 编不回 GBK'),
      position: charPos(item.message)
    });
  });
  const drops = (st && st.cp936DropItems) || [];
  drops.forEach((item) => {
    const rel = item && item.rel;
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    const pos = Array.isArray(item.positions) && item.positions.length ? item.positions[0] : charPos(item.message);
    opens.push({
      rel: rel,
      action: 'open',
      message: item.message || (rel + ' 丢掉了字符'),
      position: pos
    });
  });
  const unstable = ((st && st.unstable) || []).filter((rel) => rel && !seen.has(rel));
  return { restage: restage, opens: opens, notes: notes, unstable: unstable };
}

function commitRejectsOf(repoRoot) {
  try { return reconcileCommitReject(repoRoot); } catch (_) { return loadCommitRejects(repoRoot); }
}

function statusSnapshot(repoRoot) {
  const installed = isInstalled(repoRoot);
  const files = loadTable(repoRoot);
  const n = Object.keys(files).length;
  let unstable = [];
  try {
    const p = nativeStatusPath(repoRoot);
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(obj.unstable)) unstable = obj.unstable;
    }
  } catch (_) { /* ignore */ }
  const roundtripFails = loadRoundtripFailures(repoRoot);
  const cp936Drops = loadCp936Drops(repoRoot);
  const ff = loadFilterFail(repoRoot);
  return {
    installed: installed,
    tableCount: n,
    counts: countByKind(files),
    unstable: unstable,
    roundtripFails: roundtripFails.map((x) => x.rel),
    roundtripItems: roundtripFails,
    cp936Drops: cp936Drops.map((x) => x.rel),
    cp936DropItems: cp936Drops,
    commitRejects: commitRejectsOf(repoRoot),
    tableDrift: tableDrift(repoRoot),
    filterFails: ff.count,
    filterFailLast: ff.last,
    filterFailNotified: ff.notified,
    libWarnings: loadLibWarnings(repoRoot),
    libWarningsNotified: libWarningsNotified(repoRoot)
  };
}

async function enable(repoRoot, extensionRoot, opts) {
  const force = !!(opts && opts.force);
  if (!force && !isWorktreeClean(repoRoot)) {
    const err = new Error('工作区不干净，请先提交或暂存后再启用 zkz-native');
    err.code = 'ZKZ_DIRTY';
    throw err;
  }
  const built = await buildTable(repoRoot);
  installGitConfig(repoRoot, extensionRoot);
  installHooks(repoRoot, extensionRoot);
  const sm = smudgeWorktree(repoRoot);
  const unstable = sm.unstable || [];
  try {
    ensureZkz(repoRoot);
    atomicWriteJson(nativeStatusPath(repoRoot), {
      unstable: unstable,
      at: formatLocalNow()
    });
  } catch (_) { /* ignore */ }
  return {
    installed: true,
    tableCount: Object.keys(built.files).length,
    counts: built.counts,
    unstable: unstable
  };
}

function disable(repoRoot) {
  uninstallGitConfig(repoRoot);
  if (!require('./git_config').isLocalInstalled(repoRoot)) uninstallHooks(repoRoot);
  const r = restoreOriginalStale(repoRoot);
  return { installed: false, restored: r.checked, leftover: r.leftover };
}

// 编烧同步前让编码表对上当前提交。同分支只改提交号，换分支才重算。重算过返回 true。扩展宿主调用。
async function settleEncodingTable(repoRoot) {
  const meta = loadMeta(repoRoot);
  const head = currentHead(repoRoot);
  const got = String(meta && meta.head || '').trim().toLowerCase();
  const want = String(head || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(got) || !/^[0-9a-f]{40}$/.test(want) || got === want) return false;
  const ref = readHeadName(repoRoot);
  if (meta.ref && ref && meta.ref === ref && ref.indexOf('refs/heads/') === 0) {
    noteTableHead(repoRoot, want);
    return false;
  }
  await silentRefresh(repoRoot, { from: meta.head, to: head });
  return true;
}

async function silentRefresh(repoRoot, opts) {
  const errors = [];
  try {
    const from = opts && opts.from;
    const to = opts && opts.to;
    await buildTable(repoRoot, (from && to) ? { from: from, to: to } : {});
  } catch (e) {
    errors.push('table: ' + String(e && e.message ? e.message : e));
  }
  return { errors: errors };
}

async function refresh(repoRoot, extensionRoot, opts) {
  const force = !!(opts && opts.force);
  const meta = loadMeta(repoRoot);
  const head = currentHead(repoRoot);
  if (!force && meta && meta.head && meta.head === head) {
    const files = loadTable(repoRoot);
    return {
      installed: isInstalled(repoRoot),
      tableCount: Object.keys(files).length,
      counts: countByKind(files),
      unstable: [],
      skipped: true
    };
  }
  if (extensionRoot) {
    const { verifyGitConfig } = require('./git_config');
    const { verifyHooks } = require('./hooks');
    verifyGitConfig(repoRoot, extensionRoot);
    verifyHooks(repoRoot, extensionRoot);
  }
  const built = await buildTable(repoRoot, force
    ? { force: true }
    : { from: meta && meta.head, to: head });
  if (force) resmudgeStale(repoRoot);
  return {
    installed: isInstalled(repoRoot),
    tableCount: Object.keys(built.files).length,
    counts: built.counts,
    unstable: []
  };
}

module.exports = {
  enable,
  disable,
  refresh,
  silentRefresh,
  settleEncodingTable,
  statusSnapshot,
  barLabel,
  statusLines,
  encodingActions,
  resmudgeStale,
  diskNeedsSmudge,
  restoreOriginalStale,
  worktreeBytes,
  tableDrift
};
