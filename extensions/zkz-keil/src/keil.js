'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolvePair, resolvePairPreferred } = require('./pair');
const { resolveKeilLayout } = require('./keil_layout');
const { getJLinkFlashTool, stopJLinkGdbServer, invokeJLinkHexFlash } = require('./keil_flash');

const output = vscode.window.createOutputChannel('zkz Keil');
let iconv = null;
try { iconv = require('iconv-lite'); } catch (_) { iconv = null; }

function outLog(msg) {
  const line = String(msg == null ? '' : msg);
  output.appendLine(line);
}

function decodeGbk(buf) {
  if (!buf || !buf.length) return '';
  if (iconv) {
    try { return iconv.decode(buf, 'gbk'); } catch (_) { /* fall */ }
  }
  return buf.toString('latin1');
}

function getUv4Path() {
  const cfg = require('./keil_config');
  const cands = [
    cfg.get('uv4Path', ''),
    process.env.ZKZ_KEIL_UV4,
    'D:\\ruanjian\\keil\\UV4\\UV4.exe',
    'C:\\Keil_v5\\UV4\\UV4.exe',
    'C:\\Keil\\UV4\\UV4.exe'
  ];
  for (const c of cands) {
    const p = String(c || '').trim().replace(/^["']|["']$/g, '');
    if (p && fs.existsSync(p)) return path.resolve(p);
  }
  throw new Error('Keil UV4.exe not found. Set zkz-keil.uv4Path or env ZKZ_KEIL_UV4.');
}

function resolveTarget(layout) {
  if (layout.flavor === 'h750') return layout.defaultTarget || 'H750_N';
  return layout.defaultTarget || '';
}

function absLogText(text, projectDir) {
  if (!text || !projectDir) return text;
  return String(text).replace(/^(\.\.[\\/][^\(\r\n]+)\((\d+)\):/gm, (m, rel, line) => {
    try { return path.resolve(projectDir, rel) + '(' + line + '):'; } catch (_) { return m; }
  });
}

function throwIfCancelled(token) {
  if (token && token.isCancellationRequested) throw new Error('\u5df2\u53d6\u6d88');
}

async function invokeOptional(commandId, emit) {
  let ids = [];
  try { ids = await vscode.commands.getCommands(true); } catch (_) { ids = []; }
  if (ids.indexOf(commandId) < 0) return { found: false, result: undefined };
  if (emit) emit(commandId);
  const result = await vscode.commands.executeCommand(commandId);
  return { found: true, result: result };
}

function nativeInstalledOnDisk(root) {
  try {
    const attr = path.join(root, '.git', 'info', 'attributes');
    if (!fs.existsSync(attr)) return false;
    return fs.readFileSync(attr, 'utf8').indexOf('filter=zkznative') >= 0;
  } catch (_) {
    return false;
  }
}

async function isNativeEnabled(pair) {
  const r = await invokeOptional('zkz-native.isEnabled', null);
  if (r.found) return !!r.result;
  return nativeInstalledOnDisk(pair.root);
}

async function prepareBuildTree(pair, emit) {
  if (await isNativeEnabled(pair)) {
    emit('zkz-native: sync keil-native from worktree');
    const r = await invokeOptional('zkz-native.syncKeilTree', emit);
    if (!r.found) {
      emit('zkz-native filter is on but extension command missing; build true source');
      return { native: false };
    }
    return { native: true };
  }
  emit('zkz-native off; build true source');
  return { native: false };
}

function resolveBuildLayout(root, native) {
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
    const readTail = () => {
      try {
        const st = fs.statSync(logFile);
        if (st.size <= pos) return;
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(st.size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = st.size;
        const chunk = absLogText(decodeGbk(buf), projectDir);
        if (chunk) emit(chunk.replace(/\r?\n$/, ''));
      } catch (_) { /* log still locked by UV4 */ }
    };
    const timer = setInterval(readTail, 500);
    const cancel = () => {
      if (stopped) return;
      try { child.kill(); } catch (_) { /* ignore */ }
    };
    if (token) {
      if (token.isCancellationRequested) { cancel(); }
      else token.onCancellationRequested(cancel);
    }
    child.on('error', (e) => {
      stopped = true;
      clearInterval(timer);
      reject(e);
    });
    child.on('close', (code) => {
      stopped = true;
      clearInterval(timer);
      readTail();
      resolve(code == null ? 1 : code);
    });
  });
}

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
  if (hasErrors || hasWarnings) {
    emit('---------- Build Summary ----------');
    if (hasErrors) {
      emit(' Errors:');
      errorLines.forEach((l) => emit('  [ERR] ' + l));
    }
    if (hasWarnings) {
      emit(' Warnings:');
      warningLines.forEach((l) => emit('  [WARN] ' + l));
    }
    emit('-----------------------------------');
  }
  let exitCode = 0;
  if (keilCode === 2 || keilCode === 3) exitCode = 1;
  else if ((keilCode == null || keilCode > 3) && hasErrors) exitCode = 1;
  if (keilCode === 0) emit(' BUILD SUCCESS (0 warnings)');
  else if (keilCode === 1) emit(' BUILD SUCCESS (with warnings)');
  else if (keilCode === 2) emit(' BUILD FAILED (errors)');
  else if (keilCode === 3) emit(' BUILD FAILED (fatal errors)');
  else if (hasErrors) emit(' BUILD FAILED (errors in log)');
  else if (hasWarnings) emit(' BUILD SUCCESS (with warnings)');
  else emit(' BUILD ended with code ' + keilCode);
  return exitCode;
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function writeGdbMapFiles(root, layout, mapText) {
  writeText(path.join(root, '.zkz', 'gdb_source_map.gdb'), mapText);
  writeText(path.join(root, layout.relMap), mapText);
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

async function publishDebugArtifacts(root, layout, emit) {
  let copied = false;
  const nativeCopy = await invokeOptional('zkz-native.copyDebugAxf', emit);
  if (nativeCopy.found) copied = true;
  else copied = copyDebugAxfLocal(root, emit);
  if (!copied) {
    const stub = '# zkz-keil: gdb map skipped (no output.axf)\n';
    writeGdbMapFiles(root, layout, stub);
    emit('  gdb map skipped; debug continues without substitute-path');
    return;
  }

  const rootFwd = root.replace(/\\/g, '/');
  const rootLow = rootFwd.charAt(0).toLowerCase() + rootFwd.slice(1);
  const knFwd = (rootFwd + '/.zkz/keil-native').replace(/\/+/g, '/');
  const knLow = knFwd.charAt(0).toLowerCase() + knFwd.slice(1);
  const nativeOn = await isNativeEnabled({ root: root });
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
  writeGdbMapFiles(root, layout, mapText);
  if (nativeOn) emit('  gdb map keil-native -> true source');
  else emit('  gdb map true source only (native filter off)');
}

async function resolveWorkspace() {
  return resolvePairPreferred();
}

async function runBuild(pair, mode, token, emit) {
  throwIfCancelled(token);
  const prep = await prepareBuildTree(pair, emit);
  throwIfCancelled(token);
  const layout = resolveBuildLayout(pair.root, !!(prep && prep.native));
  if (!fs.existsSync(layout.projectFile)) {
    throw new Error('Keil project not found: ' + layout.projectFile);
  }
  const keilExe = getUv4Path();
  const target = resolveTarget(layout);
  const logFile = path.join(layout.projectDir, 'build_output.txt');
  const flag = mode === 'rebuild' ? '-r' : '-b';
  const args = [flag, layout.projectFile];
  if (target) args.push('-t', target);
  args.push('-j0', '-o', logFile);
  emit('============================================');
  emit(' Keil ' + mode.toUpperCase() + (target ? ('  Target: ' + target) : '  (Keil active Target)'));
  emit(' Workspace: ' + pair.root);
  if (prep && prep.native) emit(' Keil tree: ' + layout.buildRoot);
  emit(' UV4: ' + keilExe);
  emit('============================================');
  emit('');
  const keilCode = await spawnUv4(keilExe, args, logFile, layout.projectDir, token, emit);
  if (prep && prep.native) copyBuildArtifacts(pair.root, layout, emit);
  emit('');
  emit('============================================');
  const exitCode = summarizeBuild(logFile, layout.projectDir, keilCode, emit);
  emit(' Build finished at: ' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  return exitCode;
}

async function runFlash(pair, token, emit) {
  throwIfCancelled(token);
  const layout = resolveKeilLayout(pair.root);
  const hexPath = path.join(pair.root, layout.relHex);
  if (!fs.existsSync(hexPath)) throw new Error('HEX not found, build first: ' + hexPath);
  const tool = getJLinkFlashTool(layout.flavor);
  await stopJLinkGdbServer(emit);
  const logFile = path.join(layout.projectDir, 'flash_output.txt');
  emit('============================================');
  emit(' J-Link Flash  Flavor: ' + layout.flavor);
  emit(' Workspace: ' + pair.root);
  emit(' HEX: ' + hexPath);
  if (layout.flavor === 'f429') {
    emit(' App @ 0x0800C000  (do NOT chip-erase; boot is 0x08000000-0x0800BFFF)');
  }
  if (layout.flavor === 'h750') {
    emit(' App @ 0x90000000 QSPI W25Q32  (same as Keil JL2CM3; no erase; boot stays 0x08000000)');
  }
  emit('============================================');
  emit('');
  const result = await invokeJLinkHexFlash({
    tool,
    hexPath,
    workDir: layout.projectDir,
    logFile,
    log: emit,
    token
  });
  emit('');
  emit('============================================');
  if (!result.failed) {
    emit(' FLASH SUCCESS');
    return 0;
  }
  emit(' FLASH FAILED (exit code: ' + result.exitCode + ')');
  return 1;
}

async function runPrepare(pair, emit) {
  const layout = resolveKeilLayout(pair.root);
  emit('Prepare Cortex Debug');
  emit('  Opened:  ' + ((vscode.workspace.workspaceFolders || [])[0]
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : ''));
  emit('  Keil/true source: ' + pair.root);
  await publishDebugArtifacts(pair.root, layout, emit);
  emit('Done.');
  return 0;
}

async function runKeilAction(action, opts) {
  const emit = opts && opts.log ? opts.log : outLog;
  const token = opts && opts.token;
  const pair = await resolveWorkspace();
  if (action === 'build') return runBuild(pair, 'build', token, emit);
  if (action === 'rebuild') return runBuild(pair, 'rebuild', token, emit);
  if (action === 'flash') return runFlash(pair, token, emit);
  if (action === 'prepare') return runPrepare(pair, emit);
  if (action === 'buildFlash') {
    const b = await runBuild(pair, 'build', token, emit);
    if (b) return b;
    return runFlash(pair, token, emit);
  }
  if (action === 'buildFlashPrepare') {
    const b = await runBuild(pair, 'build', token, emit);
    if (b) return b;
    const f = await runFlash(pair, token, emit);
    if (f) return f;
    return runPrepare(pair, emit);
  }
  if (action === 'flashPrepare') {
    const f = await runFlash(pair, token, emit);
    if (f) return f;
    return runPrepare(pair, emit);
  }
  throw new Error('unknown keil action: ' + action);
}

function activate(context) {
  const wrap = (action, title) => async () => {
    output.show(true);
    const code = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: title, cancellable: true },
      (_p, token) => runKeilAction(action, { log: outLog, token })
    );
    if (code) throw new Error(title + ' failed');
  };
  const safe = (fn) => async () => {
    try { await fn(); }
    catch (e) { vscode.window.showErrorMessage(String(e && e.message ? e.message : e)); }
  };
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('zkz-keil.keilBuild', safe(wrap('build', 'Keil Build'))),
    vscode.commands.registerCommand('zkz-keil.keilRebuild', safe(wrap('rebuild', 'Keil Rebuild'))),
    vscode.commands.registerCommand('zkz-keil.keilFlash', safe(wrap('flash', 'J-Link Flash'))),
    vscode.commands.registerCommand('zkz-keil.prepareCortexDebug', safe(wrap('prepare', 'Prepare Cortex Debug'))),
    vscode.commands.registerCommand('zkz-keil.resolveLayout', () => {
      try {
        return resolveKeilLayout(resolvePair().root);
      } catch (_) {
        return null;
      }
    })
  );
}

module.exports = { activate, runKeilAction, output };
