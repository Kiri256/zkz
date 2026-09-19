'use strict';

const { findRepoRoot, appendLog } = require('./paths');
const { isInstalled } = require('./git_config');
const { applySkipWorktree } = require('./config_freeze');
const { buildTable } = require('./enc_table');
const { runPrecommit } = require('./precommit');

async function lightRefresh(repoRoot, reason, opts) {
  if (!isInstalled(repoRoot)) return;
  try { applySkipWorktree(repoRoot); } catch (e) {
    appendLog(repoRoot, 'skip-worktree failed: ' + e);
  }
  try {
    const from = opts && opts.from;
    const to = opts && opts.to;
    await buildTable(repoRoot, (from && to) ? { from: from, to: to } : {});
    appendLog(repoRoot, 'table refreshed after ' + reason);
  } catch (e) {
    appendLog(repoRoot, 'table refresh failed: ' + e);
  }
}

async function main() {
  const event = process.argv[2] || '';
  const repoRoot = findRepoRoot(process.env.GIT_WORK_TREE || process.cwd());
  if (event === 'pre-commit') {
    const code = await runPrecommit(repoRoot);
    process.exit(code);
  }
  if (event === 'post-checkout') {
    const oldRev = process.argv[3] || '';
    const newRev = process.argv[4] || '';
    const branchFlag = process.argv[5];
    if (branchFlag === '1' || process.argv.length <= 3) {
      await lightRefresh(repoRoot, 'post-checkout', { from: oldRev, to: newRev });
    }
    return;
  }
  if (event === 'post-merge' || event === 'post-rewrite' || event === 'refresh') {
    await lightRefresh(repoRoot, event);
    return;
  }
  appendLog(repoRoot, 'unknown hook event: ' + event);
}

main().catch((e) => {
  try { process.stderr.write(String(e && e.stack ? e.stack : e) + '\n'); } catch (_) { /* ignore */ }
  if (process.argv[2] === 'pre-commit') process.exit(1);
});
