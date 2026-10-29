'use strict';

// 三份 src/load_shared.js 内容相同。靠本文件所在目录定位，不能放进 shared 再引用。

const fs = require('fs');
const path = require('path');

/** 从本文件所在目录向上找 shared/<名>.js 并加载。源码树命中 extensions/shared，装进扩展后命中 src/shared。返回该模块。扩展宿主或过滤进程调用。 */
function loadShared(name) {
  const base = String(name || '');
  if (!/^[A-Za-z0-9_]+$/.test(base)) throw new Error('shared 模块名无效');
  const file = base + '.js';
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'shared', file);
    let found = false;
    try { found = fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch (_) { found = false; }
    if (found) return require(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到 shared/' + base);
}

module.exports = loadShared;
