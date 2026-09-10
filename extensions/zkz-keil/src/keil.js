'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolvePair } = require('./pair');
const { resolveKeilLayout } = require('./keil_layout');
const { invokeGitSync } = require('./git_sync');
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
  const cands = [
    process.env.ZKZ_KEIL_UV4,
    'D:\\ruanjian\\keil\\UV4\\UV4.exe'
  ];
  for (const c of cands) {
    const p = String(c || '').trim().replace(/^["']|["']$/g, '');
    if (p && fs.existsSync(p)) return path.resolve(p);
  }
  throw new Error('Keil UV4.exe not found. Set env ZKZ_KEIL_UV4 or install at D:\\ruanjian\\keil\\UV4\\UV4.exe');
}

function openedIsSandbox(pair) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return false;
  return path.resolve(folders[0].uri.fsPath) !== path.resolve(pair.w1);
}

function resolveTarget(layout, requested) {
  const t = String(requested || '').trim();
  if (layout.flavor === 'h750' && (!t || t === 'Flash')) return layout.defaultTarget || 'H750_N';
  return t;
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

async function maybeToGb(pair, token, emit) {
  if (!openedIsSandbox(pair)) {
    emit('Opened true source; skip ToGb');
    return;
  }
  emit('ToGb before Keil (zkz-sandbox.toGb)');
  await invokeGitSync('zkz-sandbox.toGb', emit);
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

function writeGdbMapFiles(w1, sandbox, layout, mapW1, mapU) {
  writeText(path.join(w1, '.zkz', 'gdb_source_map.gdb'), mapW1);
  writeText(path.join(w1, layout.relMap), mapW1);
  if (sandbox && path.resolve(sandbox) !== path.resolve(w1) && fs.existsSync(sandbox)) {
    writeText(path.join(sandbox, '.zkz', 'gdb_source_map.gdb'), mapU);
  }
}

async function publishDebugArtifacts(w1, sandbox, layout, emit) {
  const copied = await invokeGitSync('zkz-sandbox.copyDebugAxf', emit);
  if (!copied) {
    const stub = '# zkz-keil: gdb map skipped (copyDebugAxf not found)\n';
    writeGdbMapFiles(w1, sandbox, layout, stub, stub);
    emit('  gdb map skipped; debug continues without substitute-path');
    return;
  }

  const w1Fwd = w1.replace(/\\/g, '/');
  const uFwd = (sandbox || w1).replace(/\\/g, '/');
  const w1Low = w1Fwd.charAt(0).toLowerCase() + w1Fwd.slice(1);
  const uLow = uFwd.charAt(0).toLowerCase() + uFwd.slice(1);
  const mapW1 = [
    '# Auto-generated by zkz-keil (W1 native)',
    'directory "' + w1Fwd + '"',
    'directory "' + w1Fwd + '/User"',
    'directory "' + w1Fwd + '/core"',
    ''
  ].join('\n');
  const mapU = [
    '# Auto-generated by zkz-keil (sandbox *U)',
    'set substitute-path "' + w1Fwd + '" "' + uFwd + '"',
    'set substitute-path "' + w1Low + '" "' + uLow + '"',
    'directory "' + uFwd + '"',
    'directory "' + uFwd + '/User"',
    'directory "' + uFwd + '/core"',
    ''
  ].join('\n');
  writeGdbMapFiles(w1, sandbox, layout, mapW1, mapU);
  emit('  gdb map true source -> ' + w1 + '/.zkz (+ Flash/.zkz legacy)');
  if (sandbox) emit('  gdb map *U -> ' + sandbox + '/.zkz');
}

async function runBuild(pair, mode, token, emit) {
  throwIfCancelled(token);
  await maybeToGb(pair, token, emit);
  throwIfCancelled(token);
  const layout = resolveKeilLayout(pair.w1);
  if (!fs.existsSync(layout.projectFile)) {
    throw new Error('Keil project not found: ' + layout.projectFile);
  }
  const keilExe = getUv4Path();
  const target = resolveTarget(layout, '');
  const logFile = path.join(layout.projectDir, 'build_output.txt');
  const flag = mode === 'rebuild' ? '-r' : '-b';
  const args = [flag, layout.projectFile];
  if (target) args.push('-t', target);
  args.push('-j0', '-o', logFile);
  emit('============================================');
  emit(' Keil ' + mode.toUpperCase() + (target ? ('  Target: ' + target) : '  (Keil active Target)'));
  emit(' Workspace: ' + pair.w1);
  emit(' UV4: ' + keilExe);
  emit('============================================');
  emit('');
  const keilCode = await spawnUv4(keilExe, args, logFile, layout.projectDir, token, emit);
  emit('');
  emit('============================================');
  const exitCode = summarizeBuild(logFile, layout.projectDir, keilCode, emit);
  emit(' Build finished at: ' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  return exitCode;
}

async function runFlash(pair, token, emit) {
  throwIfCancelled(token);
  const layout = resolveKeilLayout(pair.w1);
  const hexPath = path.join(pair.w1, layout.relHex);
  if (!fs.existsSync(hexPath)) throw new Error('HEX not found, build first: ' + hexPath);
  const tool = getJLinkFlashTool(layout.flavor);
  await stopJLinkGdbServer(emit);
  const logFile = path.join(layout.projectDir, 'flash_output.txt');
  emit('============================================');
  emit(' J-Link Flash  Flavor: ' + layout.flavor);
  emit(' Workspace: ' + pair.w1);
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
  const layout = resolveKeilLayout(pair.w1);
  emit('Prepare Cortex Debug');
  emit('  Opened:  ' + ((vscode.workspace.workspaceFolders || [])[0]
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : ''));
  emit('  Keil/true source: ' + pair.w1);
  emit('  Sandbox: ' + pair.sandbox);
  await publishDebugArtifacts(pair.w1, pair.sandbox, layout, emit);
  emit('Done.');
  return 0;
}

async function runKeilAction(action, opts) {
  const emit = opts && opts.log ? opts.log : outLog;
  const token = opts && opts.token;
  const pair = resolvePair();
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
    vscode.commands.registerCommand('zkz-keil.prepareCortexDebug', safe(wrap('prepare', 'Prepare Cortex Debug')))
  );
}

module.exports = { activate, runKeilAction, output };
