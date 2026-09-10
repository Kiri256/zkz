'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

function hasCSourcesShallow(dir, maxDepth) {
  // Non-b01 C firmware roots (e.g. arm_other) for W1<*U pairing.
  if (!dir || !fs.existsSync(dir)) return false;
  const depth = typeof maxDepth === 'number' ? maxDepth : 3;
  const exts = new Set(['.c', '.h', '.cpp', '.hpp']);
  const stack = [{ p: dir, d: 0 }];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur.p, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const full = path.join(cur.p, ent.name);
      if (ent.isFile()) {
        if (exts.has(path.extname(ent.name).toLowerCase())) return true;
      } else if (ent.isDirectory() && cur.d < depth) {
        stack.push({ p: full, d: cur.d + 1 });
      }
    }
  }
  return false;
}

function isB01Root(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, 'Project', 'MDK-ARM(uV4)'))) return true;
  if (fs.existsSync(path.join(dir, 'Project'))) {
    if (fs.existsSync(path.join(dir, 'core')) ||
      fs.existsSync(path.join(dir, 'application')) ||
      fs.existsSync(path.join(dir, 'User')) ||
      fs.existsSync(path.join(dir, '.git'))) {
      return true;
    }
  }
  if (fs.existsSync(path.join(dir, '.zkz', '.workspace_sync_meta.json'))) return true;
  if ((fs.existsSync(path.join(dir, 'core')) || fs.existsSync(path.join(dir, 'User'))) &&
    fs.existsSync(path.join(dir, '.git'))) {
    return true;
  }
  if (fs.existsSync(path.join(dir, 'core')) || fs.existsSync(path.join(dir, 'User'))) return true;
  // Non-b01 C firmware with .git (arm_other / AT32 etc.)
  if (fs.existsSync(path.join(dir, '.git')) && hasCSourcesShallow(dir)) return true;
  return false;
}

function readSourceRootFromMeta(dir) {
  const candidates = [
    path.join(dir, '.zkz', '.workspace_sync_meta.json'),
    path.join(dir, '.workspace_sync_meta.json')
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      const src = obj && obj.sourceRoot ? String(obj.sourceRoot).trim() : '';
      if (src && fs.existsSync(src)) return src;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function convertFromUtf8Sandbox(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const fromMeta = readSourceRootFromMeta(dir);
  if (fromMeta && isB01Root(fromMeta)) return fromMeta;
  const leaf = path.basename(dir);
  if (!leaf.endsWith('U') || leaf.endsWith(' - U')) return null;
  const w1 = path.join(path.dirname(dir), leaf.slice(0, -1));
  if (!fs.existsSync(w1)) return null;
  return w1;
}

function getUtf8Path(w1) {
  return path.join(path.dirname(w1), path.basename(w1) + 'U');
}

/** Current workspace is UTF-8 sandbox (*U). False when W1 opened directly. */
function isSandboxWorkspace() {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    if (convertFromUtf8Sandbox(f.uri.fsPath)) return true;
  }
  if (folders.length) {
    let cur = folders[0].uri.fsPath;
    for (let i = 0; i < 6; i++) {
      if (convertFromUtf8Sandbox(cur)) return true;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return false;
}

function resolvePair() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) throw new Error('\u672a\u6253\u5f00\u5de5\u4f5c\u533a\u6587\u4ef6\u5939');
  for (const f of folders) {
    const p = f.uri.fsPath;
    const w1 = convertFromUtf8Sandbox(p);
    if (w1) return { w1, sandbox: p };
  }
  for (const f of folders) {
    const p = f.uri.fsPath;
    if (isB01Root(p) && !convertFromUtf8Sandbox(p)) {
      return { w1: p, sandbox: getUtf8Path(p) };
    }
  }
  let cur = folders[0].uri.fsPath;
  for (let i = 0; i < 6; i++) {
    const w1a = convertFromUtf8Sandbox(cur);
    if (w1a) return { w1: w1a, sandbox: cur };
    if (isB01Root(cur)) return { w1: cur, sandbox: getUtf8Path(cur) };
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error('\u65e0\u6cd5\u89e3\u6790\u672c\u6e90/\u6c99\u7bb1\u914d\u5bf9');
}

function assertW1Git(w1) {
  if (!fs.existsSync(w1)) throw new Error('\u672c\u6e90\u4e0d\u5b58\u5728: ' + w1);
  if (!fs.existsSync(path.join(w1, '.git'))) throw new Error('\u672c\u6e90\u4e0d\u662f Git \u4ed3\u5e93: ' + w1);
}

/** ToUtf / ToGb / pair-diff only when a *U sandbox folder is open. */
function assertSandboxSync() {
  if (isSandboxWorkspace()) return;
  throw new Error('\u8bf7\u5728 *U \u6c99\u7bb1\u5de5\u4f5c\u533a\u6267\u884c\u540c\u6b65/\u5bf9\u6bd4');
}

module.exports = {
  isB01Root,
  convertFromUtf8Sandbox,
  getUtf8Path,
  isSandboxWorkspace,
  resolvePair,
  assertW1Git,
  assertSandboxSync,
  readSourceRootFromMeta
};
