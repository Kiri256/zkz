'use strict';

const { findRepoRoot } = require('./paths');
const { runPrecommit, runPrepush } = require('./precommit');

function hookWarn(msg) {
  try { process.stderr.write('zkz-native: ' + msg + '\n'); } catch (_) { /* ignore */ }
}

async function main() {
  process.env.ZKZ_NATIVE_HOOK = '1';
  const event = process.argv[2] || '';
  const repoRoot = findRepoRoot(process.env.GIT_WORK_TREE || process.cwd());
  if (event === 'pre-commit') {
    const code = await runPrecommit(repoRoot);
    process.exit(code);
  }
  if (event === 'pre-push') {
    const code = await runPrepush(repoRoot);
    process.exit(code);
  }
  if (event === 'post-checkout' || event === 'post-merge' || event === 'post-rewrite' || event === 'refresh') {
    hookWarn('refresh hooks retired; encoding table refreshes in the editor');
    return;
  }
  hookWarn('unknown hook event: ' + event);
}

main().catch((e) => {
  try { process.stderr.write(String(e && e.stack ? e.stack : e) + '\n'); } catch (_) { /* ignore */ }
  if (process.argv[2] === 'pre-commit' || process.argv[2] === 'pre-push') process.exit(1);
});
