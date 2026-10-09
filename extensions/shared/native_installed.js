'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function gitConfigGet(repoRoot, key) {
  const r = spawnSync('git', ['config', '--local', '--get', key], {
    cwd: repoRoot,
    windowsHide: true,
    encoding: 'utf8'
  });
  if (!r || r.status !== 0) return '';
  return String(r.stdout || '').trim();
}

function isNativeInstalled(repoRoot) {
  if (!repoRoot) return false;
  try {
    if (!gitConfigGet(repoRoot, 'filter.zkznative.process')) return false;
    const attr = path.join(repoRoot, '.git', 'info', 'attributes');
    if (!fs.existsSync(attr)) return false;
    return fs.readFileSync(attr, 'utf8').indexOf('filter=zkznative') >= 0;
  } catch (_) {
    return false;
  }
}

module.exports = { isNativeInstalled };
