'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { libTops, DEFAULT_LIB_TOPS } = require('./paths');
const { gitConfigGet, gitConfigSet, gitConfigUnset } = require('./git_exec');

const BEGIN = '# >>> zkz-native';
const END = '# <<< zkz-native';

function isNodeExecutable(p) {
  const base = path.basename(String(p || '')).toLowerCase();
  return base === 'node.exe' || base === 'node';
}

function nodeBin() {
  const env = process.env.NODE_EXE || process.env.ZKZ_NODE;
  if (env && fs.existsSync(env)) return env.replace(/\\/g, '/');
  if (isNodeExecutable(process.execPath) && fs.existsSync(process.execPath)) {
    return process.execPath.replace(/\\/g, '/');
  }
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const r = spawnSync(cmd, ['node'], { encoding: 'utf8', windowsHide: true });
  const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (first && fs.existsSync(first)) return first.replace(/\\/g, '/');
  throw new Error('找不到 node.exe。请安装 Node，或设置环境变量 NODE_EXE');
}

function scriptPath(extensionRoot, name) {
  return path.join(extensionRoot, 'src', name).replace(/\\/g, '/');
}

function quoteCmd(bin, script) {
  return '"' + bin + '" "' + script + '"';
}

function attributesPath(repoRoot) {
  return path.join(repoRoot, '.git', 'info', 'attributes');
}

function excludePath(repoRoot) {
  return path.join(repoRoot, '.git', 'info', 'exclude');
}

function replaceMarkedBlock(text, body) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const block = BEGIN + '\n' + body.replace(/\s+$/, '') + '\n' + END + '\n';
  const re = new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?');
  if (re.test(src)) return src.replace(re, block);
  const trimmed = src.replace(/\s+$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + block;
}

function stripMarkedBlock(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const re = new RegExp('\\n*' + BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?');
  return src.replace(re, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

function attributesBody(repoRoot) {
  const lines = [
    '*.c filter=zkznative diff=zkznative -text',
    '*.h filter=zkznative diff=zkznative -text'
  ];
  const seen = new Set();
  const tops = DEFAULT_LIB_TOPS.concat(libTops(repoRoot));
  for (const top of tops) {
    const norm = String(top || '').replace(/\\/g, '/');
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(norm + '/** -filter -diff');
  }
  return lines.join('\n');
}

function excludeBody() {
  return [
    '.zkz/keil-native/',
    '.zkz/keil-native-stamp.json',
    '.zkz/.workspace_source_encodings.json',
    '.zkz/config_paths.json',
    '.zkz/zkz-native.log',
    '.zkz/native-status.json',
    '.zkz/skip-worktree-stamp.json'
  ].join('\n');
}

function writeMarkedFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur = '';
  try { if (fs.existsSync(file)) cur = fs.readFileSync(file, 'utf8'); } catch (_) { cur = ''; }
  const next = replaceMarkedBlock(cur, body);
  if (next !== cur) fs.writeFileSync(file, next.replace(/\n/g, '\r\n'), 'utf8');
}

function stripMarkedFile(file) {
  if (!fs.existsSync(file)) return;
  const cur = fs.readFileSync(file, 'utf8');
  const next = stripMarkedBlock(cur);
  if (next !== cur) fs.writeFileSync(file, next, 'utf8');
}

function installGitConfig(repoRoot, extensionRoot) {
  const bin = nodeBin();
  const filter = quoteCmd(bin, scriptPath(extensionRoot, 'filter_process.js'));
  const textconv = quoteCmd(bin, scriptPath(extensionRoot, 'textconv.js'));
  writeMarkedFile(attributesPath(repoRoot), attributesBody(repoRoot));
  writeMarkedFile(excludePath(repoRoot), excludeBody());
  gitConfigSet(repoRoot, 'filter.zkznative.process', filter);
  gitConfigSet(repoRoot, 'filter.zkznative.required', 'true');
  gitConfigSet(repoRoot, 'diff.zkznative.textconv', textconv);
  gitConfigSet(repoRoot, 'diff.zkznative.cachetextconv', 'true');
}

function uninstallGitConfig(repoRoot) {
  stripMarkedFile(attributesPath(repoRoot));
  stripMarkedFile(excludePath(repoRoot));
  gitConfigUnset(repoRoot, 'filter.zkznative.process');
  gitConfigUnset(repoRoot, 'filter.zkznative.required');
  gitConfigUnset(repoRoot, 'diff.zkznative.textconv');
  gitConfigUnset(repoRoot, 'diff.zkznative.cachetextconv');
}

function isInstalled(repoRoot) {
  const processCmd = gitConfigGet(repoRoot, 'filter.zkznative.process');
  if (!processCmd) return false;
  const attr = attributesPath(repoRoot);
  if (!fs.existsSync(attr)) return false;
  const text = fs.readFileSync(attr, 'utf8');
  return text.indexOf('filter=zkznative') >= 0;
}

function verifyGitConfig(repoRoot, extensionRoot) {
  if (!isInstalled(repoRoot)) return { ok: false, reason: 'not-installed' };
  const want = quoteCmd(nodeBin(), scriptPath(extensionRoot, 'filter_process.js'));
  const have = gitConfigGet(repoRoot, 'filter.zkznative.process') || '';
  const attrPath = attributesPath(repoRoot);
  let attr = '';
  try { attr = fs.readFileSync(attrPath, 'utf8'); } catch (_) { attr = ''; }
  const attrStale = attr.indexOf('emWin/**') < 0 || attr.indexOf('filter=zkznative') < 0;
  if (have.replace(/\\/g, '/') !== want.replace(/\\/g, '/') || attrStale) {
    installGitConfig(repoRoot, extensionRoot);
    return { ok: true, repaired: true };
  }
  return { ok: true, repaired: false };
}

module.exports = {
  BEGIN,
  END,
  replaceMarkedBlock,
  stripMarkedBlock,
  installGitConfig,
  uninstallGitConfig,
  isInstalled,
  verifyGitConfig,
  attributesPath,
  nodeBin,
  isNodeExecutable,
  scriptPath,
  quoteCmd
};
