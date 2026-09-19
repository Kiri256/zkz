'use strict';

const fs = require('fs');
const path = require('path');
const { isWorktreeClean, git, gitText, listSourceFiles, currentHead } = require('./git_exec');
const { buildTable, loadTable, loadMeta, countByKind } = require('./enc_table');
const { installGitConfig, uninstallGitConfig, isInstalled } = require('./git_config');
const { installHooks, uninstallHooks } = require('./hooks');
const { applySkipWorktree, clearSkipWorktree } = require('./config_freeze');
const { appendLog, slashRel, isLibRel } = require('./paths');
const { detectKind, parseMapped } = require('./encoding');

function resmudgeStale(repoRoot) {
  const table = loadTable(repoRoot);
  const stale = [];
  for (const rel of listSourceFiles(repoRoot).map(slashRel)) {
    if (isLibRel(repoRoot, rel)) continue;
    const kind = parseMapped(table[rel]).kind;
    if (kind !== 'Gbk' && kind !== 'Utf8Bom') continue;
    const abs = path.join(repoRoot, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { continue; }
    if (kind === 'Gbk' && detectKind(buf) === 'Gbk') stale.push(rel);
    if (kind === 'Utf8Bom' && detectKind(buf) === 'Utf8Bom') stale.push(rel);
  }
  if (!stale.length) return 0;
  const chunk = 80;
  for (let i = 0; i < stale.length; i += chunk) {
    git(repoRoot, ['checkout-index', '-f', '--'].concat(stale.slice(i, i + chunk)), { allowFail: true });
  }
  return stale.length;
}

function statusSnapshot(repoRoot) {
  const installed = isInstalled(repoRoot);
  const files = loadTable(repoRoot);
  const n = Object.keys(files).length;
  let unstable = [];
  try {
    const path = require('path');
    const fs = require('fs');
    const p = path.join(repoRoot, '.zkz', 'native-status.json');
    if (fs.existsSync(p)) {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(obj.unstable)) unstable = obj.unstable;
    }
  } catch (_) { /* ignore */ }
  return {
    installed: installed,
    tableCount: n,
    counts: countByKind(files),
    unstable: unstable
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
  applySkipWorktree(repoRoot, { force: true });
  // checkout -- . 会跳过「stat 已与 index 一致」的旧 GBK 文件，必须强制写出才会跑 smudge
  git(repoRoot, ['checkout-index', '-f', '-a'], { allowFail: true });
  git(repoRoot, ['add', '--renormalize', '.'], { allowFail: true });
  const status = gitText(repoRoot, ['status', '--porcelain'], { allowFail: true });
  const unstable = String(status || '').split('\n').map((s) => s.trim()).filter(Boolean);
  git(repoRoot, ['reset', 'HEAD'], { allowFail: true });
  try {
    const { ensureZkz, formatLocalNow } = require('./paths');
    ensureZkz(repoRoot);
    fs.writeFileSync(path.join(repoRoot, '.zkz', 'native-status.json'), JSON.stringify({
      unstable: unstable,
      at: formatLocalNow()
    }, null, 2), 'utf8');
  } catch (_) { /* ignore */ }
  appendLog(repoRoot, 'enabled; table ' + built.meta.head + ' files=' + Object.keys(built.files).length + ' unstable=' + unstable.length);
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
  clearSkipWorktree(repoRoot);
  git(repoRoot, ['checkout-index', '-f', '-a'], { allowFail: true });
  appendLog(repoRoot, 'disabled');
  return { installed: false };
}

async function refresh(repoRoot, extensionRoot, opts) {
  const force = !!(opts && opts.force);
  const meta = loadMeta(repoRoot);
  const head = currentHead(repoRoot);
  if (!force && meta && meta.head && meta.head === head) {
    const files = loadTable(repoRoot);
    appendLog(repoRoot, 'refresh skipped (HEAD unchanged)');
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
    verifyGitConfig(repoRoot, extensionRoot);
    installHooks(repoRoot, extensionRoot);
  }
  if (force) applySkipWorktree(repoRoot, { force: true });
  const built = await buildTable(repoRoot, force
    ? { force: true }
    : { from: meta && meta.head, to: head });
  const smudged = force ? resmudgeStale(repoRoot) : 0;
  appendLog(repoRoot, 'table refreshed files=' + Object.keys(built.files).length + ' resmudge=' + smudged);
  return {
    installed: isInstalled(repoRoot),
    tableCount: Object.keys(built.files).length,
    counts: built.counts,
    unstable: []
  };
}

module.exports = { enable, disable, refresh, statusSnapshot, resmudgeStale };
