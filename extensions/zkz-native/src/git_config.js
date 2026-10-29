'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const loadShared = require('./load_shared');
const { libTops } = require('./paths');
const { gitConfigGet, gitConfigSet, gitConfigUnset, infoGitDir } = require('./git_exec');

const BEGIN = '# >>> zkz-native';
const END = '# <<< zkz-native';
const LOCAL_BEGIN = '# >>> zkz-local';
const LOCAL_END = '# <<< zkz-local';

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
  return path.join(infoGitDir(repoRoot), 'info', 'attributes');
}

function excludePath(repoRoot) {
  return path.join(infoGitDir(repoRoot), 'info', 'exclude');
}

function escapeMarker(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceMarkedBlock(text, body, begin, end) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const b = begin || BEGIN;
  const e = end || END;
  const block = b + '\n' + String(body || '').replace(/\s+$/, '') + '\n' + e + '\n';
  const re = new RegExp(escapeMarker(b) + '[\\s\\S]*?' + escapeMarker(e) + '\\n?');
  if (re.test(src)) return src.replace(re, block);
  const trimmed = src.replace(/\s+$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + block;
}

function stripMarkedBlock(text, begin, end) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const b = begin || BEGIN;
  const e = end || END;
  const re = new RegExp('\\n*' + escapeMarker(b) + '[\\s\\S]*?' + escapeMarker(e) + '\\n?');
  return src.replace(re, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

function markedBody(text, begin, end) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const b = begin || BEGIN;
  const e = end || END;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < i) return '';
  return src.slice(i + b.length, j).replace(/^\n/, '').replace(/\s+$/, '');
}

function attributesBody(repoRoot) {
  const lines = [
    '*.c filter=zkznative diff=zkznative -text',
    '*.h filter=zkznative diff=zkznative -text'
  ];
  const seen = new Set();
  const tops = libTops(repoRoot);
  for (const top of tops) {
    const norm = String(top || '').replace(/\\/g, '/');
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // !text：取消 *.c/*.h 的 -text，库文件继续按 core.autocrlf 归一化换行
    lines.push(norm + '/** -filter -diff !text');
  }
  return lines.join('\n');
}

function excludeBody() {
  return [
    '.zkz/keil-native/',
    '.zkz/config_paths.json',
    '.zkz/settings.json',
    '.zkz/local/',
    '.zkz/run/'
  ].join('\n');
}

function writeMarkedFile(file, body, begin, end) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur = '';
  try { if (fs.existsSync(file)) cur = fs.readFileSync(file, 'utf8'); } catch (_) { cur = ''; }
  const next = replaceMarkedBlock(cur, body, begin, end);
  if (next !== cur) fs.writeFileSync(file, next.replace(/\n/g, '\r\n'), 'utf8');
}

function stripMarkedFile(file, begin, end) {
  if (!fs.existsSync(file)) return;
  const cur = fs.readFileSync(file, 'utf8');
  const next = stripMarkedBlock(cur, begin, end);
  if (next !== cur) fs.writeFileSync(file, next, 'utf8');
}

function legacyLocalFilter(repoRoot) {
  return !!String(gitConfigGet(repoRoot, 'filter.zkzlocal.process') || '').trim();
}

function isLocalInstalled(repoRoot) {
  return gitConfigGet(repoRoot, 'zkz.localconfig') === 'true' || legacyLocalFilter(repoRoot);
}

// .zkz/settings.json 的 native.local。没有这项时沿用当前 git 开关，避免补默认值时把已打开的关掉。
function localSwitchWanted(repoRoot) {
  const settings = loadShared('zkz_settings');
  const cur = settings.load(repoRoot);
  const native = cur && cur.native;
  if (!native || !Object.prototype.hasOwnProperty.call(native, 'local')) {
    const on = isLocalInstalled(repoRoot);
    settings.set(repoRoot, 'native', 'local', on);
    return on;
  }
  settings.ensure(repoRoot);
  return settings.get(repoRoot, 'native', 'local', false) === true;
}

function applyLocalSwitch(repoRoot, extensionRoot) {
  const want = localSwitchWanted(repoRoot);
  const on = isLocalInstalled(repoRoot);
  if (want && !on) installLocalConfig(repoRoot, extensionRoot);
  else if (!want && on) uninstallLocalConfig(repoRoot);
  else if (want) verifyLocalConfig(repoRoot, extensionRoot);
  return want;
}

function clearLegacyLocalFilter(repoRoot) {
  stripMarkedFile(attributesPath(repoRoot), LOCAL_BEGIN, LOCAL_END);
  gitConfigUnset(repoRoot, 'filter.zkzlocal.process');
  gitConfigUnset(repoRoot, 'filter.zkzlocal.required');
}

function installLocalConfig(repoRoot, extensionRoot) {
  const local = require('./local_filter');
  clearLegacyLocalFilter(repoRoot);
  writeMarkedFile(excludePath(repoRoot), excludeBody());
  gitConfigSet(repoRoot, 'zkz.localconfig', 'true');
  try { local.applySkipWorktree(repoRoot); } catch (_) { /* 位打不上不挡开关 */ }
  try { local.stopLocalWatch(repoRoot); } catch (_) { /* 旧监视停不掉不挡开关 */ }
  try { require('./git_shim').ensureGitShim(extensionRoot); } catch (_) { /* 替身编不出来不挡开关 */ }
  try { require('./hooks').installHooks(repoRoot, extensionRoot); } catch (_) { /* 钩子装不上不挡开关 */ }
}

