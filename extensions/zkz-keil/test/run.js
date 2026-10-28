'use strict';

const Module = require('module');
const vscodeMock = {
  window: {
    createOutputChannel() {
      return { appendLine() { }, show() { }, dispose() { } };
    }
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration() {
      return { get(_key, def) { return def; } };
    }
  },
  commands: {
    getCommands: async () => [],
    executeCommand: async () => undefined
  },
  ProgressLocation: { Notification: 1 }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.apply(this, arguments);
};

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseIntelHex, assertH750HexQspiOnly, assertF429HexSkipsBoot, jlinkGdbServerPath, createJLinkSink } = require('../src/keil_flash');
const { discoverFlavor, resolveKeilLayout } = require('../src/keil_layout');
const { summarizeBuild, takeCompleteGbk } = require('../src/keil');

function ihex(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xff;
  const cs = (0x100 - sum) & 0xff;
  const all = bytes.concat([cs]);
  return ':' + all.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

function writeHex(dir, name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

let failed = 0;
const pending = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(
        () => { console.log('ok  ' + name); },
        (e) => {
          failed += 1;
          console.log('FAIL ' + name);
          console.log('  ' + (e && e.stack ? e.stack : e));
        }
      ));
      return;
    }
    console.log('ok  ' + name);
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + name);
    console.log('  ' + (e && e.stack ? e.stack : e));
  }
}

test('settings cache reuses reads and invalidates without leaking mutations', () => {
  const settings = require('../../shared/zkz_settings');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-settings-cache-'));
  const original = fs.readFileSync;
  let reads = 0;
  try {
    settings.set(root, 'keil', 'flavor', 'f429');
    const file = settings.settingsFile(root);
    fs.readFileSync = function (p, ...args) {
      if (p === file) reads++;
      return original.call(this, p, ...args);
    };
    assert.strictEqual(settings.get(root, 'keil', 'flavor'), 'f429');
    assert.strictEqual(settings.get(root, 'keil', 'flavor'), 'f429');
    assert.strictEqual(reads, 1);
    settings.load(root).keil.flavor = 'bad';
    settings.get(root, 'native', 'paths').push('bad');
    assert.strictEqual(settings.get(root, 'keil', 'flavor'), 'f429');
    assert.ok(!settings.get(root, 'native', 'paths').includes('bad'));
    fs.writeFileSync(file, JSON.stringify({ keil: { flavor: 'h750', extra: 1 } }));
    assert.strictEqual(settings.get(root, 'keil', 'flavor'), 'h750');
    settings.set(root, 'keil', 'flavor', 'f429');
    assert.strictEqual(settings.get(root, 'keil', 'flavor'), 'f429');
    fs.unlinkSync(file);
    assert.strictEqual(settings.get(root, 'keil', 'flavor', 'missing'), 'missing');
    fs.writeFileSync(file, 'invalid');
    assert.deepStrictEqual(settings.load(root), {});
  } finally {
    fs.readFileSync = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseIntelHex checksum and length', () => {
  const recs = parseIntelHex([
    ':0200000490006A',
    ':00000001FF'
  ].join('\n'));
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0].type, 4);
  assert.strictEqual((recs[0].data[0] << 8) | recs[0].data[1], 0x9000);
  assert.strictEqual(recs[1].type, 1);
});

test('parseIntelHex rejects bad checksum', () => {
  let threw = false;
  try { parseIntelHex(':0200000490006B\n'); } catch (e) {
    threw = /校验和/.test(String(e && e.message ? e.message : e));
  }
  assert.ok(threw);
});

test('parseIntelHex rejects length mismatch', () => {
  let threw = false;
  try { parseIntelHex(':0400000490006A\n'); } catch (e) {
    threw = /长度/.test(String(e && e.message ? e.message : e));
  }
  assert.ok(threw);
});

