'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const loadShared = require('./load_shared');
const { resolvePair } = loadShared('pair');
const { resolveKeilLayout } = require('./keil_layout');
const { isNativeInstalled } = loadShared('native_installed');
const { getJLinkFlashTool, jlinkGdbServerPath, invokeJLinkHexFlash } = require('./keil_flash');

let iconv = null;
try { iconv = require('iconv-lite'); } catch (_) { iconv = null; }

function normalizeEmitText(msg) {
  const s = String(msg == null ? '' : msg);
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function decodeGbk(buf) {
  if (!buf || !buf.length) return '';
  if (iconv) {
    try { return iconv.decode(buf, 'gbk'); } catch (_) { /* fall */ }
  }
  return buf.toString('latin1');
}

function getUv4Path(root) {
  const cfg = require('./keil_config');
  const p = String(cfg.get(root, 'uv4Path', '') || '').trim().replace(/^["']|["']$/g, '');
  if (p && fs.existsSync(p)) return path.resolve(p);
  throw new Error('找不到 Keil UV4.exe，请在 .zkz/settings.json 设置 keil.uv4Path。');
}

function resolveTarget(layout) {
  if (layout.flavor === 'h750') return layout.defaultTarget || 'H750_N';
  return layout.defaultTarget || '';
}

function keilNativeRootOf(projectDir) {
  const parts = path.resolve(projectDir).split(path.sep);
  const lower = parts.map((p) => p.toLowerCase());
  for (let i = 0; i < parts.length - 1; i++) {
    if (lower[i] === '.zkz' && lower[i + 1] === 'keil-native') {
      return {
        workspace: parts.slice(0, i).join(path.sep),
        kn: parts.slice(0, i + 2).join(path.sep)
      };
    }
  }
  return null;
}

function stripKeilNative(text, projectDir) {
  const loc = keilNativeRootOf(projectDir);
  if (!loc || !text) return text;
  const pattern = loc.kn.split(/[\\/]/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
  return String(text).replace(new RegExp(pattern, 'gi'), loc.workspace);
}

function absLogText(text, projectDir) {
  if (!text || !projectDir) return text;
  let out = String(text).replace(/^(\.\.[\\/][^\(\r\n]+)\((\d+)\):/gm, (m, rel, line) => {
    try { return path.resolve(projectDir, rel) + '(' + line + '):'; } catch (_) { return m; }
  });
  out = out.replace(/(\.\.[\\/](?:[^\s"'()\r\n]+[\\/])*[^\s"'()\r\n]+\.[A-Za-z0-9]+)/g, (rel) => {
    try { return path.resolve(projectDir, rel); } catch (_) { return rel; }
  });
  return stripKeilNative(out, projectDir);
}

function throwIfCancelled(token) {
  if (token && token.isCancellationRequested) throw new Error('\u5df2\u53d6\u6d88');
}

function quietCancel() {
  const err = new Error('\u5df2\u53d6\u6d88');
  err.zkzQuiet = true;
  throw err;
}

function report(progress, message) {
  if (progress && typeof progress.report === 'function') progress.report({ message: message });
}

/** 「编译调试」不确认机型。调试会话还在时问是否断开。扩展宿主线程调用。 */
async function confirmDebugDisconnect() {
  if (!vscode.debug.activeDebugSession) return;
  const pick = await vscode.window.showWarningMessage(
    '烧录会断开当前调试，继续？',
    { modal: true },
    '继续烧录'
  );
  if (pick !== '继续烧录') quietCancel();
}

/** 把 GBK 缓冲切成完整字节和末尾半个汉字。编译日志分段解码时调用。扩展宿主线程调用。 */
function takeCompleteGbk(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  let i = 0;
  while (i < data.length) {
    const b = data[i];
    if (b >= 0x81 && b <= 0xFE) {
      if (i + 1 >= data.length) return { done: data.slice(0, i), rest: data.slice(i) };
      i += 2;
    } else {
      i += 1;
    }
  }
  return { done: data, rest: Buffer.alloc(0) };
}

async function prepareBuildTree(pair, emit) {
  if (!isNativeInstalled(pair.root)) {
    emit('zkz-native off; build true source');
    return { native: false };
  }
  emit('zkz-native: sync keil-native from worktree');
  emit('zkz-native.syncKeilTree');
  await vscode.commands.executeCommand('zkz-native.syncKeilTree');
  return { native: true };
}

function resolveBuildLayout(root, native) {
  // 布局在 extensions/shared/keil_layout.js。这里只在已解析结果上叠 keil-native 前缀。
  const layout = resolveKeilLayout(root);
  if (!native) return Object.assign({ buildRoot: root }, layout);
  const buildRoot = path.join(root, '.zkz', 'keil-native');
  const relDir = path.relative(root, layout.projectDir);
  const relFile = path.relative(root, layout.projectFile);
  return Object.assign({}, layout, {
    buildRoot: buildRoot,
    projectDir: path.join(buildRoot, relDir),
    projectFile: path.join(buildRoot, relFile)
  });
}

function copyBuildArtifacts(root, layout, emit) {
  const kn = path.join(root, '.zkz', 'keil-native');
  for (const rel of [layout.relAxf, layout.relHex]) {
    const src = path.join(kn, rel);
    const dst = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    if (emit) emit('  artifact -> ' + rel);
  }
}

function spawnUv4(keilExe, args, logFile, projectDir, token, emit) {
  return new Promise((resolve, reject) => {
    try { if (fs.existsSync(logFile)) fs.unlinkSync(logFile); } catch (_) { /* ignore */ }
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, Buffer.alloc(0));
    const child = spawn(keilExe, args, { windowsHide: true });
    let pos = 0;
    let stopped = false;
    let cancelled = false;
    let pending = Buffer.alloc(0);
    const readTail = (final) => {
      try {
        const st = fs.statSync(logFile);
        let buf = Buffer.alloc(0);
        if (st.size > pos) {
          const fd = fs.openSync(logFile, 'r');
          buf = Buffer.alloc(st.size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          fs.closeSync(fd);
          pos = st.size;
        } else if (!final || !pending.length) return;
        const merged = pending.length ? Buffer.concat([pending, buf]) : buf;
        const split = final ? { done: merged, rest: Buffer.alloc(0) } : takeCompleteGbk(merged);
        pending = split.rest;
        if (!split.done.length) return;
        const chunk = absLogText(decodeGbk(split.done), projectDir);
        if (chunk) emit(normalizeEmitText(chunk).replace(/\n$/, ''));
      } catch (_) { /* log still locked by UV4 */ }
    };
    const timer = setInterval(() => readTail(false), 500);
    const cancel = () => {
      if (stopped) return;
      cancelled = true;
      try { child.kill(); } catch (_) { /* ignore */ }
    };
    if (token) {
      if (token.isCancellationRequested) cancel();
      else token.onCancellationRequested(cancel);
    }
    const settle = (fn) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      fn();
    };
    child.on('error', (e) => {
      settle(() => reject(e));
    });
    child.on('close', (code) => {
      settle(() => {
        readTail(true);
        if (cancelled || (token && token.isCancellationRequested)) {
          reject(new Error('\u5df2\u53d6\u6d88'));
          return;
        }
        resolve(code == null ? 1 : code);
      });
    });
  });
}

/** 按 UV4 退出码给出编译成败，末尾原样再列报错和警告，便于从终端跳到源文件。扩展宿主线程调用。 */
function summarizeBuild(logFile, projectDir, keilCode, emit) {
  let hasErrors = false;
  let hasWarnings = false;
  const errorLines = [];
  const warningLines = [];
  if (fs.existsSync(logFile)) {
    const content = absLogText(decodeGbk(fs.readFileSync(logFile)), projectDir);
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/error/i.test(line) && !/error\(s\)/i.test(line) && !/\d+ error/i.test(line)) {
        hasErrors = true;
        errorLines.push(line);
      } else if (/warning/i.test(line) && !/warning\(s\)/i.test(line) && !/\d+ warning/i.test(line)) {
        hasWarnings = true;
        warningLines.push(line);
      }
    }
  }
  if (errorLines.length || warningLines.length) {
    emit('---------- 编译摘要 ----------');
    errorLines.forEach((l) => emit(l));
    warningLines.forEach((l) => emit(l));
    emit('------------------------------');
  }
  let exitCode = 0;
  if (keilCode === 2 || keilCode === 3) exitCode = 1;
  else if ((keilCode == null || keilCode > 3) && hasErrors) exitCode = 1;
  if (keilCode === 0) emit(' 编译成功（无警告）');
  else if (keilCode === 1) emit(' 编译成功（有警告）');
  else if (keilCode === 2) emit(' 编译失败（有错误）');
  else if (keilCode === 3) emit(' 编译失败（致命错误）');
  else if (hasErrors) emit(' 编译失败（日志里有错误）');
  else if (hasWarnings) emit(' 编译成功（有警告）');
  else emit(' 编译结束，退出码 ' + keilCode);
  return exitCode;
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** 把源路径映射写到仓库 .zkz/gdb_source_map.gdb。扩展宿主线程调用。 */
function writeGdbMapFiles(root, mapText) {
  writeText(path.join(root, '.zkz', 'gdb_source_map.gdb'), mapText);
}

function copyDebugAxfLocal(root, emit) {
  const layout = resolveKeilLayout(root);
  const src = path.join(root, layout.relAxf);
  if (!fs.existsSync(src)) return false;
  const dst = path.join(root, '.zkz', 'output.axf');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) {
    try { if (fs.lstatSync(dst).isSymbolicLink()) fs.unlinkSync(dst); } catch (_) { /* ignore */ }
  }
  fs.copyFileSync(src, dst);
  if (emit) emit('  axf -> .zkz/output.axf');
  return true;
}

async function publishDebugArtifacts(root, emit) {
  const copied = copyDebugAxfLocal(root, emit);
  if (!copied) {
    const stub = '# zkz-keil: gdb map skipped (no output.axf)\n';
    writeGdbMapFiles(root, stub);
    emit('  gdb map skipped; debug continues without substitute-path');
    return;
  }

  const rootFwd = root.replace(/\\/g, '/');
  const rootLow = rootFwd.charAt(0).toLowerCase() + rootFwd.slice(1);
  const knFwd = (rootFwd + '/.zkz/keil-native').replace(/\/+/g, '/');
  const knLow = knFwd.charAt(0).toLowerCase() + knFwd.slice(1);
  const nativeOn = isNativeInstalled(root);
  const mapText = nativeOn ? [
    '# Auto-generated by zkz-keil (keil-native)',
    'set substitute-path "' + knFwd + '" "' + rootFwd + '"',
    'set substitute-path "' + knLow + '" "' + rootLow + '"',
    'directory "' + rootFwd + '"',
    'directory "' + rootFwd + '/User"',
    'directory "' + rootFwd + '/core"',
    ''
  ].join('\n') : [
    '# Auto-generated by zkz-keil (native filter off; no keil-native map)',
    'directory "' + rootFwd + '"',
    'directory "' + rootFwd + '/User"',
    'directory "' + rootFwd + '/core"',
    ''
  ].join('\n');
  writeGdbMapFiles(root, mapText);
  if (nativeOn) emit('  gdb map keil-native -> true source');
  else emit('  gdb map true source only (native filter off)');
}

async function runBuild(pair, mode, token, emit, progress) {
  throwIfCancelled(token);
  report(progress, mode === 'rebuild' ? '重新编译' : '编译中');
  const prep = await prepareBuildTree(pair, emit);
  throwIfCancelled(token);
  const layout = resolveBuildLayout(pair.root, !!(prep && prep.native));
  if (!fs.existsSync(layout.projectFile)) {
    throw new Error('找不到 Keil 工程：' + layout.projectFile);
  }
  const keilExe = getUv4Path(pair.root);
  const target = resolveTarget(layout);
  const logFile = path.join(layout.projectDir, 'build_output.txt');
  const flag = mode === 'rebuild' ? '-r' : '-b';
  const args = [flag, layout.projectFile];
  if (target) args.push('-t', target);
  args.push('-j0', '-o', logFile);
  emit('============================================');
  emit(' ' + (mode === 'rebuild' ? '重新编译' : '编译') + (target ? ('  目标: ' + target) : '  （Keil 当前目标）'));
  emit(' 工程: ' + pair.root);
  if (prep && prep.native) emit(' 编烧树: ' + layout.buildRoot);
  emit(' UV4: ' + keilExe);
  emit('============================================');
  emit('');
  const keilCode = await spawnUv4(keilExe, args, logFile, layout.projectDir, token, emit);
  emit('');
  emit('============================================');
  const exitCode = summarizeBuild(logFile, layout.projectDir, keilCode, emit);
  if (!exitCode && prep && prep.native) copyBuildArtifacts(pair.root, layout, emit);
  emit(' 编译结束: ' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  return exitCode;
}

/** 用 J-Link 烧录当前 hex。状态栏烧录直接开始；编译调试在会话还在时问是否断开。扩展宿主线程调用。 */
async function performFlash(pair, token, emit, progress, confirmDebug) {
  throwIfCancelled(token);
  if (confirmDebug) await confirmDebugDisconnect();
  report(progress, '烧录中');
  const layout = resolveKeilLayout(pair.root);
  const hexPath = path.join(pair.root, layout.relHex);
  if (!fs.existsSync(hexPath)) throw new Error('还没有 hex，请先编译：' + hexPath);
  const tool = getJLinkFlashTool(pair.root, layout.flavor);
  const logFile = path.join(pair.root, '.zkz', 'jlink_flash', 'flash_output.txt');
  emit('============================================');
  emit(' 烧录  机型: ' + layout.flavor);
  emit(' 工程: ' + pair.root);
  emit(' HEX: ' + hexPath);
  if (layout.flavor === 'f429') {
    emit(' 应用在 0x0800C000，不会整片擦除；boot 为 0x08000000-0x0800BFFF');
  }
  if (layout.flavor === 'h750') {
    emit(' 应用在 0x90000000 QSPI W25Q32，不擦除；boot 仍在 0x08000000');
  }
  emit('============================================');
  emit('');
  const result = await invokeJLinkHexFlash({
    tool,
    hexPath,
    root: pair.root,
    logFile,
    log: emit,
    token,
    progress
  });
  emit('');
  emit('============================================');
  if (!result.failed) {
    emit(' 烧录成功');
    return 0;
  }
  emit(' 烧录失败（退出码 ' + result.exitCode + '）');
  return 1;
}

async function runPrepare(pair, emit) {
  emit('准备调试');
  const { folderForRoot } = loadShared('project_root');
  const opened = folderForRoot(
    (vscode.workspace.workspaceFolders || []).map(function (f) { return f.uri.fsPath; }),
    pair.root
  );
  emit('  已打开: ' + opened);
  emit('  真源: ' + pair.root);
  await publishDebugArtifacts(pair.root, emit);
  emit('完成');
  return 0;
}

async function runKeilAction(action, opts) {
  const emit = opts && opts.log ? opts.log : function () { };
  const token = opts && opts.token;
  const progress = opts && opts.progress;
  const pair = resolvePair();
  if (action === 'build') return runBuild(pair, 'build', token, emit, progress);
  if (action === 'rebuild') return runBuild(pair, 'rebuild', token, emit, progress);
  if (action === 'flash') return performFlash(pair, token, emit, progress, false);
  if (action === 'prepare') return runPrepare(pair, emit);
  if (action === 'buildFlashPrepare') {
    const b = await runBuild(pair, 'build', token, emit, progress);
    if (b) return b;
    const f = await performFlash(pair, token, emit, progress, true);
    if (f) return f;
    return runPrepare(pair, emit);
  }
  throw new Error('未知的 Keil 动作：' + action);
}

function currentJlinkGdbServerPath() {
  const root = resolvePair().root;
  return jlinkGdbServerPath(root, resolveKeilLayout(root).flavor);
}

function currentGdbPath() {
  return require('./keil_launch').findGdb(resolvePair().root);
}

function currentDebugConfigValue(kind) {
  const root = resolvePair().root;
  const flavor = resolveKeilLayout(root).flavor;
  if (kind === 'device') {
    const cfg = require('./keil_config');
    return String(cfg.get(root, flavor === 'h750' ? 'h750.device' : 'f429.device', flavor === 'h750' ? 'STM32H750IB' : 'STM32F429BI'));
  }
  const launch = require('./keil_launch');
  const value = launch.findSvd(root, flavor);
  if (!value) throw new Error('找不到 ' + flavor + ' 的 SVD，请设置 keil.' + flavor + '.svdFile 或 keil.packRoot');
  return value;
}

function currentDebugSpeed() {
  const root = resolvePair().root;
  return String(require('./keil_config').getNumber(root, 'debugSpeedKHz', 4000));
}

function activate(context) {
  const tasks = () => require('./keil_tasks');
  const safe = (fn) => async () => {
    try { await fn(); }
    catch (e) {
      if (e && e.zkzQuiet) return;
      vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('zkz-keil.keilBuild', safe(() => tasks().runTask('build'))),
    vscode.commands.registerCommand('zkz-keil.keilRebuild', safe(() => tasks().runTask('rebuild'))),
    vscode.commands.registerCommand('zkz-keil.keilFlash', safe(() => tasks().runTask('flash'))),
    vscode.commands.registerCommand('zkz-keil.prepareCortexDebug', safe(() => tasks().runTask('prepare'))),
    vscode.commands.registerCommand('zkz-keil.configureLaunch', safe(async () => {
      const info = require('./keil_launch').writeLaunchJson(resolvePair().root);
      const svd = info.svdFile || 'SVD 未找到';
      vscode.window.showInformationMessage(
        '已写入 .vscode/launch.json（' + info.flavor + '，' + info.device + '，' + svd + '）'
      );
    })),
    vscode.commands.registerCommand('zkz-keil.resolveLayout', () => {
      try {
        return resolveKeilLayout(resolvePair().root);
      } catch (_) {
        return null;
      }
    }),
    vscode.commands.registerCommand('zkz-keil.jlinkGdbServerPath', () => currentJlinkGdbServerPath()),
    vscode.commands.registerCommand('zkz-keil.gdbPath', () => currentGdbPath()),
    vscode.commands.registerCommand('zkz-keil.device', () => currentDebugConfigValue('device')),
    vscode.commands.registerCommand('zkz-keil.svdFile', () => currentDebugConfigValue('svdFile')),
    vscode.commands.registerCommand('zkz-keil.debugSpeed', () => currentDebugSpeed())
  );
}

module.exports = { activate, runKeilAction, summarizeBuild, normalizeEmitText, takeCompleteGbk };
