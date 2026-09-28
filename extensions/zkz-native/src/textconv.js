'use strict';

const fs = require('fs');
const path = require('path');
const { findRepoRoot, slashRel } = require('./paths');
const { loadTable } = require('./enc_table');
const { smudge } = require('./filter_core');

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: textconv.js <tempfile>\n');
    process.exit(1);
  }
  const buf = fs.readFileSync(file);
  const repoRoot = findRepoRoot(process.env.GIT_WORK_TREE || process.cwd());
  const table = loadTable(repoRoot);
  let rel = '';
  try {
    const abs = path.resolve(file);
    const root = path.resolve(repoRoot);
    const prefix = root.toLowerCase() + path.sep;
    if (abs.toLowerCase().indexOf(prefix) === 0) {
      rel = slashRel(path.relative(root, abs));
    }
  } catch (_) { /* temp blob outside the worktree */ }
  process.stdout.write(smudge(rel || file, buf, table, repoRoot));
}

main();