test('resolveKeilLayout defaults to f429 unless flavor is h750', () => {
  const { set } = require('../../shared/zkz_settings');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-layout-'));
  const h750 = path.join(root, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
  const f429 = path.join(root, 'Project', 'MDK-ARM(uV4)', 'b_01.uvprojx');
  try {
    fs.mkdirSync(path.dirname(h750), { recursive: true });
    fs.writeFileSync(h750, '<Project/>', 'utf8');
    fs.mkdirSync(path.dirname(f429), { recursive: true });
    fs.writeFileSync(f429, '<Project/>', 'utf8');
    assert.strictEqual(discoverFlavor(root), 'f429');
    const f = resolveKeilLayout(root);
    assert.strictEqual(f.flavor, 'f429');
    assert.strictEqual(f.projectFile, f429);
    assert.strictEqual(f.defaultTarget, 'Flash');

    set(root, 'keil', 'flavor', 'auto');
    assert.strictEqual(discoverFlavor(root), 'f429');
    set(root, 'keil', 'flavor', 'f429');
    assert.strictEqual(resolveKeilLayout(root).flavor, 'f429');
    set(root, 'keil', 'flavor', 'h750');
    assert.strictEqual(discoverFlavor(root), 'h750');
    const h = resolveKeilLayout(root);
    assert.strictEqual(h.flavor, 'h750');
    assert.strictEqual(h.projectFile, h750);
    assert.strictEqual(h.defaultTarget, 'H750_N');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settings.json keeps false and blank falls back', () => {
  const { get, getNumber, set, ensure, settingsFile } = require('../../shared/zkz_settings');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-settings-'));
  try {
    const seeded = ensure(root);
    assert.strictEqual(seeded.keil.flavor, 'f429');
    assert.strictEqual(seeded.keil.uv4Path, 'D:/ruanjian/keil/UV4/UV4.exe');
    assert.strictEqual(seeded.keil.packRoot, 'D:/ruanjian/Keil/Packs/Keil');
    const written = JSON.parse(fs.readFileSync(settingsFile(root), 'utf8'));
    assert.strictEqual(written.keil.uv4Path, 'D:/ruanjian/keil/UV4/UV4.exe');
    assert.strictEqual(written.keil.h750.svdFile, 'D:/ruanjian/Keil/Packs/Keil/STM32H7xx_DFP/3.1.0/CMSIS/SVD/STM32H750.svd');
    assert.strictEqual(written.keil.h750.device, 'STM32H750IB');
    assert.strictEqual(seeded.native.glob, '*.c,*.h');
    assert.strictEqual(seeded.code.ifdefFold.minLines, 2);
    assert.ok(fs.existsSync(settingsFile(root)));
    set(root, 'keil', 'uv4Path', '');
    assert.strictEqual(get(root, 'keil', 'uv4Path', 'from-env'), 'from-env');
    set(root, 'keil', 'h750.target', 'Custom');
    set(root, 'keil', 'speedKHz', 0);
    set(root, 'code', 'ifdefFold.enabled', false);
    set(root, 'native', 'enabled', false);
    assert.strictEqual(get(root, 'keil', 'h750.target', 'H750_N'), 'Custom');
    assert.strictEqual(getNumber(root, 'keil', 'speedKHz', 6000), 0);
    assert.strictEqual(get(root, 'code', 'ifdefFold.enabled', true), false);
    assert.strictEqual(get(root, 'native', 'enabled', true), false);
    ensure(root);
    assert.strictEqual(get(root, 'keil', 'h750.target', ''), 'Custom');
    assert.strictEqual(get(root, 'code', 'ifdefFold.enabled', true), false);
    assert.strictEqual(get(root, 'keil', 'flavor', ''), 'f429');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('jlink gdb server path follows flavor', () => {
  const { set } = require('../../shared/zkz_settings');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-jlink-'));
  const f429 = path.join(root, 'j502');
  const h750 = path.join(root, 'j698');
  try {
    fs.mkdirSync(f429, { recursive: true });
    fs.mkdirSync(h750, { recursive: true });
    fs.writeFileSync(path.join(f429, 'JLink.exe'), '');
    fs.writeFileSync(path.join(f429, 'JLinkGDBServerCL.exe'), '');
    fs.writeFileSync(path.join(h750, 'JLink.exe'), '');
    fs.writeFileSync(path.join(h750, 'JLinkGDBServerCL.exe'), '');
    set(root, 'keil', 'f429.jlinkPath', path.join(f429, 'JLink.exe'));
    set(root, 'keil', 'h750.jlinkPath', path.join(h750, 'JLink.exe'));
    set(root, 'keil', 'f429.jlinkGdbServerPath', '');
    set(root, 'keil', 'h750.jlinkGdbServerPath', '');
    assert.strictEqual(jlinkGdbServerPath(root, 'f429'), path.join(f429, 'JLinkGDBServerCL.exe'));
    assert.strictEqual(jlinkGdbServerPath(root, 'h750'), path.join(h750, 'JLinkGDBServerCL.exe'));
    set(root, 'keil', 'f429.jlinkPath', path.join(f429, 'JLinkGDBServerCL.exe'));
    assert.strictEqual(jlinkGdbServerPath(root, 'f429'), path.join(f429, 'JLinkGDBServerCL.exe'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('configureLaunch writes flavor device and keeps other configs', () => {
  const { set } = require('../../shared/zkz_settings');
  const { writeLaunchJson, stripJsonComments } = require('../src/keil_launch');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-launch-'));
  const gdb = path.join(root, 'arm-none-eabi-gdb.exe');
  const svdF = path.join(root, 'STM32F429x.svd');
  const svdH = path.join(root, 'STM32H750x.svd');
  try {
    fs.writeFileSync(gdb, '');
    fs.writeFileSync(svdF, '');
    fs.writeFileSync(svdH, '');
    set(root, 'keil', 'gdbPath', gdb);
    set(root, 'keil', 'f429.svdFile', svdF);
    set(root, 'keil', 'h750.svdFile', svdH);
    set(root, 'keil', 'debugSpeedKHz', 4000);
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vscode', 'launch.json'), [
      '{',
      '  // keep me',
      '  "version": "2.0.0",',
      '  "configurations": [',
      '    { "name": "其它", "type": "node", "request": "launch" }',
      '  ]',
      '}',
      ''
    ].join('\n'), 'utf8');
    const f429 = writeLaunchJson(root);
    assert.strictEqual(f429.flavor, 'f429');
    assert.strictEqual(f429.device, 'STM32F429BI');
    const text = fs.readFileSync(f429.file, 'utf8');
    assert.ok(text.indexOf('Written by zkz-keil.configureLaunch') >= 0);
    const doc = JSON.parse(stripJsonComments(text));
    assert.strictEqual(doc.configurations.length, 3);
    assert.strictEqual(doc.configurations[0].name, '编译调试');
    assert.strictEqual(doc.configurations[0].device, '${command:zkz-keil.device}');
    assert.strictEqual(doc.configurations[0].svdFile, '${command:zkz-keil.svdFile}');
    assert.strictEqual(doc.configurations[0].serverpath, '${command:zkz-keil.jlinkGdbServerPath}');
    assert.strictEqual(doc.configurations[0].gdbPath, '${command:zkz-keil.gdbPath}');
    assert.strictEqual(doc.configurations[0].preLaunchTask, 'zkz-keil: Build + Flash + Prepare Debug');
    assert.deepStrictEqual(doc.configurations[0].serverArgs, ['-speed', '${command:zkz-keil.debugSpeed}']);
    assert.deepStrictEqual(doc.configurations[0].debuggerArgs, ['-x', '${workspaceFolder}/.zkz/gdb_source_map.gdb']);
    assert.strictEqual(doc.configurations[0].postStartSessionCommands, undefined);
    assert.strictEqual(doc.configurations[1].name, '调试');
    assert.strictEqual(doc.configurations[1].preLaunchTask, 'zkz-keil: Prepare Cortex Debug');
    assert.strictEqual(doc.configurations[2].name, '其它');
    set(root, 'keil', 'flavor', 'h750');
    set(root, 'keil', 'h750.device', 'STM32H750IB');
    const h750 = writeLaunchJson(root);
    const again = JSON.parse(stripJsonComments(fs.readFileSync(h750.file, 'utf8')));
    assert.strictEqual(again.configurations[0].device, '${command:zkz-keil.device}');
    assert.strictEqual(again.configurations[0].svdFile, '${command:zkz-keil.svdFile}');
    assert.strictEqual(again.configurations[1].device, '${command:zkz-keil.device}');
    assert.strictEqual(again.configurations.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assertH750HexQspiOnly rejects internal flash, no ext addr, type 02', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-hex-'));
  const eof = ihex([0x00, 0x00, 0x00, 0x01]);
  const qspi = ihex([0x02, 0x00, 0x00, 0x04, 0x90, 0x00]);
  try {
    const internal = writeHex(dir, 'internal.hex', [
      ihex([0x02, 0x00, 0x00, 0x04, 0x08, 0x00]),
      eof
    ]);
    let internalMsg = '';
    try { assertH750HexQspiOnly(internal, null, null); } catch (e) {
      internalMsg = String(e && e.message ? e.message : e);
    }
    assert.ok(/片内/.test(internalMsg), internalMsg);

    const bare = writeHex(dir, 'bare.hex', [
      ihex([0x00, 0x00, 0x00, 0x00]),
      eof
    ]);
    let bareMsg = '';
    try { assertH750HexQspiOnly(bare, null, null); } catch (e) {
      bareMsg = String(e && e.message ? e.message : e);
    }
    assert.ok(/扩展线性地址/.test(bareMsg), bareMsg);

    const seg = writeHex(dir, 'seg.hex', [
      qspi,
      ihex([0x02, 0x00, 0x00, 0x02, 0x00, 0x00]),
      eof
    ]);
    let segMsg = '';
    try { assertH750HexQspiOnly(seg, null, null); } catch (e) {
      segMsg = String(e && e.message ? e.message : e);
    }
    assert.ok(/类型 02/.test(segMsg), segMsg);

    const okHex = writeHex(dir, 'ok.hex', [qspi, eof]);
    let logged = '';
    assertH750HexQspiOnly(okHex, (m) => { logged += m; }, null);
    assert.ok(/QSPI/.test(logged), logged);

    const early = writeHex(dir, 'early.hex', [
      ihex([0x01, 0x00, 0x00, 0x00, 0x11]),
      qspi,
      eof
    ]);
    let earlyMsg = '';
    try { assertH750HexQspiOnly(early, null, null); } catch (e) {
      earlyMsg = String(e && e.message ? e.message : e);
    }
    assert.ok(/扩展地址之前有数据/.test(earlyMsg), earlyMsg);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertF429HexSkipsBoot rejects boot and accepts the app', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-f429-hex-'));
  const eof = ihex([0x00, 0x00, 0x00, 0x01]);
  const ela = ihex([0x02, 0x00, 0x00, 0x04, 0x08, 0x00]);
  try {
    const boot = writeHex(dir, 'boot.hex', [
      ela,
      ihex([0x01, 0x00, 0x00, 0x00, 0x11]),
      eof
    ]);
    let bootMsg = '';
    try { assertF429HexSkipsBoot(boot, null); } catch (e) {
      bootMsg = String(e && e.message ? e.message : e);
    }
    assert.ok(/0x08000000/.test(bootMsg), bootMsg);

    const app = writeHex(dir, 'app.hex', [
      ela,
      ihex([0x01, 0xC0, 0x00, 0x00, 0x22]),
      eof
    ]);
    let logged = '';
    assertF429HexSkipsBoot(app, (m) => { logged += m; });
    assert.ok(/0x0800BFFF/.test(logged), logged);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('takeCompleteGbk holds a trailing GBK lead byte', () => {
  const split = takeCompleteGbk(Buffer.from([0x41, 0xB2]));
  assert.deepStrictEqual(Array.from(split.done), [0x41]);
  assert.deepStrictEqual(Array.from(split.rest), [0xB2]);
  const whole = takeCompleteGbk(Buffer.concat([split.rest, Buffer.from([0xE2, 0x42])]));
  assert.deepStrictEqual(Array.from(whole.done), [0xB2, 0xE2, 0x42]);
  assert.strictEqual(whole.rest.length, 0);
});

test('summarizeBuild maps keil exit codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-sum-'));
  const logFile = path.join(dir, 'build.log');
  const run = (code, body) => {
    if (body == null) {
      try { fs.rmSync(logFile); } catch (_) { /* ignore */ }
    } else {
      fs.writeFileSync(logFile, body, 'utf8');
    }
    const lines = [];
    const exitCode = summarizeBuild(logFile, dir, code, (m) => lines.push(String(m)));
    return { exitCode, text: lines.join('\n') };
  };
  try {
    const c0 = run(0, '');
    assert.strictEqual(c0.exitCode, 0);
    assert.ok(/编译成功（无警告）/.test(c0.text), c0.text);
    const c1 = run(1, '');
    assert.strictEqual(c1.exitCode, 0);
    assert.ok(/编译成功（有警告）/.test(c1.text), c1.text);
    const c2 = run(2, 'main.c(1): error: boom\n');
    assert.strictEqual(c2.exitCode, 1);
    assert.ok(/编译失败（有错误）/.test(c2.text), c2.text);
    const c3 = run(3, '');
    assert.strictEqual(c3.exitCode, 1);
    assert.ok(/编译失败（致命错误）/.test(c3.text), c3.text);
    const clog = run(4, 'main.c(1): error: boom\n');
    assert.strictEqual(clog.exitCode, 1);
    assert.ok(/编译失败（日志里有错误）/.test(clog.text), clog.text);
    const cwarn = run(4, 'main.c(2): warning: note\n');
    assert.strictEqual(cwarn.exitCode, 0);
    assert.ok(/编译成功（有警告）/.test(cwarn.text), cwarn.text);
    assert.ok(c2.text.indexOf('---------- 编译摘要 ----------') >= 0, c2.text);
    assert.ok(c2.text.indexOf('main.c(1): error: boom') >= 0, c2.text);
    assert.ok(c2.text.indexOf('[错误]') < 0, c2.text);
    assert.ok(cwarn.text.indexOf('main.c(2): warning: note') >= 0, cwarn.text);

    const root = path.join(dir, 'ws');
    const proj = path.join(root, '.zkz', 'keil-native', 'Project', 'MDK-ARM(uV4)');
    const src = path.join(root, '.zkz', 'keil-native', 'fpga_motion', 'run_function.h');
    const body = src + '(424): error: #147: declared at line 26 of "..\\..\\driver\\motion\\axis\\inc\\yt_axis_buffer.h"\n'
      + 'main.c(3): warning: note\n';
    fs.writeFileSync(logFile, body, 'utf8');
    const lines2 = [];
    const mapped = summarizeBuild(logFile, proj, 2, (m) => lines2.push(String(m)));
    const shown = lines2.join('\n');
    assert.strictEqual(mapped, 1);
    const errAt = shown.indexOf('(424): error:');
    const warnAt = shown.indexOf('main.c(3): warning: note');
    assert.ok(errAt >= 0 && warnAt > errAt, shown);
    assert.ok(shown.indexOf(path.join(root, 'fpga_motion', 'run_function.h')) >= 0, shown);
    assert.ok(shown.indexOf(path.join(root, 'driver', 'motion', 'axis', 'inc', 'yt_axis_buffer.h')) >= 0, shown);
    assert.ok(shown.toLowerCase().indexOf('keil-native') < 0, shown);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('jlink sink reports stage percent and logs one line per finished bar', () => {
  const lines = [];
  const messages = [];
  const sink = createJLinkSink(
    (s) => lines.push(s),
    { report(p) { messages.push(p.message); } }
  );
  sink.push('Info: Found SWD-DP with ID 0x2BA01477\n');
  sink.push('Info: Device "STM32F429BI" selected.\n');
  sink.push('Comparing flash   [....................] 12%\r');
  sink.push('Comparing flash   [##########..........] 40%\r');
  sink.push('Comparing flash   [####################] 100%\r\n');
  sink.push('Programming flash [#####...............] 20%\rProgramming flash [####################] 100%\r\n');
  sink.push('ERROR: Programming failed\n');
  sink.end();
  assert.deepStrictEqual(lines.filter((l) => /Comparing flash/.test(l)), [
    'Comparing flash   [####################] 100%'
  ]);
  assert.deepStrictEqual(lines.filter((l) => /Programming flash/.test(l)), [
    'Programming flash [####################] 100%'
  ]);
  assert.ok(lines.some((l) => l.indexOf('ERROR: Programming failed') >= 0));
  assert.ok(lines.some((l) => l.indexOf('Found SWD-DP') >= 0));
  assert.deepStrictEqual(messages, [
    '已连接',
    '比较 12%',
    '比较 40%',
    '比较 100%',
    '编程 20%',
    '编程 100%'
  ]);
});

test('jlink sink does not invent a percent when Commander prints none', () => {
  const lines = [];
  const messages = [];
  const sink = createJLinkSink(
    (s) => lines.push(s),
    { report(p) { messages.push(p.message); } }
  );
  sink.push('Info: Found SWD-DP with ID 0x2BA01477\n');
  sink.push('O.K.\n');
  sink.push('Downloading file [C:/output.hex]...\n');
  assert.deepStrictEqual(messages, ['已连接', '下载']);
  sink.push('Info: J-Link: Flash download: Flash programming performed for 1 range (49152 bytes)\n');
  sink.end();
  assert.deepStrictEqual(messages, ['已连接', '下载', '完成']);
  assert.ok(lines.some((l) => l.indexOf('Downloading file') === 0));
  assert.ok(!lines.some((l) => l.indexOf('Downloading file') >= 0 && l.indexOf('Flash programming performed') >= 0));
  assert.ok(lines.some((l) => l === 'O.K.'));
  assert.ok(!messages.some((m) => /%/.test(m)));
});

test('capture keeps a zero exit when not cancelled', () => {
  const { runCaptured } = require('../src/keil_flash');
  return runCaptured(process.execPath, ['-e', 'process.exit(0)'], process.cwd(), () => { }, null, null)
    .then((result) => { assert.strictEqual(result.code, 0); });
});

test('cancelled capture rejects even when the process exits 0', () => {
  const { runCaptured } = require('../src/keil_flash');
  const token = {
    isCancellationRequested: true,
    onCancellationRequested() { return { dispose() { } }; }
  };
  return runCaptured(process.execPath, ['-e', 'process.exit(0)'], process.cwd(), () => { }, token, null).then(
    () => { throw new Error('zero exit was kept'); },
    (err) => { assert.strictEqual(err.message, '已取消'); }
  );
});

test('cancelling a live capture rejects instead of keeping exit 0', () => {
  const { runCaptured } = require('../src/keil_flash');
  let cancel = null;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(fn) {
      cancel = fn;
      return { dispose() { cancel = null; } };
    }
  };
  const running = runCaptured(
    process.execPath,
    ['-e', 'setTimeout(() => process.exit(0), 5000)'],
    process.cwd(),
    () => { },
    token,
    null
  );
  setTimeout(() => { if (cancel) cancel(); }, 40);
  return running.then(
    () => { throw new Error('exit 0 was kept after cancel'); },
    (err) => { assert.strictEqual(err.message, '已取消'); }
  );
});

function finish() {
  if (failed) {
    console.log('\n' + failed + ' failed');
    process.exit(1);
  }
  console.log('\nall passed');
}

if (pending.length) Promise.all(pending).then(finish, finish);
else finish();
