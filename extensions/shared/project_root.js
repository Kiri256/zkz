'use strict';

const fs = require('fs');
const path = require('path');

function isProjectRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, 'Project'))) return true;
  if (fs.existsSync(path.join(dir, 'core')) || fs.existsSync(path.join(dir, 'User'))) return true;
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  return false;
}

function findProjectRoot(starts) {
  const list = starts || [];
  for (let n = 0; n < list.length; n++) {
    let cur = list[n];
    for (let i = 0; i < 6; i++) {
      if (isProjectRoot(cur)) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return '';
}

module.exports = { isProjectRoot, findProjectRoot };
