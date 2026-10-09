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
const { parseIntelHex, assertH750HexQspiOnly, jlinkGdbServerPath } = require('../src/keil_flash');
const { discoverFlavor, resolveKeilLayout } = require('../src/keil_layout');
const { summarizeBuild } = require('../src/keil');

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
function test(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
  } catch (e) {
    failed += 1;
    console.log('FAIL ' + name);
    console.log('  ' + (e && e.stack ? e.stack : e));
  }
}

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
    threw = /checksum/.test(String(e && e.message ? e.message : e));
  }
  assert.ok(threw);
});

test('parseIntelHex rejects length mismatch', () => {
  let threw = false;
  try { parseIntelHex(':0400000490006A\n'); } catch (e) {
    threw = /length/.test(String(e && e.message ? e.message : e));
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
    assert.strictEqual(seeded.native.glob, '*.c,*.h');
    assert.strictEqual(seeded.code.ifdefFold.minLines, 2);
    assert.ok(fs.existsSync(settingsFile(root)));
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
    assert.strictEqual(doc.configurations[0].device, 'STM32F429BI');
    assert.strictEqual(doc.configurations[0].svdFile, svdF.replace(/\\/g, '/'));
    assert.strictEqual(doc.configurations[0].serverpath, '${command:zkz-keil.jlinkGdbServerPath}');
    assert.strictEqual(doc.configurations[0].preLaunchTask, 'zkz-keil: Build + Flash + Prepare Debug');
    assert.deepStrictEqual(doc.configurations[0].serverArgs, ['-speed', '4000']);
    assert.strictEqual(doc.configurations[1].name, '调试');
    assert.strictEqual(doc.configurations[1].preLaunchTask, 'zkz-keil: Prepare Cortex Debug');
    assert.strictEqual(doc.configurations[2].name, '其它');
    set(root, 'keil', 'flavor', 'h750');
    set(root, 'keil', 'h750.device', 'STM32H750IB');
    const h750 = writeLaunchJson(root);
    const again = JSON.parse(stripJsonComments(fs.readFileSync(h750.file, 'utf8')));
    assert.strictEqual(again.configurations[0].device, 'STM32H750IB');
    assert.strictEqual(again.configurations[0].svdFile, svdH.replace(/\\/g, '/'));
    assert.strictEqual(again.configurations[1].device, 'STM32H750IB');
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
    assert.ok(/internal flash/.test(internalMsg), internalMsg);

    const bare = writeHex(dir, 'bare.hex', [
      ihex([0x00, 0x00, 0x00, 0x00]),
      eof
    ]);
    let bareMsg = '';
    try { assertH750HexQspiOnly(bare, null, null); } catch (e) {
      bareMsg = String(e && e.message ? e.message : e);
    }
    assert.ok(/extended linear address/.test(bareMsg), bareMsg);

    const seg = writeHex(dir, 'seg.hex', [
      qspi,
      ihex([0x02, 0x00, 0x00, 0x02, 0x00, 0x00]),
      eof
    ]);
    let segMsg = '';
    try { assertH750HexQspiOnly(seg, null, null); } catch (e) {
      segMsg = String(e && e.message ? e.message : e);
    }
    assert.ok(/type 02/.test(segMsg), segMsg);

    const okHex = writeHex(dir, 'ok.hex', [qspi, eof]);
    let logged = '';
    assertH750HexQspiOnly(okHex, (m) => { logged += m; }, null);
    assert.ok(/QSPI/.test(logged), logged);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    assert.ok(/BUILD SUCCESS \(0 warnings\)/.test(c0.text), c0.text);
    const c1 = run(1, '');
    assert.strictEqual(c1.exitCode, 0);
    assert.ok(/BUILD SUCCESS \(with warnings\)/.test(c1.text), c1.text);
    const c2 = run(2, 'main.c(1): error: boom\n');
    assert.strictEqual(c2.exitCode, 1);
    assert.ok(/BUILD FAILED \(errors\)/.test(c2.text), c2.text);
    const c3 = run(3, '');
    assert.strictEqual(c3.exitCode, 1);
    assert.ok(/BUILD FAILED \(fatal errors\)/.test(c3.text), c3.text);
    const clog = run(4, 'main.c(1): error: boom\n');
    assert.strictEqual(clog.exitCode, 1);
    assert.ok(/BUILD FAILED \(errors in log\)/.test(clog.text), clog.text);
    const cwarn = run(4, 'main.c(2): warning: note\n');
    assert.strictEqual(cwarn.exitCode, 0);
    assert.ok(/BUILD SUCCESS \(with warnings\)/.test(cwarn.text), cwarn.text);

    const root = path.join(dir, 'ws');
    const proj = path.join(root, '.zkz', 'keil-native', 'Project', 'MDK-ARM(uV4)');
    const src = path.join(root, '.zkz', 'keil-native', 'fpga_motion', 'run_function.h');
    const body = src + '(424): error: #147: declared at line 26 of "..\\..\\driver\\motion\\axis\\inc\\yt_axis_buffer.h"\n';
    fs.writeFileSync(logFile, body, 'utf8');
    const lines2 = [];
    const mapped = summarizeBuild(logFile, proj, 2, (m) => lines2.push(String(m)));
    const shown = lines2.join('\n');
    assert.strictEqual(mapped, 1);
    assert.ok(shown.indexOf(path.join(root, 'fpga_motion', 'run_function.h')) >= 0, shown);
    assert.ok(shown.indexOf(path.join(root, 'driver', 'motion', 'axis', 'inc', 'yt_axis_buffer.h')) >= 0, shown);
    assert.ok(shown.toLowerCase().indexOf('keil-native') < 0, shown);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failed) {
  console.log('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
