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

test('logical or and and do not skip the other side', () => {
  assert.strictEqual(evalPpExpr('1 || 0', {}), true);
  assert.strictEqual(evalPpExpr('0 || 1', {}), true);
  assert.strictEqual(evalPpExpr('0 || 0', {}), false);
  assert.strictEqual(evalPpExpr('0 && 1', {}), false);
  assert.strictEqual(evalPpExpr('1 && 0', {}), false);
  assert.strictEqual(evalPpExpr('(0 && 1) || 1', {}), true);
  assert.strictEqual(evalPpExpr('MLS_610 || MLS_510', { MLS_610: '1', MLS_510: '0' }), true);
  assert.strictEqual(evalPpExpr('A || B', { A: '0', B: '0' }), false);
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

test('readHeadName ignores same-branch commit and undo', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { readHeadName, readHeadOid } = require('../src/cc_stamp');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-headname-'));
  const git = path.join(root, '.git');
  const oid = '0123456789abcdef0123456789abcdef01234567';
  const next = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  try {
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), oid + '\n', 'utf8');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'refs/heads/main');
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), next + '\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'refs/heads/main');
    assert.strictEqual(readHeadOid(root), next);
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/dev\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'refs/heads/dev');
    fs.writeFileSync(path.join(git, 'HEAD'), next + '\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'detached');
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
    const published = JSON.parse(fs.readFileSync(path.join(dir, '.zkz', 'run', 'macro-table.json'), 'utf8'));
    assert.strictEqual(published.ready, true);
    assert.strictEqual(published.macros.MACHINE_VALUE, '1');
    assert.strictEqual(published.macros.MLS, '1');
    assert.ok(published.count >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMacroTable removes macro-table.json when yt_version.h is absent', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { loadMacroTable, invalidateMacroTable } = require('../src/macros');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-nomac-'));
  const runFile = path.join(dir, '.zkz', 'run', 'macro-table.json');
  const oldFile = path.join(dir, '.zkz', 'macro-table.json');
  try {
    fs.mkdirSync(path.dirname(runFile), { recursive: true });
    fs.writeFileSync(runFile, '{"ready":true}\n', 'utf8');
    fs.writeFileSync(oldFile, '{"ready":true}\n', 'utf8');
    invalidateMacroTable();
    const table = loadMacroTable({ workspaceRoot: dir });
    assert.strictEqual(table.ready, false);
    assert.strictEqual(fs.existsSync(runFile), false);
    assert.strictEqual(fs.existsSync(oldFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('countFffdText counts U+FFFD', () => {
  const { countFffdText } = require('../src/fffd');
  assert.strictEqual(countFffdText('ok'), 0);
  assert.strictEqual(countFffdText('a\uFFFDb\uFFFD'), 2);
});

test('uvproj target becomes compile_commands', () => {
  const path = require('path');
  const { buildCompileCommands } = require('../src/compile_commands');
  const mdk = path.join('E:', 'proj', 'Project', 'MDK-ARM(uV4)');
  const xml = [
    '<Project><Targets>',
    '<Target><TargetName>Other</TargetName><TargetOption><Cads><VariousControls>',
    '<Define>NOPE</Define><IncludePath>.\\nope</IncludePath>',
    '</VariousControls></Cads></TargetOption><Groups><Group><Files>',
    '<File><FileType>1</FileType><FilePath>..\\nope.c</FilePath></File>',
    '</Files></Group></Groups></Target>',
    '<Target><TargetName>Flash</TargetName><TargetOption>',
    '<DebugOption><Target><UseTarget>1</UseTarget></Target></DebugOption>',
    '<Cads><VariousControls>',
    '<Define>FOO,BAR=1</Define><Undefine>OLD</Undefine>',
    '<IncludePath>..\\..\\inc;..\\..\\lib</IncludePath>',
    '</VariousControls></Cads></TargetOption><Groups><Group><Files>',
    '<File><FileName>main.c</FileName><FileType>1</FileType><FilePath>..\\..\\app\\main.c</FilePath></File>',
    '<File><FileName>skip.s</FileName><FileType>2</FileType><FilePath>..\\..\\app\\skip.s</FilePath></File>',
    '<File><FileName>off.c</FileName><FileType>1</FileType><FilePath>..\\..\\app\\off.c</FilePath>',
    '<FileOption><CommonProperty><IncludeInBuild>0</IncludeInBuild></CommonProperty></FileOption></File>',
    '<File><FileName>note.h</FileName><FileType>5</FileType><FilePath>..\\..\\app\\note.h</FilePath></File>',
    '</Files></Group></Groups></Target>',
    '</Targets></Project>'
  ].join('');
  const built = buildCompileCommands(xml, mdk, 'Flash');
  assert.strictEqual(built.target, 'Flash');
  assert.strictEqual(built.entries.length, 1);
  const e = built.entries[0];
  assert.strictEqual(e.file, 'E:\\proj\\app\\main.c');
  assert.strictEqual(e.directory, 'E:\\proj\\Project\\MDK-ARM(uV4)');
  assert.deepStrictEqual(e.arguments, [
    'clang',
    '-IE:\\proj\\inc',
    '-IE:\\proj\\lib',
    '-UOLD',
    '-DFOO',
    '-DBAR=1'
  ]);
});

test('index snapshot stays put across a save', () => {
  const { retainIndexSnapshot } = require('../src/macros');
  let indexed = {};
  let seen = {};
  const started = { MACHINE_VALUE: '1', MALL_DOUBLE: '0' };
  indexed = retainIndexSnapshot(indexed, seen, started);
  seen = started;
  const saved = { MACHINE_VALUE: '2', MALL_DOUBLE: '0' };
  indexed = retainIndexSnapshot(indexed, seen, saved);
  seen = saved;
  assert.strictEqual(indexed.MACHINE_VALUE, '1');
  assert.strictEqual(seen.MACHINE_VALUE, '2');
  indexed = saved;
  assert.strictEqual(indexed.MACHINE_VALUE, '2');
});

function installVscodeStub() {
  const Module = require('module');
  if (Module._load && Module._load.__zkzStub) return;
  const origLoad = Module._load;
  const stub = function (request, parent, isMain) {
    if (request === 'vscode') {
      return {
        window: {
          createOutputChannel() {
            return { appendLine() { }, show() { }, dispose() { } };
          }
        },
        workspace: {
          workspaceFolders: [],
          getConfiguration: () => ({ get: (_k, d) => d })
        },
        ProgressLocation: { Notification: 1 }
      };
    }
    return origLoad.apply(this, arguments);
  };
  stub.__zkzStub = true;
  Module._load = stub;
}

test('collectPpBranches if ifdef ifndef elif else nested unknown', () => {
  installVscodeStub();
  const { collectPpBranches } = require('../src/ifdef_fold');
  const brief = (text, macros) => collectPpBranches(text, macros).map((b) => ({
    kind: b.kind,
    start: b.startLine,
    end: b.endLine,
    active: b.active,
    unknown: b.unknown
  }));

  assert.deepStrictEqual(brief('#if 0\ndead\n#endif\n', {}), [
    { kind: 'if', start: 0, end: 1, active: false, unknown: false }
  ]);
  assert.deepStrictEqual(brief('#ifdef FOO\nyes\n#endif\n', { FOO: '1' }), [
    { kind: 'ifdef', start: 0, end: 1, active: true, unknown: false }
  ]);
  assert.deepStrictEqual(brief('#ifndef FOO\nyes\n#endif\n', { FOO: '1' }), [
    { kind: 'ifndef', start: 0, end: 1, active: false, unknown: false }
  ]);
  assert.deepStrictEqual(brief('#if 0\na\n#elif 1\nb\n#else\nc\n#endif\n', {}), [
    { kind: 'if', start: 0, end: 1, active: false, unknown: false },
    { kind: 'elif', start: 2, end: 3, active: true, unknown: false },
    { kind: 'else', start: 4, end: 5, active: false, unknown: false }
  ]);
  assert.deepStrictEqual(brief('#if 1\n#if 0\ninner\n#endif\nouter\n#endif\n', {}), [
    { kind: 'if', start: 1, end: 2, active: false, unknown: false },
    { kind: 'if', start: 0, end: 4, active: true, unknown: false }
  ]);
  assert.deepStrictEqual(brief('#if UNKNOWN_MACRO\nx\n#endif\n', { FOO: '1' }), [
    { kind: 'if', start: 0, end: 1, active: false, unknown: true }
  ]);
});

test('expandSearchMacroNames derives Machine_* and follows RHS', () => {
  installVscodeStub();
  const { expandSearchMacroNames } = require('../src/macro_impact');
  const derived = expandSearchMacroNames(['MACHINE_VALUE'], '');
  assert.ok(derived.indexOf('MACHINE_VALUE') >= 0);
  assert.ok(derived.indexOf('Machine_DJ') >= 0);
  assert.ok(derived.indexOf('Machine_LS') >= 0);
  assert.ok(derived.indexOf('Machine_HX_NOT_MULTI') >= 0);
  assert.strictEqual(derived.length, 10);

  const yt = [
    '#define FOO 1',
    '#define BAR FOO',
    '#define BAZ BAR',
    '#define QUUX 3'
  ].join('\n');
  assert.deepStrictEqual(expandSearchMacroNames(['FOO'], yt), ['BAR', 'BAZ', 'FOO']);
});

test('findProjectRoot walks up to Project or git', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { findProjectRoot } = require('../../shared/project_root');
  const { isNativeInstalled } = require('../../shared/native_installed');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-root-'));
  const nested = path.join(root, 'a', 'b');
  try {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    assert.strictEqual(findProjectRoot([nested]), root);
    assert.strictEqual(findProjectRoot([]), '');
    assert.strictEqual(isNativeInstalled(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keil layout defaults to f429 when both projects exist', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { resolveKeilLayout } = require('../src/compile_commands');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-layout-'));
  const h750 = path.join(root, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
  const f429 = path.join(root, 'Project', 'MDK-ARM(uV4)', 'b_01.uvprojx');
  try {
    fs.mkdirSync(path.dirname(h750), { recursive: true });
    fs.writeFileSync(h750, '<Project/>', 'utf8');
    fs.mkdirSync(path.dirname(f429), { recursive: true });
    fs.writeFileSync(f429, '<Project/>', 'utf8');
    const layout = resolveKeilLayout(root);
    assert.strictEqual(layout.flavor, 'f429');
    assert.strictEqual(layout.projectFile, f429);
    assert.strictEqual(layout.defaultTarget, 'Flash');
    const { set } = require('../../shared/zkz_settings');
    set(root, 'keil', 'flavor', 'h750');
    const h = resolveKeilLayout(root);
    assert.strictEqual(h.flavor, 'h750');
    assert.strictEqual(h.projectFile, h750);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  const stamp = JSON.parse(fs.readFileSync(path.join(dir, '.zkz', 'run', 'compile-commands-stamp.json'), 'utf8'));
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(stamp.at));
  assert.ok(!isCompileCommandsStale(dir, 'abc'));
  assert.ok(isCompileCommandsStale(dir, 'def'));
});

if (failed) {
  console.log('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