function uninstallLocalConfig(repoRoot) {
  const local = require('./local_filter');
  try { local.stopLocalWatch(repoRoot); } catch (_) { /* ignore */ }
  try { local.clearSkipWorktree(repoRoot); } catch (_) { /* ignore */ }
  gitConfigUnset(repoRoot, 'zkz.localconfig');
  clearLegacyLocalFilter(repoRoot);
  if (!isInstalled(repoRoot)) {
    stripMarkedFile(excludePath(repoRoot));
    try { require('./hooks').uninstallHooks(repoRoot); } catch (_) { /* ignore */ }
  }
}

function verifyLocalConfig(repoRoot, extensionRoot) {
  if (!isLocalInstalled(repoRoot)) {
    const attrPath = attributesPath(repoRoot);
    let attr = '';
    try { attr = fs.readFileSync(attrPath, 'utf8'); } catch (_) { attr = ''; }
    if (attr.indexOf(LOCAL_BEGIN) >= 0) stripMarkedFile(attrPath, LOCAL_BEGIN, LOCAL_END);
    return { ok: false, reason: 'not-installed' };
  }
  let attr = '';
  try { attr = fs.readFileSync(attributesPath(repoRoot), 'utf8'); } catch (_) { attr = ''; }
  let ex = '';
  try { ex = fs.readFileSync(excludePath(repoRoot), 'utf8'); } catch (_) { ex = ''; }
  const stale = gitConfigGet(repoRoot, 'zkz.localconfig') !== 'true'
    || legacyLocalFilter(repoRoot)
    || markedBody(attr, LOCAL_BEGIN, LOCAL_END) !== ''
    || markedBody(ex) !== excludeBody().replace(/\s+$/, '');
  if (stale) {
    installLocalConfig(repoRoot, extensionRoot);
    return { ok: true, repaired: true };
  }
  try { require('./local_filter').applySkipWorktree(repoRoot); } catch (_) { /* 位打不上留到下次 */ }
  return { ok: true, repaired: false };
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
  const { appendLog } = require('./paths');
  appendLog(repoRoot, 'git filter installed required=true node=' + bin);
}

function uninstallGitConfig(repoRoot) {
  stripMarkedFile(attributesPath(repoRoot));
  gitConfigUnset(repoRoot, 'filter.zkznative.process');
  gitConfigUnset(repoRoot, 'filter.zkznative.required');
  gitConfigUnset(repoRoot, 'diff.zkznative.textconv');
  gitConfigUnset(repoRoot, 'diff.zkznative.cachetextconv');
  if (!isLocalInstalled(repoRoot)) stripMarkedFile(excludePath(repoRoot));
}

function isInstalled(repoRoot) {
  return loadShared('native_installed').isNativeInstalled(repoRoot);
}

function quotedPaths(cmd) {
  const out = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(String(cmd || ''))) !== null) out.push(m[1]);
  return out;
}

function commandPathsExist(cmd) {
  const paths = quotedPaths(cmd);
  if (!paths.length) return false;
  for (let i = 0; i < paths.length; i++) {
    if (!fs.existsSync(paths[i])) return false;
  }
  return true;
}

function verifyGitConfig(repoRoot, extensionRoot) {
  if (!isInstalled(repoRoot)) return { ok: false, reason: 'not-installed' };
  const bin = nodeBin();
  const want = quoteCmd(bin, scriptPath(extensionRoot, 'filter_process.js'));
  const wantConv = quoteCmd(bin, scriptPath(extensionRoot, 'textconv.js'));
  const have = gitConfigGet(repoRoot, 'filter.zkznative.process') || '';
  const haveConv = gitConfigGet(repoRoot, 'diff.zkznative.textconv') || '';
  const attrPath = attributesPath(repoRoot);
  let attr = '';
  try { attr = fs.readFileSync(attrPath, 'utf8'); } catch (_) { attr = ''; }
  const haveBody = markedBody(attr);
  const wantBody = attributesBody(repoRoot).replace(/\s+$/, '');
  const attrStale = haveBody !== wantBody || attr.indexOf('filter=zkznative') < 0;
  const exPath = excludePath(repoRoot);
  let ex = '';
  try { ex = fs.readFileSync(exPath, 'utf8'); } catch (_) { ex = ''; }
  const exStale = markedBody(ex) !== excludeBody().replace(/\s+$/, '');
  const pathMissing = !commandPathsExist(have) || !commandPathsExist(haveConv);
  const cmdStale = have.replace(/\\/g, '/') !== want.replace(/\\/g, '/')
    || haveConv.replace(/\\/g, '/') !== wantConv.replace(/\\/g, '/');
  if (cmdStale || attrStale || pathMissing || exStale) {
    installGitConfig(repoRoot, extensionRoot);
    const { appendLog } = require('./paths');
    appendLog(repoRoot, 'git config repaired pathMissing=' + pathMissing + ' attrStale=' + attrStale);
    return { ok: true, repaired: true, pathMissing: pathMissing };
  }
  return { ok: true, repaired: false };
}

module.exports = {
  BEGIN,
  END,
  LOCAL_BEGIN,
  LOCAL_END,
  replaceMarkedBlock,
  stripMarkedBlock,
  markedBody,
  installGitConfig,
  uninstallGitConfig,
  installLocalConfig,
  uninstallLocalConfig,
  applyLocalSwitch,
  isLocalInstalled,
  verifyLocalConfig,
  isInstalled,
  verifyGitConfig,
  commandPathsExist,
  quotedPaths,
  attributesPath,
  excludePath,
  attributesBody,
  nodeBin,
  isNodeExecutable,
  scriptPath,
  quoteCmd
};
