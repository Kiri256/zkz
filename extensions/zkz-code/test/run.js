'use strict';

const assert = require('assert');
const { evalPpExpr, parseCInt } = require('../src/pp_expr');

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

test('parseCInt hex octal decimal', () => {
  assert.strictEqual(parseCInt('0x10'), 16);
  assert.strictEqual(parseCInt('0x1Fu'), 31);
  assert.strictEqual(parseCInt('010'), 8);
  assert.strictEqual(parseCInt('10'), 10);
});

test('hex compare VER >= 0x10', () => {
  assert.strictEqual(evalPpExpr('VER >= 0x10', { VER: '16' }), true);
  assert.strictEqual(evalPpExpr('VER >= 0x10', { VER: '15' }), false);
});

test('bitwise FLAGS & 0x2', () => {
  assert.strictEqual(evalPpExpr('(FLAGS & 0x2)', { FLAGS: '2' }), true);
  assert.strictEqual(evalPpExpr('(FLAGS & 0x2)', { FLAGS: '1' }), false);
  assert.strictEqual(evalPpExpr('FLAGS | 0x4', { FLAGS: '1' }), true);
  assert.strictEqual(evalPpExpr('FLAGS ^ 0x2', { FLAGS: '2' }), false);
});

test('shift and not', () => {
  assert.strictEqual(evalPpExpr('1 << 3', {}), true);
  assert.strictEqual(evalPpExpr('(1 << 3) == 8', {}), true);
  assert.strictEqual(evalPpExpr('~0', {}), true);
});

test('ternary A ? B : C', () => {
  assert.strictEqual(evalPpExpr('A ? B : C', { A: '1', B: '1', C: '0' }), true);
  assert.strictEqual(evalPpExpr('A ? B : C', { A: '0', B: '1', C: '0' }), false);
  assert.strictEqual(evalPpExpr('A ? 0 : 1', { A: '1' }), false);
});

test('existing equality and defined', () => {
  assert.strictEqual(evalPpExpr('GROUP_MACHINE == GROUP_MACHINE_COMSTOM_9001', {
    GROUP_MACHINE: 'GROUP_MACHINE_COMSTOM_9001',
    GROUP_MACHINE_COMSTOM_9001: '9001'
  }), true);
  assert.strictEqual(evalPpExpr('defined(FOO) && FOO', { FOO: '1' }), true);
  assert.strictEqual(evalPpExpr('defined(BAR)', {}), false);
});

test('unsupported syntax is false not a partial value', () => {
  assert.strictEqual(evalPpExpr("FLAGS == 'x'", { FLAGS: '1' }), false);
});

test('readHeadOid loose ref and packed-refs', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { readHeadOid } = require('../src/cc_stamp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-head-'));
  const git = path.join(root, '.git');
  const oid = '0123456789abcdef0123456789abcdef01234567';
  const packed = 'fedcba9876543210fedcba9876543210fedcba98';
  try {
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), oid + '\n', 'utf8');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    assert.strictEqual(readHeadOid(root), oid);
    fs.rmSync(path.join(git, 'refs', 'heads', 'main'));
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/packed\n', 'utf8');
    fs.writeFileSync(path.join(git, 'packed-refs'), packed + ' refs/heads/packed\n', 'utf8');
    assert.strictEqual(readHeadOid(root), packed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadMacroTable reuses disk cache until mtime changes', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { loadMacroTable, invalidateMacroTable } = require('../src/macros');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-mac-'));
  const ver = path.join(dir, 'core', 'yt_version.h');
  try {
    fs.mkdirSync(path.dirname(ver), { recursive: true });
    fs.writeFileSync(ver, '#define MACHINE_VALUE 0\n#define MDJ 0\n', 'utf8');
    invalidateMacroTable();
    const a = loadMacroTable({ workspaceRoot: dir, filePath: ver });
    const b = loadMacroTable({ workspaceRoot: dir, filePath: ver });
    assert.strictEqual(a, b);
    assert.strictEqual(a.macros.MACHINE_VALUE, '0');
    fs.writeFileSync(ver, '#define MACHINE_VALUE 1\n#define MLS 1\n', 'utf8');
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(ver, later, later);
    const c = loadMacroTable({ workspaceRoot: dir, filePath: ver });
    assert.notStrictEqual(c, a);
    assert.strictEqual(c.macros.MACHINE_VALUE, '1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('countFffdText counts U+FFFD', () => {
  const { countFffdText } = require('../src/fffd');
  assert.strictEqual(countFffdText('ok'), 0);
  assert.strictEqual(countFffdText('a\uFFFDb\uFFFD'), 2);
});

test('compile_commands stamp stale detection', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const {
    isCompileCommandsStale, writeCompileCommandsStamp
  } = require('../src/cc_stamp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-cc-'));
  assert.ok(isCompileCommandsStale(dir, 'abc'));
  fs.writeFileSync(path.join(dir, 'compile_commands.json'), '[]\n', 'utf8');
  assert.ok(isCompileCommandsStale(dir, 'abc'));
  writeCompileCommandsStamp(dir, 'abc');
  const stamp = JSON.parse(fs.readFileSync(path.join(dir, '.zkz', 'compile-commands-stamp.json'), 'utf8'));
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(stamp.at));
  assert.ok(!isCompileCommandsStale(dir, 'abc'));
  assert.ok(isCompileCommandsStale(dir, 'def'));
});

if (failed) {
  console.log('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
