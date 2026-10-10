'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CMSIS_BASE = '5d0542f12037168001fc469258019a95357dbd14';
const CMSIS_PATH = 'Libraries/CMSIS/Device/ST/STM32F4xx/Include';

function runGit(root, args) {
  return spawnSync('git', args, {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8'
  });
}

function hasFiles(root, rel) {
  const dir = path.join(root, rel.replace(/\//g, path.sep));
  try { return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0; }
  catch (_) { return false; }
}

function restoreCmsis(root) {
  if (hasFiles(root, CMSIS_PATH)) {
    return { restored: false, skipped: true, path: CMSIS_PATH };
  }
  const exists = runGit(root, ['cat-file', '-e', CMSIS_BASE + '^{commit}']);
  if (exists.status !== 0) {
    throw new Error('CMSIS 基线提交不存在: ' + CMSIS_BASE);
  }
  let result = runGit(root, ['restore', '--source=' + CMSIS_BASE, '--worktree', '--', CMSIS_PATH]);
  if (result.status !== 0) {
    result = runGit(root, ['checkout', CMSIS_BASE, '--', CMSIS_PATH]);
    if (result.status === 0) runGit(root, ['reset', '-q', 'HEAD', '--', CMSIS_PATH]);
  }
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || '恢复 CMSIS Include 失败').trim());
  }
  return { restored: true, skipped: false, path: CMSIS_PATH };
}

module.exports = { CMSIS_BASE, CMSIS_PATH, hasFiles, restoreCmsis };
