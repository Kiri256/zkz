'use strict';

const fs = require('fs');
const { isWorktreeClean, currentHead, readHeadName } = require('./git_exec');
const { buildTable, loadTable, loadMeta, countByKind, noteTableRef } = require('./enc_table');
const { installGitConfig, uninstallGitConfig, isInstalled } = require('./git_config');
const { installHooks, uninstallHooks } = require('./hooks');
const { atomicWriteJson, nativeStatusPath, ensureZkz, formatLocalNow } = require('./paths');
const { loadRoundtripFailures, loadCp936Drops, loadFilterFail } = require('./observe');
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
    cp936Drops: cp936Drops.map((x) => x.rel),
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
  uninstallHooks(repoRoot);
  const r = restoreOriginalStale(repoRoot);
  return { installed: false, restored: r.checked, leftover: r.leftover };
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
  statusSnapshot,
  resmudgeStale,
  diskNeedsSmudge,
  restoreOriginalStale,
  worktreeBytes,
  tableDrift
};
