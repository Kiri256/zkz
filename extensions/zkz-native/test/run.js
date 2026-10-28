'use strict';

const assert = require('assert');
const { detectKind, decodeCp936, encodeCp936, roundtripOk, applySmudge, applyClean, kindForNewFile, UTF8_BOM, stripCr } = require('../src/encoding');
const { smudge, clean } = require('../src/filter_core');
const { encodePacket, encodeFlush, encodeContent, MAX_PAYLOAD } = require('../src/pktline');
const { replaceMarkedBlock, stripMarkedBlock, BEGIN, END, isNodeExecutable, nodeBin } = require('../src/git_config');

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

test('porcelain rename preserves both full paths and literal arrow names', () => {
  const { parsePorcelainZ } = require('../src/git_status');
  assert.deepStrictEqual(Array.from(parsePorcelainZ('R  User/new.c\0User/old.c\0 M User/a -> b.c\0')), ['User/new.c', 'User/old.c', 'User/a -> b.c']);
});

test('library matcher snapshot avoids file I/O and refreshes per operation', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { createLibMatcher } = require('../src/paths');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-lib-cache-'));
  try {
    fs.mkdirSync(path.join(root, '.zkz'));
    const file = path.join(root, '.zkz', 'workspace_lists.json');
    fs.writeFileSync(file, JSON.stringify({ libraryDirNames: ['Old'] }));
    const first = createLibMatcher(root);
    fs.writeFileSync(file, JSON.stringify({ libraryDirNames: ['NewLibrary'] }));
    const second = createLibMatcher(root);
    assert.ok(first('Old/a.c'));
    assert.ok(!first('NewLibrary/a.c'));
    assert.ok(second('NewLibrary/a.c'));
    const stat = fs.statSync;
    try {
      fs.statSync = () => { throw new Error('unexpected disk access'); };
      assert.ok(first('OLD\\a.c'));
    } finally { fs.statSync = stat; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('content framing preserves multi-packet binary payload', () => {
  const bytes = Buffer.alloc(MAX_PAYLOAD * 2 + 11);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const encoded = encodeContent(bytes);
  let pos = 0;
  const parts = [];
  while (pos < encoded.length) {
    const size = parseInt(encoded.toString('ascii', pos, pos + 4), 16);
    assert.ok(size <= MAX_PAYLOAD + 4);
    parts.push(encoded.subarray(pos + 4, pos + size));
    pos += size;
  }
  assert.ok(Buffer.concat(parts).equals(bytes));
});

test('sync restores a reverted edit even when a different file stays dirty', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const { syncKeilTree } = require('../src/keil_tree');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-sync-undo-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, windowsHide: true });
    assert.strictEqual(r.status, 0, String(r.stderr));
  };
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    git(['config', 'core.autocrlf', 'false']);
    fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.zkz/\n');
    fs.mkdirSync(path.join(root, 'User'));
    const a = path.join(root, 'User', 'a.c');
    const b = path.join(root, 'User', 'b.c');
    fs.writeFileSync(a, 'int a;\n');
    fs.writeFileSync(b, 'int b;\n');
    git(['add', 'User']);
    git(['commit', '-qm', 'base']);
    syncKeilTree(root);
    fs.writeFileSync(a, 'int changed;\n');
    syncKeilTree(root);
    git(['restore', '--', 'User/a.c']);
    fs.writeFileSync(b, 'int other;\n');
    syncKeilTree(root);
    const kn = path.join(root, '.zkz', 'keil-native', 'User');
    assert.strictEqual(fs.readFileSync(path.join(kn, 'a.c'), 'utf8'), 'int a;\n');
    assert.strictEqual(fs.readFileSync(path.join(kn, 'b.c'), 'utf8'), 'int other;\n');
    git(['restore', '--', 'User/b.c']);
    syncKeilTree(root);
    assert.strictEqual(fs.readFileSync(path.join(kn, 'b.c'), 'utf8'), 'int b;\n');
    assert.strictEqual(syncKeilTree(root).cacheHit, true);
    const target = path.join(kn, 'a.c');
    const targetTime = fs.statSync(target).mtime;
    fs.writeFileSync(target, 'int z;\n');
    fs.utimesSync(target, targetTime, targetTime);
    assert.strictEqual(syncKeilTree(root).written, 1);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'int a;\n');
    assert.strictEqual(syncKeilTree(root).cacheHit, true);
    fs.unlinkSync(path.join(kn, 'a.c'));
    assert.notStrictEqual(syncKeilTree(root).cacheHit, true);
    assert.strictEqual(fs.readFileSync(path.join(kn, 'a.c'), 'utf8'), 'int a;\n');
    fs.rmSync(kn, { recursive: true });
    syncKeilTree(root);
    assert.strictEqual(fs.readFileSync(path.join(kn, 'a.c'), 'utf8'), 'int a;\n');
    assert.strictEqual(fs.readFileSync(path.join(kn, 'b.c'), 'utf8'), 'int b;\n');
    fs.unlinkSync(path.join(kn, 'a.c'));
    fs.writeFileSync(b, 'int dirty;\n');
    syncKeilTree(root);
    assert.strictEqual(fs.readFileSync(path.join(kn, 'a.c'), 'utf8'), 'int a;\n');
    assert.strictEqual(fs.readFileSync(path.join(kn, 'b.c'), 'utf8'), 'int dirty;\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sync invalidates configuration and version changes and keeps project support files', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const { syncKeilTree } = require('../src/keil_tree');
  const { saveTable } = require('../src/enc_table');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-sync-config-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, windowsHide: true });
    assert.strictEqual(r.status, 0, String(r.stderr));
  };
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    git(['config', 'core.autocrlf', 'false']);
    fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.zkz/\n');
    fs.mkdirSync(path.join(root, 'User'));
    fs.writeFileSync(path.join(root, 'User', 'a.c'), '// \u4e2d\u6587\n');
    const support = ['Project/Obj/link.sct', 'Project/Flash/setup.ini', 'H750/Projects/MDK-ARM/Obj/link.scf'];
    for (const rel of support.concat(['Project/Obj/output.o', 'User/Obj/skip.sct'])) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), 'original');
    }
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    saveTable(root, { 'User/a.c': 'Utf8' });
    const kn = path.join(root, '.zkz', 'keil-native');
    syncKeilTree(root);
    assert.strictEqual(syncKeilTree(root).cacheHit, true);
    for (const rel of support) assert.strictEqual(fs.readFileSync(path.join(kn, rel), 'utf8'), 'original');
    assert.ok(!fs.existsSync(path.join(kn, 'Project/Obj/output.o')));
    assert.ok(!fs.existsSync(path.join(kn, 'User/Obj/skip.sct')));
    saveTable(root, { 'User/a.c': 'Gbk' });
    assert.notStrictEqual(syncKeilTree(root).cacheHit, true);
    assert.ok(fs.readFileSync(path.join(kn, 'User/a.c')).equals(encodeCp936('// \u4e2d\u6587\n')));
    assert.strictEqual(syncKeilTree(root).cacheHit, true);
    const stampFile = path.join(root, '.zkz', 'run', 'keil-native-stamp.json');
    const stamp = JSON.parse(fs.readFileSync(stampFile));
    stamp.version = -1;
    fs.writeFileSync(stampFile, JSON.stringify(stamp));
    assert.notStrictEqual(syncKeilTree(root).cacheHit, true);
    fs.writeFileSync(path.join(kn, 'User/a.c'), 'partial failed sync');
    fs.unlinkSync(path.join(kn, '.zkz-sync-ready'));
    syncKeilTree(root);
    assert.ok(fs.readFileSync(path.join(kn, 'User/a.c')).equals(encodeCp936('// \u4e2d\u6587\n')));
    fs.writeFileSync(path.join(root, support[0]), 'updated');
    syncKeilTree(root);
    assert.strictEqual(fs.readFileSync(path.join(kn, support[0]), 'utf8'), 'updated');
    fs.unlinkSync(path.join(root, support[0]));
    syncKeilTree(root);
    assert.ok(!fs.existsSync(path.join(kn, support[0])));
    fs.writeFileSync(path.join(root, '.zkz', 'workspace_lists.json'), JSON.stringify({ libraryDirNames: ['User'] }));
    assert.notStrictEqual(syncKeilTree(root).cacheHit, true);
    assert.ok(fs.lstatSync(path.join(kn, 'User')).isSymbolicLink());
    fs.writeFileSync(path.join(root, '.zkz', 'workspace_lists.json'), JSON.stringify({ libraryDirNames: [] }));
    syncKeilTree(root);
    assert.ok(!fs.lstatSync(path.join(kn, 'User')).isSymbolicLink());
    // A configured library created later must be linked on the next operation.
    fs.writeFileSync(path.join(root, '.zkz', 'workspace_lists.json'), JSON.stringify({ libraryDirNames: ['Later'] }));
    syncKeilTree(root);
    fs.mkdirSync(path.join(root, 'Later'));
    syncKeilTree(root);
    assert.ok(fs.lstatSync(path.join(kn, 'Later')).isSymbolicLink());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('source snapshots handle staged edits, restored timestamps, new directories and library warnings', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const { syncKeilTree } = require('../src/keil_tree');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-sync-snapshot-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, windowsHide: true });
    assert.strictEqual(r.status, 0, String(r.stderr));
  };
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    git(['config', 'core.autocrlf', 'false']);
    fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.zkz/\nProject/Obj/\n');
    fs.mkdirSync(path.join(root, 'User'));
    fs.mkdirSync(path.join(root, 'Libraries'));
    const file = path.join(root, 'User', 'a.c');
    fs.writeFileSync(file, 'int a;\n');
    const original = new Date(1000000000000);
    fs.utimesSync(file, original, original);
    const lib = path.join(root, 'Libraries', 'a.c');
    const libBytes = encodeCp936('// \u4e2d\u6587\n');
    fs.writeFileSync(lib, libBytes);
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
    const kn = path.join(root, '.zkz', 'keil-native');
    syncKeilTree(root);
    assert.strictEqual(syncKeilTree(root).cacheHit, true);
    fs.writeFileSync(file, 'int b;\n');
    fs.utimesSync(file, original, original);
    git(['add', '--renormalize', '--', 'User/a.c']);
    assert.strictEqual(syncKeilTree(root).written, 1);
    assert.strictEqual(fs.readFileSync(path.join(kn, 'User/a.c'), 'utf8'), 'int b;\n');
    // A staged change whose source is already copied must not be rewritten.
    assert.strictEqual(syncKeilTree(root).cacheHit, true);
    git(['restore', '--staged', '--worktree', '--', 'User/a.c']);
    assert.strictEqual(syncKeilTree(root).written, 1);
    assert.strictEqual(fs.readFileSync(path.join(kn, 'User/a.c'), 'utf8'), 'int a;\n');
    fs.mkdirSync(path.join(root, 'User', 'new dir'));
    fs.writeFileSync(path.join(root, 'User', 'new dir', 'new file.c'), 'int new_file;\n');
    syncKeilTree(root);
    assert.strictEqual(fs.readFileSync(path.join(kn, 'User/new dir/new file.c'), 'utf8'), 'int new_file;\n');
    fs.renameSync(path.join(root, 'User/new dir/new file.c'), path.join(root, 'User/new dir/renamed.c'));
    syncKeilTree(root);
    assert.ok(!fs.existsSync(path.join(kn, 'User/new dir/new file.c')));
    assert.ok(fs.existsSync(path.join(kn, 'User/new dir/renamed.c')));
    fs.mkdirSync(path.join(root, 'Project/Obj'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Project/Obj/ignored.sct'), 'linker');
    syncKeilTree(root);
    assert.strictEqual(fs.readFileSync(path.join(kn, 'Project/Obj/ignored.sct'), 'utf8'), 'linker');
    fs.writeFileSync(lib, '// \u4e2d\u6587\n', 'utf8');
    const write = fs.writeFileSync;
    try {
      fs.writeFileSync = function (p, ...args) {
        if (path.basename(p).startsWith('lib-encoding-warnings.json.')) throw new Error('warning write failed');
        return write.call(this, p, ...args);
      };
      syncKeilTree(root);
    } finally { fs.writeFileSync = write; }
    // The failed warning write must not consume the library change snapshot.
    assert.strictEqual(syncKeilTree(root).libWarnings.length, 1);
    assert.strictEqual(syncKeilTree(root).libWarnings.length, 1);
    fs.writeFileSync(file, 'int c;\n');
    assert.strictEqual(syncKeilTree(root).libWarnings.length, 1);
    fs.writeFileSync(lib, libBytes);
    assert.strictEqual(syncKeilTree(root).libWarnings.length, 0);
    const stat = fs.statSync;
    try {
      fs.statSync = function (p, ...args) {
        if (p === file) { const err = new Error('source denied'); err.code = 'EACCES'; throw err; }
        return stat.call(this, p, ...args);
      };
      assert.throws(() => syncKeilTree(root), /source denied/);
    } finally { fs.statSync = stat; }
    fs.rmSync(path.join(root, 'User'), { recursive: true });
    syncKeilTree(root);
    assert.ok(!fs.existsSync(path.join(kn, 'User/a.c')));
    assert.ok(!fs.existsSync(path.join(kn, 'User/new dir/renamed.c')));
    assert.strictEqual(syncKeilTree(root).cacheHit, true);
    fs.writeFileSync(path.join(root, '.git', 'index'), 'broken index');
    assert.throws(() => syncKeilTree(root), /git ls-files/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('performance log rotates and retains the latest record', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { record } = require('../../shared/perf');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-perf-'));
  try {
    record(root, 'initial', {});
    const file = path.join(root, '.zkz', 'run', 'performance.jsonl');
    fs.truncateSync(file, 5 * 1024 * 1024);
    record(root, 'latest', { ms: 1 });
    assert.strictEqual(fs.statSync(file + '.1').size, 5 * 1024 * 1024);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).phase, 'latest');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('performance timestamp is readable Beijing time across date boundaries', () => {
  const { formatTimestamp } = require('../../shared/perf');
  assert.strictEqual(formatTimestamp(new Date('2026-10-10T03:28:30.532Z')), '2026-10-10 11:28:30.532 +0800');
  assert.strictEqual(formatTimestamp(new Date('2026-10-10T18:00:00.007Z')), '2026-10-11 02:00:00.007 +0800');
});

test('encoding table cache detects replacements with a preserved mtime', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { loadTable } = require('../src/enc_table');
  const { tablePath } = require('../src/paths');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-table-stamp-'));
  try {
    const file = tablePath(root);
    fs.writeFileSync(file, JSON.stringify({ files: { 'User/a.c': 'Gbk' } }));
    const time = new Date(1000000000000);
    fs.utimesSync(file, time, time);
    assert.strictEqual(loadTable(root)['User/a.c'], 'Gbk');
    fs.writeFileSync(file, JSON.stringify({ files: { 'User/a.c': 'Utf8Bom' } }));
    fs.utimesSync(file, time, time);
    assert.strictEqual(loadTable(root)['User/a.c'], 'Utf8Bom');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detectKind ascii', () => {
  assert.strictEqual(detectKind(Buffer.from('int x;\n', 'utf8')), 'Ascii');
});

test('detectKind utf8 chinese', () => {
  assert.strictEqual(detectKind(Buffer.from('\u7a97\u53e3\n', 'utf8')), 'Utf8');
});

test('detectKind utf8bom', () => {
  const buf = Buffer.concat([UTF8_BOM, Buffer.from('\u7a97\u53e3', 'utf8')]);
  assert.strictEqual(detectKind(buf), 'Utf8Bom');
});

test('detectKind gbk', () => {
  const gbk = encodeCp936('\u7a97\u53e3\u7684\u4e2a\u6570');
  assert.strictEqual(detectKind(gbk), 'Gbk');
});

test('cp936 roundtrip chinese', () => {
  const t = '\u7a97\u53e3\u7684\u4e2a\u6570 \u52a0\u5de5\u6587\u4ef6 \u5b89\u5bcc\u83b1\u7535\u5b50';
  assert.ok(roundtripOk(t));
  assert.strictEqual(decodeCp936(encodeCp936(t)), t);
});

test('smudge/clean Gbk identity', () => {
  const blob = encodeCp936('\u4e2d\u6587\u6ce8\u91ca\nint x;\n');
  const table = { 'User/a.c': 'Gbk' };
  const wt = smudge('User/a.c', blob, table);
  assert.strictEqual(detectKind(wt), 'Utf8');
  assert.strictEqual(wt.toString('utf8'), '\u4e2d\u6587\u6ce8\u91ca\nint x;\n');
  const back = clean('User/a.c', wt, table);
  assert.ok(back.equals(blob));
});

test('smudge/clean Ascii passthrough', () => {
  const blob = Buffer.from('int main(void) { return 0; }\n');
  const table = { 'User/a.c': 'Ascii' };
  const wt = smudge('User/a.c', blob, table);
  assert.ok(wt.equals(blob));
  assert.ok(clean('User/a.c', wt, table).equals(blob));
});

test('smudge/clean Utf8 passthrough', () => {
  const blob = Buffer.from('/* \u65b0\u6587\u4ef6 */\n', 'utf8');
  const table = { 'User/new.c': 'Utf8' };
  assert.ok(smudge('User/new.c', blob, table).equals(blob));
  assert.ok(clean('User/new.c', blob, table).equals(blob));
});

test('Utf8Bom strip/restore', () => {
  const text = Buffer.from('hello', 'utf8');
  const blob = Buffer.concat([UTF8_BOM, text]);
  const table = { 'User/a.c': 'Utf8Bom' };
  const wt = smudge('User/a.c', blob, table);
  assert.ok(wt.equals(text));
  assert.ok(clean('User/a.c', wt, table).equals(blob));
});

test('new file utf8 chinese stays utf8', () => {
  const wt = Buffer.from('/* \u65b0\u589e */\n', 'utf8');
  const out = clean('User/brand_new.c', wt, {});
  assert.ok(out.equals(wt));
  assert.strictEqual(kindForNewFile(wt), 'Utf8');
  assert.strictEqual(detectKind(out), 'Utf8');
});

test('new file ascii stays ascii', () => {
  const wt = Buffer.from('int x;\n', 'utf8');
  const out = clean('User/brand_new.c', wt, {});
  assert.ok(out.equals(wt));
  assert.strictEqual(kindForNewFile(wt), 'Ascii');
});

test('new file gbk is stored as gbk', () => {
  const text = '/* \u4e2d\u6587 */\n';
  const wt = encodeCp936(text);
  const out = clean('User/bad.c', wt, {});
  assert.ok(out.equals(encodeCp936(text)));
  assert.strictEqual(kindForNewFile(wt), 'Gbk');
});

test('new file preserves text cp936 cannot store', () => {
  const wt = Buffer.from('emoji \u{1F600}\n', 'utf8');
  assert.ok(clean('User/new.c', wt, {}).equals(wt));
});

test('new source encodings survive git add and repeated Keil sync', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { writeSourceOrCopy } = require('../src/keil_tree');
  const { loadTable } = require('../src/enc_table');
  const { evaluateStagedBlob } = require('../src/precommit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-new-encoding-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, windowsHide: true });
    assert.strictEqual(r.status, 0, String(r.stderr));
    return r.stdout;
  };
  try {
    git(['init', '-q']);
    git(['config', 'core.autocrlf', 'false']);
    const filter = require.resolve('../src/filter_process').replace(/\\/g, '/');
    git(['config', 'filter.zkznative.process', '"' + process.execPath.replace(/\\/g, '/') + '" "' + filter + '"']);
    git(['config', 'filter.zkznative.required', 'true']);
    fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.c filter=zkznative -text\n');
    fs.mkdirSync(path.join(dir, 'User'));
    const text = '// \u4e2d\u6587\r\nint x;\r\n';
    const variants = [
      ['utf8', Buffer.from(text), 'Utf8+crlf'],
      ['bom', Buffer.concat([UTF8_BOM, Buffer.from(text)]), 'Utf8Bom+crlf'],
      ['gbk', encodeCp936(text), 'Gbk+crlf'],
      ['ascii', Buffer.from('int x;\r\n'), 'Ascii+crlf'],
      ['emoji', Buffer.from('// \u{1F600}\n'), 'Utf8']
    ];
    for (const [name, bytes, mapped] of variants) {
      const rel = 'User/' + name + '.c';
      fs.writeFileSync(path.join(dir, rel), bytes);
      const kn = path.join(dir, '.zkz', 'keil-native');
      for (let pass = 0; pass < 2; pass++) {
        // Exercise both first Git add and first build, then the mapped path.
        if (name !== 'utf8' || pass > 0) writeSourceOrCopy(dir, kn, loadTable(dir), rel);
        git(['add', '--', rel]);
        writeSourceOrCopy(dir, kn, loadTable(dir), rel);
        const blob = git(['show', ':' + rel]);
        assert.ok(blob.equals(bytes), name + ' staged bytes');
        assert.ok(fs.readFileSync(path.join(kn, rel)).equals(bytes), name + ' Keil bytes');
        assert.ok(fs.readFileSync(path.join(dir, rel)).equals(bytes), name + ' worktree bytes');
        assert.strictEqual(loadTable(dir)[rel], mapped);
        assert.ok(!evaluateStagedBlob(rel, blob, mapped).error);
        assert.ok(!evaluateStagedBlob(rel, blob, undefined).error);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clean Gbk passthrough leftover repo bytes', () => {
  const blob = encodeCp936('\u4e2d\u6587\u6ce8\u91ca\nint x;\n');
  assert.strictEqual(detectKind(blob), 'Gbk');
  const out = applyClean('Gbk', blob);
  assert.ok(out.equals(blob));
});

test('stripCr crlf and lone cr', () => {
  assert.ok(stripCr(Buffer.from('a\r\nb\rc\n')).equals(Buffer.from('a\nb\nc\n')));
});

test('clean strips CRLF for Ascii', () => {
  const wt = Buffer.from('int x;\r\n', 'utf8');
  const out = applyClean('Ascii', wt);
  assert.ok(out.equals(Buffer.from('int x;\n', 'utf8')));
});

test('clean keeps CRLF when table says +crlf', () => {
  const { parseMapped, encodeMapped, hasCrlf } = require('../src/encoding');
  assert.deepStrictEqual(parseMapped('Gbk+crlf'), { kind: 'Gbk', crlf: true });
  assert.strictEqual(encodeMapped('Gbk', true), 'Gbk+crlf');
  const gbk = encodeCp936('\u4e2d\u6587\r\n');
  assert.ok(hasCrlf(gbk));
  const wt = Buffer.from(decodeCp936(gbk), 'utf8');
  const out = applyClean('Gbk', wt, { crlf: true });
  assert.ok(out.equals(gbk));
});

test('clean Gbk unencodable is soft (status must not die)', () => {
  const wt = Buffer.from('emoji \u{1F600}', 'utf8');
  const out = applyClean('Gbk', wt);
  assert.ok(out.equals(wt));
  assert.ok(!roundtripOk('emoji \u{1F600}'));
});

test('lib path passthrough even if table says Gbk', () => {
  const { isLibRel } = require('../src/paths');
  const root = 'E:/work/b_01_zkz_1';
  if (!isLibRel(root, 'emWin/Include/x.h')) return;
  const wt = Buffer.from('Cortex\uFFFD-M', 'utf8');
  const table = { 'emWin/Include/x.h': 'Gbk' };
  const out = clean('emWin/Include/x.h', wt, table, root);
  assert.ok(out.equals(wt));
});

test('pkt-line encode', () => {
  const p = encodePacket(Buffer.from('ab', 'utf8'));
  assert.strictEqual(p.slice(0, 4).toString('ascii'), '0006');
  assert.strictEqual(p.slice(4).toString('utf8'), 'ab');
  assert.strictEqual(encodeFlush().toString('ascii'), '0000');
  const big = Buffer.alloc(MAX_PAYLOAD + 10, 0x61);
  const packed = encodeContent(big);
  assert.ok(packed.length > MAX_PAYLOAD);
});

test('nodeBin is real node, not the editor', () => {
  assert.ok(isNodeExecutable(nodeBin()));
  assert.ok(!isNodeExecutable('D:/ruanjian/cursor/Cursor.exe'));
});

test('attributes mark block', () => {
  const body = '*.c filter=zkznative\n*.h filter=zkznative';
  const next = replaceMarkedBlock('', body);
  assert.ok(next.indexOf(BEGIN) >= 0);
  assert.ok(next.indexOf('*.c filter=zkznative') >= 0);
  const twice = replaceMarkedBlock(next, body + '\nLibraries/** -filter');
  assert.strictEqual(twice.split(BEGIN).length, 2);
  const gone = stripMarkedBlock(twice);
  assert.ok(gone.indexOf('zkznative') < 0);
});

test('precommit rejects Gbk table with UTF-8 blob', () => {
  const { evaluateStagedBlob } = require('../src/precommit');
  const emoji = evaluateStagedBlob('core/a.c', Buffer.from('emoji \u{1F600}\n', 'utf8'), 'Gbk');
  assert.ok(emoji.error.indexOf('无法编回 cp936') >= 0);
  assert.ok(emoji.error.indexOf('请重新 git add') < 0);
  assert.strictEqual(emoji.action, 'open');
  assert.ok(emoji.position > 0);
  const chinese = evaluateStagedBlob('core/a.c', Buffer.from('\u4e2d\u6587\n', 'utf8'), 'Gbk');
  assert.ok(chinese.error.indexOf('请重新 git add：core/a.c') >= 0);
  assert.strictEqual(chinese.action, 'restage');
  assert.strictEqual(chinese.rel, 'core/a.c');
});

test('precommit accepts Gbk blob for Gbk table', () => {
  const { evaluateStagedBlob } = require('../src/precommit');
  const blob = encodeCp936('\u4e2d\u6587\u6ce8\u91ca\nint x;\n');
  const r = evaluateStagedBlob('core/a.c', blob, 'Gbk');
  assert.ok(!r.error);
});

test('precommit accepts new file stored as Gbk', () => {
  const { evaluateStagedBlob } = require('../src/precommit');
  const blob = encodeCp936('\u4e2d\u6587\n');
  const r = evaluateStagedBlob('core/new.c', blob, undefined);
  assert.ok(!r.error);
});

test('precommit accepts new utf8 chinese blob', () => {
  const { evaluateStagedBlob } = require('../src/precommit');
  const blob = Buffer.from('\u4e2d\u6587\n', 'utf8');
  const r = evaluateStagedBlob('core/new.c', blob, undefined);
  assert.ok(!r.error);
});


test('parseNameStatusZ follows -z fields for M/A/D/R/C', () => {
  const { parseNameStatusZ } = require('../src/git_status');
  const z = String.fromCharCode(0);
  const out = [
    'M', 'core/keep.c',
    'A', 'core/new.c',
    'D', 'core/gone.h',
    'R100', 'User/old.c', 'User/new.c',
    'C075', 'lib/a.c', 'lib/b.c'
  ].join(z) + z;
  const p = parseNameStatusZ(out);
  const rec = (code) => p.records.filter((r) => r.status === code)[0];
  assert.strictEqual(rec('M').path, 'core/keep.c');
  assert.strictEqual(rec('A').path, 'core/new.c');
  assert.strictEqual(rec('D').path, 'core/gone.h');
  assert.strictEqual(rec('R').oldPath, 'User/old.c');
  assert.strictEqual(rec('R').path, 'User/new.c');
  assert.strictEqual(rec('C').oldPath, 'lib/a.c');
  assert.strictEqual(rec('C').path, 'lib/b.c');
  assert.ok(p.added.indexOf('core/keep.c') >= 0);
  assert.ok(p.added.indexOf('core/new.c') >= 0);
  assert.ok(p.removed.indexOf('core/gone.h') >= 0);
  assert.ok(p.removed.indexOf('User/old.c') >= 0);
  assert.ok(p.added.indexOf('User/new.c') >= 0);
  assert.ok(p.removed.indexOf('lib/a.c') >= 0);
  assert.ok(p.added.indexOf('lib/b.c') >= 0);
});

test('parseNameStatusZ reads real git diff -z output', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { parseNameStatusZ } = require('../src/git_status');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-ns-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(args.join(' ') + '\n' + r.stderr);
    return r;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'keep.c'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'gone.h'), 'g\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'old.c'), 'old\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src.c'), 'same\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  fs.writeFileSync(path.join(dir, 'keep.c'), 'a\nb\n', 'utf8');
  fs.unlinkSync(path.join(dir, 'gone.h'));
  fs.writeFileSync(path.join(dir, 'new.c'), 'new\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src.c'), 'same\nx\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src2.c'), 'same\n', 'utf8');
  git(['mv', 'old.c', 'moved.c']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'edit']);
  const diff = git(['diff', '--name-status', '--find-copies-harder', '-z', 'HEAD~1', 'HEAD']);
  const p = parseNameStatusZ(diff.stdout);
  const has = (code, file) => p.records.some((r) => r.status === code && (r.path === file || r.oldPath === file));
  assert.ok(has('M', 'keep.c'), JSON.stringify(p.records));
  assert.ok(has('A', 'new.c'), JSON.stringify(p.records));
  assert.ok(has('D', 'gone.h'), JSON.stringify(p.records));
  assert.ok(p.records.some((r) => r.status === 'R' && r.oldPath === 'old.c' && r.path === 'moved.c'), JSON.stringify(p.records));
  assert.ok(p.records.some((r) => r.status === 'C' && r.path === 'src2.c'), JSON.stringify(p.records));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('countByKind folds crlf into the base kind', () => {
  const { countByKind } = require('../src/enc_table');
  const c = countByKind({ 'a.c': 'Gbk+crlf', 'b.c': 'Gbk', 'c.h': 'Utf8Bom+crlf', 'd.h': 'Utf8' });
  assert.strictEqual(c.Gbk, 2);
  assert.strictEqual(c.Utf8Bom, 1);
  assert.strictEqual(c.Utf8, 1);
  assert.strictEqual(c['Gbk+crlf'], undefined);
});

test('loadMeta reuses the loadTable cache', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { loadTable, loadMeta } = require('../src/enc_table');
  const { tablePath } = require('../src/paths');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-meta-'));
  const file = tablePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    head: 'abc',
    ref: 'refs/heads/main',
    files: { 'a.c': 'Gbk+crlf' }
  }), 'utf8');
  assert.strictEqual(loadTable(dir)['a.c'], 'Gbk+crlf');
  const a = loadMeta(dir);
  const b = loadMeta(dir);
  assert.strictEqual(a, b);
  assert.strictEqual(a.head, 'abc');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    head: 'def',
    ref: 'refs/heads/main',
    files: { 'a.c': 'Utf8' }
  }), 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  const c = loadMeta(dir);
  assert.notStrictEqual(c, a);
  assert.strictEqual(c.head, 'def');
  assert.strictEqual(loadTable(dir)['a.c'], 'Utf8');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commandPathsExist missing and present', () => {
  const { commandPathsExist, quoteCmd } = require('../src/git_config');
  assert.strictEqual(commandPathsExist('"C:/no/such/node.exe" "C:/no/such/filter.js"'), false);
  assert.ok(commandPathsExist(quoteCmd(process.execPath.replace(/\\/g, '/'), __filename.replace(/\\/g, '/'))));
});

test('smudge table Utf8 but blob is Gbk', () => {
  const blob = encodeCp936('\u4e2d\u6587\u6ce8\u91ca\nint x;\n');
  const table = { 'User/a.c': 'Utf8' };
  const wt = smudge('User/a.c', blob, table);
  assert.strictEqual(wt.toString('utf8'), '\u4e2d\u6587\u6ce8\u91ca\nint x;\n');
});

test('smudge table Gbk but blob is Utf8', () => {
  const blob = Buffer.from('/* \u4e2d\u6587 */\n', 'utf8');
  const table = { 'User/a.c': 'Gbk' };
  const wt = smudge('User/a.c', blob, table);
  assert.ok(wt.equals(blob));
  assert.strictEqual(detectKind(wt), 'Utf8');
});

test('smudge BOM blob stays Utf8Bom even if table says Utf8', () => {
  const text = Buffer.from('hello', 'utf8');
  const blob = Buffer.concat([UTF8_BOM, text]);
  const table = { 'User/a.c': 'Utf8' };
  const wt = smudge('User/a.c', blob, table);
  assert.ok(wt.equals(text));
});

test('reconcileSmudgeKind utf family vs gbk', () => {
  const { reconcileSmudgeKind } = require('../src/filter_core');
  assert.strictEqual(reconcileSmudgeKind('Gbk', 'Utf8'), 'Gbk');
  assert.strictEqual(reconcileSmudgeKind('Utf8', 'Gbk'), 'Utf8');
  assert.strictEqual(reconcileSmudgeKind('Utf8Bom', 'Utf8'), 'Utf8Bom');
  assert.strictEqual(reconcileSmudgeKind('Utf8', 'Utf8Bom'), 'Utf8Bom');
});

test('undecodable gbk byte round-trips', () => {
  let drop = null;
  const blob = Buffer.from([0x20, 0x96, 0x20, 0x53, 0x42]);
  const wt = applySmudge('Gbk', blob, { onDrop: (info) => { drop = info; } });
  assert.ok(wt.toString('utf8').indexOf('\uFFFD') < 0);
  assert.strictEqual(wt.toString('utf8').charCodeAt(1), 0xE096);
  assert.strictEqual(drop.count, 0);
  assert.ok(applyClean('Gbk', wt).equals(blob));
  assert.ok(roundtripOk(wt.toString('utf8')));
});

test('clean drops U+FFFD without soft fail', () => {
  let hit = 0;
  let drop = null;
  const wt = Buffer.from('     \uFFFD SB54, SB55 OFF\n', 'utf8');
  const out = applyClean('Gbk', wt, {
    onSoftFail: () => { hit += 1; },
    onDrop: (info) => { drop = info; }
  });
  assert.strictEqual(hit, 0);
  assert.ok(out.equals(encodeCp936('      SB54, SB55 OFF\n')));
  assert.ok(roundtripOk('\uFFFD SB54'));
  assert.strictEqual(drop.stage, 'clean');
  assert.strictEqual(drop.count, 1);
  assert.deepStrictEqual(drop.positions, [5]);
  assert.ok(drop.message.indexOf('U+FFFD at 5') >= 0);
});

test('clean Gbk unencodable calls onSoftFail', () => {
  let hit = 0;
  const wt = Buffer.from('emoji \u{1F600}', 'utf8');
  const out = applyClean('Gbk', wt, { onSoftFail: () => { hit += 1; } });
  assert.ok(out.equals(wt));
  assert.strictEqual(hit, 1);
});

test('atomicWriteJson roundtrip', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { atomicWriteJson } = require('../src/paths');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-at-'));
  const p = path.join(dir, 't.json');
  atomicWriteJson(p, { a: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 });
  atomicWriteJson(p, { a: 2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 2 });
});

test('quotedPaths extracts both args', () => {
  const { quotedPaths } = require('../src/git_config');
  const paths = quotedPaths('"C:/n/node.exe" "D:/ext/src/filter_process.js"');
  assert.deepStrictEqual(paths, ['C:/n/node.exe', 'D:/ext/src/filter_process.js']);
});

test('clean Gbk unencodable records sidecar', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { loadRoundtripFailures, clearRoundtripFailure } = require('../src/observe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-rt-'));
  const wt = Buffer.from('emoji \u{1F600}', 'utf8');
  const table = { 'User/a.c': 'Gbk' };
  fs.mkdirSync(path.join(dir, 'User'));
  fs.writeFileSync(path.join(dir, 'User', 'a.c'), wt);
  clean('User/a.c', wt, table, dir);
  const list = loadRoundtripFailures(dir);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].rel, 'User/a.c');
  clearRoundtripFailure(dir, 'User/a.c');
  assert.strictEqual(loadRoundtripFailures(dir).length, 0);
});

test('cp936 drop is recorded and cleared when that stage no longer drops', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { loadCp936Drops, loadRoundtripFailures } = require('../src/observe');
  const { roundtripFailPath } = require('../src/paths');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-drop-'));
  try {
    const rel = 'User/bsp/system_stm32f4xx.c';
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const broken = Buffer.from('     \uFFFD SB54\n', 'utf8');
    fs.writeFileSync(file, broken);
    const table = {};
    table[rel] = 'Gbk';
    clean(rel, broken, table, dir);
    const listed = loadCp936Drops(dir);
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(loadRoundtripFailures(dir).length, 0);
    assert.strictEqual(listed[0].rel, rel);
    assert.strictEqual(listed[0].count, 1);
    assert.deepStrictEqual(listed[0].stages, ['clean']);
    assert.ok(listed[0].message.indexOf('clean dropped 1 U+FFFD at 5') >= 0);
    const saved = JSON.parse(fs.readFileSync(roundtripFailPath(dir), 'utf8'));
    assert.ok(saved.drops[rel].clean);
    assert.strictEqual(fs.existsSync(path.join(dir, '.zkz', 'run', 'cp936-drops.json')), false);
    smudge(rel, Buffer.from([0x81, 0x20, 0x41]), table, dir);
    const afterSmudge = loadCp936Drops(dir);
    assert.strictEqual(afterSmudge.length, 1);
    assert.deepStrictEqual(afterSmudge[0].stages, ['clean']);
    const plain = Buffer.from('      SB54\n', 'utf8');
    fs.writeFileSync(file, plain);
    clean(rel, plain, table, dir);
    assert.strictEqual(loadCp936Drops(dir).length, 0);
    assert.ok(fs.existsSync(roundtripFailPath(dir)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('roundtrip status ignores removed paths without deleting historical records', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { recordRoundtripFailure, loadRoundtripFailures } = require('../src/observe');
  const { roundtripFailPath } = require('../src/paths');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-rt-history-'));
  try {
    const rel = 'User/bsp/system_stm32f4xx.c';
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'broken');
    recordRoundtripFailure(root, rel, new Error('cp936 roundtrip failed'));
    assert.strictEqual(loadRoundtripFailures(root).length, 1);
    fs.mkdirSync(path.join(root, 'driver', 'bsp'), { recursive: true });
    fs.renameSync(file, path.join(root, 'driver', 'bsp', 'system_stm32f4xx.c'));
    assert.strictEqual(loadRoundtripFailures(root).length, 0);
    assert.ok(JSON.parse(fs.readFileSync(roundtripFailPath(root), 'utf8')).files[rel]);
    fs.writeFileSync(file, 'broken again');
    assert.strictEqual(loadRoundtripFailures(root).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('config overlay seed/restore across branch loss', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { seedOverlay, restoreOverlay, overlaySeeded } = require('../src/overlay');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-overlay-'));
  try {
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
    const cfg = path.join(root, '.vscode', 'settings.json');
    fs.writeFileSync(cfg, '{ "local": true }', 'utf8');
    const { overlayDrift } = require('../src/overlay');
    assert.strictEqual(overlayDrift(root), 'missing');
    assert.ok(!overlaySeeded(root));
    assert.ok(seedOverlay(root).seeded.indexOf('.vscode/settings.json') >= 0);
    assert.ok(overlaySeeded(root));
    assert.strictEqual(overlayDrift(root), 'same');
    fs.writeFileSync(cfg, '{ "local": false }', 'utf8');
    assert.strictEqual(overlayDrift(root), 'changed');
    fs.writeFileSync(cfg, '{ "local": true }', 'utf8');
    assert.strictEqual(overlayDrift(root), 'same');
    fs.unlinkSync(cfg);
    assert.ok(restoreOverlay(root).restored.indexOf('.vscode/settings.json') >= 0);
    assert.strictEqual(fs.readFileSync(cfg, 'utf8'), '{ "local": true }');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config_paths merge lists for overlay save/restore', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { atomicWriteJson, configPathsFile } = require('../src/paths');
  const { loadConfigPaths } = require('../src/config_paths');
  const { seedOverlay, restoreOverlay } = require('../src/overlay');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-cfgp-'));
  try {
    atomicWriteJson(configPathsFile(root), {
      skipWorktree: ['.cursor'],
      forbidStage: ['.vscode', 'AGENTS.md']
    });
    const cfg = loadConfigPaths(root);
    assert.ok(!fs.existsSync(configPathsFile(root)));
    const stored = JSON.parse(fs.readFileSync(path.join(root, '.zkz', 'settings.json'), 'utf8'));
    assert.ok(stored.native.paths.indexOf('.cursor') >= 0);
    assert.ok(stored.native.paths.indexOf('AGENTS.md') >= 0);
    assert.ok(cfg.overlay.indexOf('.cursor') >= 0);
    assert.ok(cfg.overlay.indexOf('.vscode') >= 0);
    assert.ok(cfg.overlay.indexOf('AGENTS.md') >= 0);
    assert.ok(cfg.skipWorktree.indexOf('.cursor') >= 0);
    fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor', 'rules', 'a.mdc'), 'rule', 'utf8');
    fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'agents', 'utf8');
    const seeded = seedOverlay(root).seeded;
    assert.ok(seeded.indexOf('.cursor/rules/a.mdc') >= 0);
    assert.ok(seeded.indexOf('.vscode/settings.json') >= 0);
    assert.ok(seeded.indexOf('AGENTS.md') >= 0);
    fs.unlinkSync(path.join(root, '.cursor', 'rules', 'a.mdc'));
    fs.unlinkSync(path.join(root, 'AGENTS.md'));
    fs.writeFileSync(path.join(root, '.cursor', 'extra.txt'), 'extra', 'utf8');
    fs.writeFileSync(path.join(root, '.vscode', 'extra.json'), 'extra', 'utf8');
    const restored = restoreOverlay(root).restored;
    assert.ok(restored.indexOf('.cursor/rules/a.mdc') >= 0);
    assert.ok(restored.indexOf('AGENTS.md') >= 0);
    assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'agents');
    assert.ok(fs.existsSync(path.join(root, '.cursor', 'rules', 'a.mdc')));
    assert.ok(!fs.existsSync(path.join(root, '.cursor', 'extra.txt')));
    assert.ok(!fs.existsSync(path.join(root, '.vscode', 'extra.json')));
    assert.strictEqual(fs.readFileSync(path.join(root, '.vscode', 'settings.json'), 'utf8'), '{}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore keeps directories and gitkeep files', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { atomicWriteJson, configPathsFile } = require('../src/paths');
  const { seedOverlay, restoreOverlay } = require('../src/overlay');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-keep-'));
  try {
    atomicWriteJson(configPathsFile(root), { paths: ['.cursor'] });
    fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor', 'rules', 'a.mdc'), 'rule', 'utf8');
    seedOverlay(root);
    const commands = path.join(root, '.cursor', 'commands');
    const nested = path.join(commands, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(commands, '.gitkeep'), '', 'utf8');
    fs.writeFileSync(path.join(commands, 'gitkeep'), 'plain', 'utf8');
    fs.writeFileSync(path.join(commands, 'old.md'), 'gone', 'utf8');
    fs.writeFileSync(path.join(nested, 'x.txt'), 'gone', 'utf8');
    fs.writeFileSync(path.join(nested, '.gitkeep'), '', 'utf8');
    fs.mkdirSync(path.join(root, '.cursor', 'emptyish'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor', 'emptyish', 'only.txt'), 'gone', 'utf8');
    fs.unlinkSync(path.join(root, '.cursor', 'rules', 'a.mdc'));
    restoreOverlay(root);
    assert.strictEqual(fs.readFileSync(path.join(root, '.cursor', 'rules', 'a.mdc'), 'utf8'), 'rule');
    assert.ok(fs.existsSync(commands));
    assert.ok(fs.existsSync(nested));
    assert.ok(fs.existsSync(path.join(root, '.cursor', 'emptyish')));
    assert.ok(fs.existsSync(path.join(commands, '.gitkeep')));
    assert.strictEqual(fs.readFileSync(path.join(commands, 'gitkeep'), 'utf8'), 'plain');
    assert.ok(fs.existsSync(path.join(nested, '.gitkeep')));
    assert.ok(!fs.existsSync(path.join(commands, 'old.md')));
    assert.ok(!fs.existsSync(path.join(nested, 'x.txt')));
    assert.ok(!fs.existsSync(path.join(root, '.cursor', 'emptyish', 'only.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadFilterFail stale count decays to 0', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { formatLocalNow, filterFailPath, atomicWriteJson } = require('../src/paths');
  const { loadFilterFail, FILTER_FAIL_STALE_MS } = require('../src/observe');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-ff-'));
  const old = formatLocalNow(new Date(Date.now() - FILTER_FAIL_STALE_MS - 1000));
  atomicWriteJson(filterFailPath(dir), { count: 21, at: old, last: 'unsupported filter handshake', notified: true });
  const ff = loadFilterFail(dir);
  assert.strictEqual(ff.count, 0);
});

test('gitArgs injects required=false only in hook', () => {
  const { gitArgs } = require('../src/git_exec');
  const prev = process.env.ZKZ_NATIVE_HOOK;
  try {
    delete process.env.ZKZ_NATIVE_HOOK;
    assert.deepStrictEqual(gitArgs(['status']), ['status']);
    process.env.ZKZ_NATIVE_HOOK = '1';
    assert.deepStrictEqual(gitArgs(['status']), ['-c', 'filter.zkznative.required=false', 'status']);
  } finally {
    if (prev == null) delete process.env.ZKZ_NATIVE_HOOK;
    else process.env.ZKZ_NATIVE_HOOK = prev;
  }
});

test('HOOKS are only pre-commit and pre-push', () => {
  const { HOOKS, LEGACY_REFRESH_HOOKS } = require('../src/hooks');
  assert.deepStrictEqual(HOOKS.slice().sort(), ['pre-commit', 'pre-push']);
  assert.ok(LEGACY_REFRESH_HOOKS.indexOf('post-checkout') >= 0);
});

test('installHooks strips legacy post-checkout native block', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { BEGIN, END, replaceMarkedBlock } = require('../src/git_config');
  const { installHooks, hookFile } = require('../src/hooks');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-hk-'));
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  const body = replaceMarkedBlock('', '# zkz-native post-checkout\necho native\n');
  fs.writeFileSync(hookFile(root, 'post-checkout'), '#!/bin/sh\n' + body + '\n# project keep\necho keep\n', 'utf8');
  installHooks(root, path.join(__dirname, '..'));
  const post = fs.readFileSync(hookFile(root, 'post-checkout'), 'utf8');
  assert.ok(post.indexOf(BEGIN) < 0);
  assert.ok(post.indexOf(END) < 0);
  assert.ok(post.indexOf('echo keep') >= 0);
  assert.ok(fs.existsSync(hookFile(root, 'pre-commit')));
  assert.ok(fs.existsSync(hookFile(root, 'pre-push')));
  const pre = fs.readFileSync(hookFile(root, 'pre-commit'), 'utf8');
  assert.ok(pre.indexOf('hook_runner.js') >= 0);
  assert.ok(pre.indexOf('pre-commit') >= 0);
  assert.ok(pre.indexOf('_zkz_native_status') >= 0);
  assert.ok(pre.indexOf('\nexec ') < 0);
});

test('readHeadOid loose ref, detached, packed-refs', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { readHeadOid } = require('../src/git_exec');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-head-'));
  const git = path.join(root, '.git');
  const oid = '0123456789abcdef0123456789abcdef01234567';
  const detached = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const packed = 'fedcba9876543210fedcba9876543210fedcba98';
  try {
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), oid + '\n', 'utf8');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    assert.strictEqual(readHeadOid(root), oid);
    fs.writeFileSync(path.join(git, 'HEAD'), detached + '\n', 'utf8');
    assert.strictEqual(readHeadOid(root), detached);
    fs.rmSync(path.join(git, 'refs', 'heads', 'main'));
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/packed\n', 'utf8');
    fs.writeFileSync(path.join(git, 'packed-refs'), '# pack\n' + packed + ' refs/heads/packed\n', 'utf8');
    assert.strictEqual(readHeadOid(root), packed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readHeadName ignores same-branch commit and undo', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { readHeadName, readHeadOid } = require('../src/git_exec');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-headname-'));
  const git = path.join(root, '.git');
  const oid = '0123456789abcdef0123456789abcdef01234567';
  const next = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const detached = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  try {
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), oid + '\n', 'utf8');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'refs/heads/main');
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), next + '\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'refs/heads/main');
    assert.strictEqual(readHeadOid(root), next);
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), oid + '\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'refs/heads/main');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/dev\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'refs/heads/dev');
    fs.writeFileSync(path.join(git, 'HEAD'), detached + '\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'detached');
    fs.writeFileSync(path.join(git, 'HEAD'), next + '\n', 'utf8');
    assert.strictEqual(readHeadName(root), 'detached');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tableDrift ignores same-branch commit and flags a branch switch', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { tableDrift } = require('../src/bootstrap');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-drift-'));
  const git = path.join(root, '.git');
  const oid = '0123456789abcdef0123456789abcdef01234567';
  const next = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const table = path.join(root, '.zkz', 'run', '.workspace_source_encodings.json');
  try {
    fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), next + '\n', 'utf8');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    fs.mkdirSync(path.dirname(table), { recursive: true });
    fs.writeFileSync(table, JSON.stringify({
      version: 1,
      head: oid,
      files: { 'a.c': 'Utf8' }
    }), 'utf8');
    assert.strictEqual(tableDrift(root), false);
    const stamped = JSON.parse(fs.readFileSync(table, 'utf8'));
    assert.strictEqual(stamped.ref, 'refs/heads/main');
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/dev\n', 'utf8');
    assert.strictEqual(tableDrift(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lib encoding flags gbk-to-utf8 and fffd, not ascii edits', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { encodeCp936 } = require('../src/encoding');
  const { judgeLibChange, saveLibWarnings, loadLibWarnings } = require('../src/lib_encoding');
  const gbk = encodeCp936('// \u4e2d\u6587\n');
  const utf8 = Buffer.from('// \u4e2d\u6587\n', 'utf8');
  const drift = judgeLibChange('Libraries/a.c', gbk, utf8, true);
  assert.ok(drift && drift.reasons.indexOf('drift') >= 0);
  assert.strictEqual(drift.blobKind, 'Gbk');
  assert.strictEqual(drift.wtKind, 'Utf8');
  const ascii = judgeLibChange('Libraries/b.c', Buffer.from('int x;\n'), Buffer.from('int y;\n'), true);
  assert.strictEqual(ascii, null);
  const gbk2 = encodeCp936('// \u6ce8\u91ca\n');
  assert.strictEqual(judgeLibChange('Libraries/c.c', gbk, gbk2, true), null);
  // Libraries bypass clean/smudge; valid non-CP936 bytes are not a warning.
  const nonCp936 = Buffer.from('/* Cortex\u00ae-M */\n', 'utf8');
  assert.strictEqual(judgeLibChange('Libraries/e.h', nonCp936, nonCp936, true), null);
  const broken = Buffer.concat([Buffer.from('int '), Buffer.from([0xEF, 0xBF, 0xBD])]);
  const fffd = judgeLibChange('Libraries/d.c', gbk, broken, true);
  assert.ok(fffd && fffd.reasons.indexOf('fffd') >= 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-libenc-'));
  try {
    saveLibWarnings(root, [drift]);
    const loaded = loadLibWarnings(root);
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].rel, 'Libraries/a.c');
    saveLibWarnings(root, []);
    assert.strictEqual(loadLibWarnings(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status label and encoding actions', () => {
  const { barLabel, encodingActions } = require('../src/bootstrap');
  assert.strictEqual(barLabel({ installed: false }), 'native 关');
  assert.strictEqual(barLabel({ installed: true }), 'native 开');
  assert.strictEqual(barLabel({ installed: true, filterFails: 3, roundtripFails: ['a.c'] }), 'native 开');
  assert.strictEqual(barLabel({ installed: true, roundtripFails: ['a.c'], libWarnings: [{}] }), 'native 开');
  assert.strictEqual(barLabel({ installed: true, libWarnings: [{}] }), 'native 开');
  assert.strictEqual(barLabel({ installed: true, commitRejects: [{ rel: 'a.c' }] }), 'native 开');
  assert.strictEqual(barLabel({ installed: true, unstable: ['a.c'] }), 'native 开');
  const actions = encodingActions({
    commitRejects: [
      { rel: 'User/a.c', action: 'restage', message: '请重新 git add' },
      { rel: 'User/b.c', action: 'open', message: 'User/b.c: 无法编回', position: 4 }
    ],
    roundtripItems: [{ rel: 'User/a.c', message: 'cp936 roundtrip failed (U+1F600 at 2)' }, { rel: 'User/c.c', message: 'failed at 9' }],
    cp936DropItems: [{ rel: 'User/d.c', positions: [3], message: '' }],
    unstable: ['User/e.c', 'User/b.c']
  });
  assert.deepStrictEqual(actions.restage.map((x) => x.rel), ['User/a.c']);
  assert.deepStrictEqual(actions.opens.map((x) => x.rel), ['User/b.c', 'User/c.c', 'User/d.c']);
  assert.strictEqual(actions.opens[1].position, 9);
  assert.strictEqual(actions.opens[2].position, 3);
  assert.deepStrictEqual(actions.unstable, ['User/e.c']);
});

test('commit rejection is recorded for the status bar', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { recordCommitReject, loadCommitRejects, dismissCommitReject, clearCommitReject } = require('../src/observe');
  const { evaluateStagedBlob } = require('../src/precommit');
  const { commitRejectPath } = require('../src/paths');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-reject-'));
  try {
    const rel = 'User/a.c';
    fs.mkdirSync(path.join(root, 'User'), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
    const restage = evaluateStagedBlob(rel, Buffer.from('\u4e2d\u6587\n', 'utf8'), 'Gbk');
    const open = evaluateStagedBlob(rel, Buffer.from('emoji \u{1F600}\n', 'utf8'), 'Gbk');
    assert.strictEqual(restage.action, 'restage');
    assert.strictEqual(restage.rel, rel);
    assert.strictEqual(open.action, 'open');
    assert.ok(open.position > 0);
    recordCommitReject(root, [restage, open]);
    assert.strictEqual(loadCommitRejects(root).length, 2);
    dismissCommitReject(root, ['User/a.c'], 'restage');
    const left = loadCommitRejects(root);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].action, 'open');
    clearCommitReject(root);
    assert.ok(!fs.existsSync(commitRejectPath(root)));
    assert.strictEqual(loadCommitRejects(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fixed worktree clears a stale commit rejection', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const { encodeCp936 } = require('../src/encoding');
  const { saveTable } = require('../src/enc_table');
  const { recordCommitReject } = require('../src/observe');
  const { reconcileCommitReject } = require('../src/precommit');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-reconcile-'));
  const git = (args, input) => {
    const r = spawnSync('git', args, { cwd: root, input: input, windowsHide: true, encoding: input ? undefined : 'utf8' });
    assert.strictEqual(r.status, 0, String(r.stderr || r.stdout));
    return Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8').trim() : String(r.stdout || '').trim();
  };
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(root, 'a.c'), '\u4e2d\u6587\n', 'utf8');
    git(['add', 'a.c']);
    saveTable(root, { 'a.c': 'Gbk' });
    recordCommitReject(root, [{ rel: 'a.c', action: 'open', message: 'a.c: old' }]);
    let left = reconcileCommitReject(root);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].action, 'restage');
    fs.writeFileSync(path.join(root, 'a.c'), 'emoji \u{1F600}\n', 'utf8');
    left = reconcileCommitReject(root);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].action, 'open');
    fs.writeFileSync(path.join(root, 'a.c'), '\u4e2d\u6587\n', 'utf8');
    const sha = git(['hash-object', '-w', '--stdin'], encodeCp936('\u4e2d\u6587\n'));
    git(['update-index', '--cacheinfo', '100644,' + sha + ',a.c']);
    left = reconcileCommitReject(root);
    assert.strictEqual(left.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ascii staged chinese asks to restage and emoji does not', () => {
  const { evaluateStagedBlob } = require('../src/precommit');
  const chinese = evaluateStagedBlob('core/a.c', Buffer.from('\u4e2d\u6587\n', 'utf8'), 'Ascii');
  assert.ok(chinese.error.indexOf('请重新 git add') >= 0);
  const emoji = evaluateStagedBlob('core/a.c', Buffer.from('emoji \u{1F600}\n', 'utf8'), 'Ascii');
  assert.ok(emoji.error.indexOf('无法编回 cp936') >= 0);
  assert.ok(/at \d+/.test(emoji.error));
});

function finish(extraFailed) {
  const n = failed + (extraFailed || 0);
  if (n) {
    console.log('\n' + n + ' failed');
    process.exit(1);
  }
  console.log('\nall passed');
}

async function runAsync() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { spawn } = require('child_process');
  const { Readable } = require('stream');
  let extra = 0;

  function ok(name) { console.log('ok  ' + name); }
  function fail(name, e) {
    extra += 1;
    console.log('FAIL ' + name);
    console.log('  ' + (e && e.stack ? e.stack : e));
  }

  try {
    const { PktReader } = require('../src/pktline');
    const stream = new Readable({ read() { } });
    const reader = new PktReader(stream);
    const error = new Error('input transport failed');
    const pending = assert.rejects(reader.readPacket(), (err) => err === error);
    stream.destroy(error);
    await pending;
    await assert.rejects(reader.readPacket(), (err) => err === error);
    assert.strictEqual(reader.buffered, 0);
    ok('pkt-line input preserves stream errors for pending and future reads');
  } catch (e) {
    fail('pkt-line input preserves stream errors for pending and future reads', e);
  }

  try {
    const { Writable } = require('stream');
    const { writeContent, writeAll } = require('../src/pktline');
    const body = Buffer.alloc(MAX_PAYLOAD * 2 + 17, 0xa5);
    const packets = [];
    const sink = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        assert.ok(chunk.length <= MAX_PAYLOAD + 4);
        packets.push(Buffer.from(chunk));
        setImmediate(callback);
      }
    });
    await writeContent(sink, body);
    assert.ok(Buffer.concat(packets).equals(encodeContent(body)));
    assert.strictEqual(sink.listenerCount('drain'), 0);
    assert.strictEqual(sink.listenerCount('error'), 0);
    const error = new Error('output transport failed');
    const broken = new Writable({ write(_chunk, _encoding, callback) { setImmediate(() => callback(error)); } });
    await assert.rejects(writeAll(broken, Buffer.from('test')), (err) => err === error);
    const closing = new Writable({ write() { this.destroy(); } });
    await assert.rejects(writeAll(closing, Buffer.from('test')), /output closed/);
    ok('pkt-line output respects backpressure, bounds packets and rejects failures');
  } catch (e) {
    fail('pkt-line output respects backpressure, bounds packets and rejects failures', e);
  }

  try {
    const { PktReader, encodeContent, encodeFlush, MAX_PAYLOAD } = require('../src/pktline');
    const bytes = Buffer.alloc(MAX_PAYLOAD * 2 + 11);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const wire = Buffer.concat([encodeContent(bytes), encodeFlush()]);
    const stream = new Readable({ read() { } });
    const reader = new PktReader(stream);
    const result = reader.readBinaryUntilFlush();
    // Yield between fragments so both pending header and payload reads resume.
    const sizes = [1, 2, 1, 3, 8191, 7, 65519];
    let pos = 0;
    let part = 0;
    while (pos < wire.length) {
      const end = Math.min(wire.length, pos + sizes[part++ % sizes.length]);
      stream.push(wire.subarray(pos, end));
      pos = end;
      await new Promise((resolve) => setImmediate(resolve));
    }
    stream.push(null);
    const decoded = await result;
    assert.strictEqual(decoded.eof, false);
    assert.ok(decoded.data.equals(bytes));
    assert.strictEqual(await reader.readPacket(), null);
    assert.strictEqual(reader.buffered, 0);
    assert.deepStrictEqual(reader.chunks, []);
    ok('pkt-line fragmented multi-packet binary input releases consumed chunks');
  } catch (e) {
    fail('pkt-line fragmented multi-packet binary input releases consumed chunks', e);
  }

  try {
    const { PktReader, encodeContent, encodeFlush, MAX_PAYLOAD } = require('../src/pktline');
    const bytes = Buffer.alloc(MAX_PAYLOAD * 16, 0x61);
    const wire = Buffer.concat([encodeContent(bytes), encodeFlush()]);
    let offset = 0;
    const stream = new Readable({
      highWaterMark: 16384,
      read() {
        if (offset === wire.length) { this.push(null); return; }
        const end = Math.min(wire.length, offset + 16384);
        this.push(wire.subarray(offset, end));
        offset = end;
      }
    });
    const reader = new PktReader(stream);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(stream.isPaused());
    assert.ok(reader.buffered <= 4 * (MAX_PAYLOAD + 4) + 16384);
    assert.ok(offset < wire.length, 'producer must stop while the consumer is idle');
    const result = await reader.readBinaryUntilFlush();
    assert.ok(result.data.equals(bytes));
    assert.strictEqual(await reader.readPacket(), null);
    assert.strictEqual(reader.buffered, 0);
    ok('pkt-line input pauses idle consumers and resumes without losing bytes');
  } catch (e) {
    fail('pkt-line input pauses idle consumers and resumes without losing bytes', e);
  }

  try {
    const { PktReader } = require('../src/pktline');
    const stream = new Readable({ read() { } });
    const reader = new PktReader(stream);
    const first = reader.readPacket();
    stream.push(Buffer.from('0008ab', 'ascii'));
    await new Promise((resolve) => setImmediate(resolve));
    const second = reader.readPacket();
    stream.push(Buffer.from('cd0007xyz0000000100020004', 'ascii'));
    stream.push(null);
    assert.strictEqual((await first).data.toString(), 'abcd');
    assert.strictEqual((await second).data.toString(), 'xyz');
    assert.strictEqual((await reader.readPacket()).flush, true);
    assert.strictEqual((await reader.readPacket()).special, '0001');
    assert.strictEqual((await reader.readPacket()).special, '0002');
    assert.strictEqual((await reader.readPacket()).data.length, 0);
    assert.strictEqual(await reader.readPacket(), null);
    ok('pkt-line overlapping reads preserve order and special packets');
  } catch (e) {
    fail('pkt-line overlapping reads preserve order and special packets', e);
  }

  try {
    const { PktReader } = require('../src/pktline');
    for (const [wire, error] of [
      ['00', /truncated pkt-line header/],
      ['0008ab', /truncated pkt-line payload/],
      ['00zz', /invalid pkt-line length/],
      ['ffff', /invalid pkt-line length/]
    ]) {
      const stream = new Readable({ read() { } });
      const reader = new PktReader(stream);
      const rejected = assert.rejects(reader.readPacket(), error);
      stream.push(Buffer.from(wire, 'ascii'));
      stream.push(null);
      await rejected;
    }
    ok('pkt-line pending reads reject invalid and truncated input');
  } catch (e) {
    fail('pkt-line pending reads reject invalid and truncated input', e);
  }

  try {
    const { withLock } = require('../src/lock');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-lk-'));
    const order = [];
    await Promise.all([
      withLock(dir, async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 30));
        order.push(2);
      }),
      withLock(dir, async () => {
        order.push(3);
      })
    ]);
    assert.deepStrictEqual(order, [1, 2, 3]);
    ok('withLock serializes same key');
  } catch (e) {
    fail('withLock serializes same key', e);
  }

  try {
    const { withLock, lockDirFor } = require('../src/lock');
    const { writeSourceOrCopy } = require('../src/keil_tree');
    const { loadTable } = require('../src/enc_table');
    const { spawnSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-build-lock-'));
    try {
      const text = 'int x; // \u4e2d\u6587\n';
      fs.mkdirSync(path.join(dir, 'User'));
      fs.writeFileSync(path.join(dir, 'User', 'new.c'), text, 'utf8');
      const kn = path.join(dir, '.zkz', 'keil-native');
      await withLock(dir, () => {
        const owner = fs.readFileSync(path.join(lockDirFor(dir), 'owner.json'), 'utf8');
        writeSourceOrCopy(dir, kn, {}, 'User/new.c');
        assert.ok(fs.readFileSync(path.join(kn, 'User', 'new.c')).equals(Buffer.from(text, 'utf8')));
        // A Git filter in another process must also finish while sync owns
        // the operation lock; same-process reentrancy alone cannot fix this.
        const filterJs = require.resolve('../src/filter_core');
        const script = 'require(' + JSON.stringify(filterJs) + ').clean("User/child.h", '
          + 'Buffer.from(' + JSON.stringify(text) + '), {}, process.argv[1]);';
        const child = spawnSync(process.execPath, ['-e', script, dir], {
          windowsHide: true, encoding: 'utf8', timeout: 3000
        });
        assert.ifError(child.error);
        assert.strictEqual(child.status, 0, child.stderr);
        assert.strictEqual(fs.readFileSync(path.join(lockDirFor(dir), 'owner.json'), 'utf8'), owner);
      });
      const table = loadTable(dir);
      assert.strictEqual(table['User/new.c'], 'Utf8');
      assert.strictEqual(table['User/child.h'], 'Utf8');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'User', 'new.c'), 'utf8'), text);
      assert.strictEqual(fs.existsSync(lockDirFor(dir)), false);
      assert.strictEqual(fs.existsSync(lockDirFor(dir, 'encoding-table')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    ok('Keil sync and child filter record new files under operation lock');
  } catch (e) {
    fail('Keil sync and child filter record new files under operation lock', e);
  }

  try {
    const { handshake } = require('../src/filter_process');
    const { PktReader, encodePacket, encodeFlush } = require('../src/pktline');
    const { handshakeRejectPath } = require('../src/paths');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-hs-'));
    const stream = new Readable({ read() { } });
    const reader = new PktReader(stream);
    stream.push(encodePacket(Buffer.from('not-a-client\n')));
    stream.push(encodeFlush());
    stream.push(null);
    let threw = false;
    try {
      await handshake(reader, process.stdout, dir);
    } catch (e) {
      threw = String(e && e.message ? e.message : e).indexOf('unsupported filter handshake') >= 0;
    }
    assert.ok(threw);
    const rec = JSON.parse(fs.readFileSync(handshakeRejectPath(dir), 'utf8'));
    assert.ok(rec.hex && rec.hex.length > 0);
    assert.ok(String(rec.raw).indexOf('not-a-client') >= 0);
    ok('handshake reject writes sidecar hex');
  } catch (e) {
    fail('handshake reject writes sidecar hex', e);
  }

  try {
    const { handshake } = require('../src/filter_process');
    const { PktReader, encodePacket, encodeFlush } = require('../src/pktline');
    const { Writable } = require('stream');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-hs2-'));
    const stream = new Readable({ read() { } });
    const reader = new PktReader(stream);
    // 复现 Cursor 内置 git：pkt-line 负载不带尾随 \n（会黏成 git-filter-clientversion=2）
    stream.push(encodePacket(Buffer.from('git-filter-client')));
    stream.push(encodePacket(Buffer.from('version=2')));
    stream.push(encodeFlush());
    stream.push(encodePacket(Buffer.from('capability=clean')));
    stream.push(encodePacket(Buffer.from('capability=smudge')));
    stream.push(encodeFlush());
    stream.push(null);
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    const okHs = await handshake(reader, sink, dir);
    assert.strictEqual(okHs, true);
    ok('handshake accepts newline-less pkt-lines');
  } catch (e) {
    fail('handshake accepts newline-less pkt-lines', e);
  }

  try {
    const { PktReader, encodePacket, encodeFlush } = require('../src/pktline');
    const stream = new Readable({ read() { } });
    const reader = new PktReader(stream);
    // 命令头同样可能不带 \n；逐包解析后 command/pathname 必须分开
    stream.push(encodePacket(Buffer.from('command=smudge')));
    stream.push(encodePacket(Buffer.from('pathname=User/a.c')));
    stream.push(encodeFlush());
    stream.push(null);
    const h = await reader.readTextHeaders();
    assert.strictEqual(h.headers.command, 'smudge');
    assert.strictEqual(h.headers.pathname, 'User/a.c');
    ok('readTextHeaders parses newline-less packets per-line');
  } catch (e) {
    fail('readTextHeaders parses newline-less packets per-line', e);
  }

  try {
    const { atomicWriteJson } = require('../src/paths');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-aw2-'));
    const file = path.join(dir, 't.json');
    const pathsJs = require.resolve('../src/paths');
    const body = 'const { atomicWriteJson } = require(' + JSON.stringify(pathsJs) + ');\n'
      + 'const file = process.argv[2]; const tag = process.argv[3];\n'
      + 'for (let i = 0; i < 12; i++) atomicWriteJson(file, { tag: tag, i: i });\n';
    const script = path.join(dir, 'w.js');
    fs.writeFileSync(script, body, 'utf8');
    await Promise.all([0, 1].map((n) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, file, 'p' + n], { windowsHide: true });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('writer exit ' + code)));
      child.on('error', reject);
    })));
    JSON.parse(fs.readFileSync(file, 'utf8'));
    const leftovers = fs.readdirSync(dir).filter((n) => n.slice(-4) === '.tmp');
    assert.strictEqual(leftovers.length, 0);
    ok('atomicWriteJson concurrent writers');
  } catch (e) {
    fail('atomicWriteJson concurrent writers', e);
  }

  try {
    const { withLock } = require('../src/lock');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-lk2-'));
    const marker = path.join(dir, 'seq.txt');
    fs.writeFileSync(marker, '', 'utf8');
    const lockJs = require.resolve('../src/lock');
    const body = 'const fs = require("fs");\n'
      + 'const { withLock } = require(' + JSON.stringify(lockJs) + ');\n'
      + 'const file = process.argv[2]; const id = process.argv[3]; const key = process.argv[4];\n'
      + 'withLock(key, async () => {\n'
      + '  fs.appendFileSync(file, id + "s");\n'
      + '  await new Promise((r) => setTimeout(r, 80));\n'
      + '  fs.appendFileSync(file, id + "e");\n'
      + '}).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });\n';
    const script = path.join(dir, 'lk.js');
    fs.writeFileSync(script, body, 'utf8');
    await Promise.all(['A', 'B'].map((id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, marker, id, dir], { windowsHide: true });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('lock worker ' + id + ' ' + code)));
      child.on('error', reject);
    })));
    const seq = fs.readFileSync(marker, 'utf8');
    assert.ok(seq === 'AsAeBsBe' || seq === 'BsBeAsAe', seq);
    ok('withLock two processes serialize');
  } catch (e) {
    fail('withLock two processes serialize', e);
  }

  try {
    const { withLock, lockDirFor } = require('../src/lock');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-lk3-'));
    const ld = lockDirFor(dir);
    fs.mkdirSync(ld, { recursive: true });
    fs.writeFileSync(path.join(ld, 'owner.json'), JSON.stringify({
      pid: 99999999,
      at: Date.now() - 120000
    }), 'utf8');
    let ran = false;
    await withLock(dir, async () => { ran = true; });
    assert.ok(ran);
    ok('withLock steals stale lock');
  } catch (e) {
    fail('withLock steals stale lock', e);
  }

  try {
    const { spawnSync } = require('child_process');
    const { encodeCp936, detectKind } = require('../src/encoding');
    const { enable, disable } = require('../src/bootstrap');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-enable-'));
    const git = (args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(args.join(' ') + '\n' + (r.stderr || r.stdout));
      return r;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 't']);
    git(['config', 'core.autocrlf', 'false']);
    const gbk = encodeCp936('int x; // \u4e2d\u6587\n');
    fs.writeFileSync(path.join(dir, 'a.c'), gbk);
    fs.mkdirSync(path.join(dir, 'Libraries'));
    fs.writeFileSync(path.join(dir, 'Libraries', 'lib.c'), gbk);
    git(['add', 'a.c', 'Libraries/lib.c']);
    git(['commit', '-q', '-m', 'init']);
    const ext = path.join(__dirname, '..');
    const st = await enable(dir, ext);
    const now = fs.readFileSync(path.join(dir, 'a.c'));
    assert.strictEqual(detectKind(now), 'Utf8');
    assert.ok(now.toString('utf8').indexOf('\u4e2d\u6587') >= 0);
    assert.strictEqual(detectKind(fs.readFileSync(path.join(dir, 'Libraries', 'lib.c'))), 'Gbk');
    assert.deepStrictEqual(st.unstable, []);
    const porcelain = git(['status', '--porcelain']);
    assert.strictEqual(String(porcelain.stdout || '').trim(), '');
    const off = disable(dir);
    assert.strictEqual(off.installed, false);
    assert.strictEqual(off.leftover.length, 0);
    assert.strictEqual(detectKind(fs.readFileSync(path.join(dir, 'a.c'))), 'Gbk');
    const after = git(['status', '--porcelain']);
    assert.strictEqual(String(after.stdout || '').trim(), '');
    fs.rmSync(dir, { recursive: true, force: true });
    ok('enable smudges worktree to UTF-8 and status stays clean');
  } catch (e) {
    fail('enable smudges worktree to UTF-8 and status stays clean', e);
  }

  try {
    const { spawnSync } = require('child_process');
    const { encodeCp936, detectKind, parseMapped } = require('../src/encoding');
    const { saveTable, loadTable, buildTable } = require('../src/enc_table');
    const { checkStaged } = require('../src/precommit');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-inc-table-'));
    const git = (args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(args.join(' ') + '\n' + (r.stderr || r.stdout));
      return String(r.stdout || '').trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 't']);
    git(['config', 'core.autocrlf', 'false']);
    git(['config', 'diff.renames', 'copies']);
    fs.writeFileSync(path.join(dir, 'a.c'), 'int a;\n');
    git(['add', 'a.c']);
    git(['commit', '-q', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    saveTable(dir, { 'a.c': 'Gbk+crlf' });
    fs.writeFileSync(path.join(dir, 'a.c'), 'int a;\nint b;\n');
    git(['add', 'a.c']);
    git(['commit', '-q', '-m', 'edit']);
    const edited = git(['rev-parse', 'HEAD']);
    const kept = await buildTable(dir, { from: base, to: edited });
    assert.strictEqual(kept.files['a.c'], 'Gbk+crlf');
    git(['mv', 'a.c', 'b.c']);
    fs.writeFileSync(path.join(dir, 'c.c'), 'int a;\nint b;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'move']);
    const moved = git(['rev-parse', 'HEAD']);
    const next = await buildTable(dir, { from: edited, to: moved });
    assert.strictEqual(next.files['b.c'], 'Gbk+crlf');
    assert.strictEqual(next.files['a.c'], undefined);
    assert.strictEqual(next.files['c.c'], 'Gbk+crlf');
    assert.strictEqual(parseMapped(loadTable(dir)['b.c']).kind, 'Gbk');
    ok('incremental table keeps modified encodings and copied sources');
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    fail('incremental table keeps modified encodings and copied sources', e);
  }

  try {
    const { spawnSync } = require('child_process');
    const { encodeCp936, detectKind, decodeCp936 } = require('../src/encoding');
    const { saveTable, loadTable } = require('../src/enc_table');
    const { checkStaged } = require('../src/precommit');
    const { parseMapped } = require('../src/encoding');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-rename-gbk-'));
    const git = (args, encoding) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: encoding || 'utf8' });
      if (r.status !== 0) throw new Error(args.join(' ') + '\n' + (r.stderr || r.stdout));
      return r.stdout;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 't']);
    git(['config', 'core.autocrlf', 'false']);
    const text = '// \u4e2d\u6587\n';
    fs.writeFileSync(path.join(dir, 'a.c'), encodeCp936(text));
    git(['add', 'a.c']);
    git(['commit', '-q', '-m', 'base']);
    saveTable(dir, { 'a.c': 'Gbk' });
    const filter = require.resolve('../src/filter_process.js').replace(/\\/g, '/');
    const node = process.execPath.replace(/\\/g, '/');
    git(['config', 'filter.zkznative.process', '"' + node + '" "' + filter + '"']);
    git(['config', 'filter.zkznative.required', 'true']);
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.c filter=zkznative -text\n');
    fs.writeFileSync(path.join(dir, 'b.c'), Buffer.from(text, 'utf8'));
    fs.unlinkSync(path.join(dir, 'a.c'));
    git(['add', '-A']);
    const rejected = await checkStaged(dir);
    assert.ok(rejected.errors.length, JSON.stringify(rejected));
    assert.ok(rejected.errors.join('\n').indexOf('重新 git add') >= 0, rejected.errors.join('\n'));
    assert.strictEqual(parseMapped(loadTable(dir)['b.c']).kind, 'Gbk');
    git(['add', '--renormalize', '--', 'b.c']);
    const again = await checkStaged(dir);
    assert.deepStrictEqual(again.errors, [], JSON.stringify(again));
    const blob = git(['show', ':b.c'], 'buffer');
    assert.strictEqual(detectKind(blob), 'Gbk');
    assert.strictEqual(decodeCp936(blob), text);
    ok('gbk rename is rejected until it is re-added in gbk');
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    fail('gbk rename is rejected until it is re-added in gbk', e);
  }

  try {
    const { spawnSync } = require('child_process');
    const { encodeCp936 } = require('../src/encoding');
    const { findPushedEncodingErrors } = require('../src/precommit');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-push-gbk-'));
    const git = (args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(args.join(' ') + '\n' + (r.stderr || r.stdout));
      return String(r.stdout || '').trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 't']);
    git(['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(dir, 'a.c'), encodeCp936('// \u4e2d\u6587\n'));
    git(['add', 'a.c']);
    git(['commit', '-q', '-m', 'gbk']);
    const base = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'a.c'), Buffer.from('// \u4e2d\u6587\nint y;\n', 'utf8'));
    git(['add', 'a.c']);
    git(['commit', '-q', '-m', 'utf8']);
    const head = git(['rev-parse', 'HEAD']);
    const errors = await findPushedEncodingErrors(dir, base, head);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].indexOf('a.c') >= 0, errors.join('\n'));
    ok('push rejects a gbk file rewritten as utf8');
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    fail('push rejects a gbk file rewritten as utf8', e);
  }

  finish(extra);
}

test('lib tops read libraryDirNames from workspace_lists.json', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-libs-'));
  fs.mkdirSync(path.join(dir, '.zkz'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'VendorLib'));
  fs.mkdirSync(path.join(dir, 'Libraries'));
  fs.writeFileSync(path.join(dir, '.zkz', 'workspace_lists.json'), JSON.stringify({
    libraryDirNames: ['VendorLib', 'Libraries']
  }), 'utf8');
  const { libTopNames, libTops, isLibRel } = require('../src/paths');
  assert.deepStrictEqual(libTopNames(dir), ['VendorLib', 'Libraries']);
  assert.deepStrictEqual(libTops(dir), ['VendorLib', 'Libraries']);
  assert.strictEqual(isLibRel(dir, 'VendorLib/src/a.c'), true);
  assert.strictEqual(isLibRel(dir, 'FreeRTOS/include/task.h'), false);
  fs.writeFileSync(path.join(dir, '.zkz', 'workspace_lists.json'), JSON.stringify({
    libraryDirNames: ['Libraries']
  }), 'utf8');
  assert.deepStrictEqual(libTopNames(dir), ['Libraries']);
});

test('library attributes cancel -text so autocrlf still applies', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-attr-'));
  fs.mkdirSync(path.join(dir, '.zkz'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Libraries'));
  fs.writeFileSync(path.join(dir, '.zkz', 'workspace_lists.json'), JSON.stringify({
    libraryDirNames: ['Libraries', 'output.hex']
  }), 'utf8');
  const { attributesBody } = require('../src/git_config');
  const body = attributesBody(dir);
  assert.ok(body.indexOf('*.c filter=zkznative diff=zkznative -text') >= 0);
  assert.ok(body.indexOf('Libraries/** -filter -diff !text') >= 0);
  assert.ok(body.indexOf('Libraries/** -filter -diff\n') < 0);
  assert.ok(body.indexOf('output.hex') < 0);
});

test('keil-native preserves unmapped source encodings and worktree bytes', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { encodeCp936, detectKind } = require('../src/encoding');
  const { writeSourceOrCopy } = require('../src/keil_tree');
  const { loadTable } = require('../src/enc_table');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-kn-gbk-'));
  const repo = path.join(dir, 'repo');
  const kn = path.join(repo, '.zkz', 'keil-native');
  fs.mkdirSync(path.join(repo, 'User'), { recursive: true });
  const text = 'int x; // \u4e2d\u6587\n';
  const gbk = encodeCp936(text);
  fs.writeFileSync(path.join(repo, 'User', 'new.c'), text, 'utf8');
  fs.writeFileSync(path.join(repo, 'User', 'gbk.c'), gbk);
  fs.writeFileSync(path.join(repo, 'User', 'kept.c'), text, 'utf8');
  writeSourceOrCopy(repo, kn, {}, 'User/new.c');
  writeSourceOrCopy(repo, kn, loadTable(repo), 'User/gbk.c');
  writeSourceOrCopy(repo, kn, { 'User/kept.c': 'Utf8' }, 'User/kept.c');
  const neu = fs.readFileSync(path.join(kn, 'User', 'new.c'));
  const asGbk = fs.readFileSync(path.join(kn, 'User', 'gbk.c'));
  const kept = fs.readFileSync(path.join(kn, 'User', 'kept.c'));
  assert.ok(neu.equals(Buffer.from(text, 'utf8')));
  assert.strictEqual(fs.readFileSync(path.join(repo, 'User', 'new.c'), 'utf8'), text);
  assert.ok(asGbk.equals(gbk));
  assert.ok(fs.readFileSync(path.join(repo, 'User', 'gbk.c')).equals(gbk));
  assert.strictEqual(detectKind(kept), 'Utf8');
  assert.strictEqual(kept.toString('utf8'), text);
  const table = loadTable(repo);
  assert.strictEqual(table['User/new.c'], 'Utf8');
  assert.strictEqual(table['User/gbk.c'], 'Gbk');
});

test('keil-native symlink is not written through', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { ensureRealParent } = require('../src/keil_tree');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-kn-'));
  const repo = path.join(dir, 'repo');
  const kn = path.join(repo, '.zkz', 'keil-native');
  const real = path.join(repo, 'driver', 'fatfs');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'diskio.c'), 'utf8-source\n', 'utf8');
  fs.mkdirSync(path.join(kn, 'driver'), { recursive: true });
  fs.symlinkSync(real, path.join(kn, 'driver', 'fatfs'), 'junction');
  ensureRealParent(repo, kn, 'driver/fatfs/src/diskio.c');
  const link = path.join(kn, 'driver', 'fatfs');
  assert.strictEqual(fs.lstatSync(link).isSymbolicLink(), false);
  assert.strictEqual(fs.statSync(link).isDirectory(), true);
  assert.strictEqual(fs.readFileSync(path.join(real, 'diskio.c'), 'utf8'), 'utf8-source\n');
});

test('keil-native drops files the source no longer has', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { pruneMissing } = require('../src/keil_tree');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-prune-'));
  const repo = path.join(dir, 'repo');
  const kn = path.join(repo, '.zkz', 'keil-native');
  fs.mkdirSync(path.join(repo, 'core'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'core', 'keep.h'), 'keep\n', 'utf8');
  fs.mkdirSync(path.join(kn, 'core', 'old'), { recursive: true });
  fs.writeFileSync(path.join(kn, 'core', 'keep.h'), 'keep\n', 'utf8');
  fs.writeFileSync(path.join(kn, 'core', 'old', 'gone.h'), 'stale\n', 'utf8');
  const n = pruneMissing(repo, kn, 'core');
  assert.strictEqual(n, 1);
  assert.strictEqual(fs.existsSync(path.join(kn, 'core', 'keep.h')), true);
  assert.strictEqual(fs.existsSync(path.join(kn, 'core', 'old', 'gone.h')), false);
});

test('resmudge rewrites stat-clean GBK worktree to UTF-8', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { encodeCp936, detectKind } = require('../src/encoding');
  const { resmudgeStale } = require('../src/bootstrap');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-smudge-'));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.c'), encodeCp936('int x; // \u4e2d\u6587\n'));
  git(['add', 'a.c']);
  git(['commit', '-q', '-m', 'init']);
  fs.mkdirSync(path.join(dir, '.zkz', 'run'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.zkz', 'run', '.workspace_source_encodings.json'),
    JSON.stringify({ files: { 'a.c': 'Gbk' } }),
    'utf8'
  );
  const filterJs = path.join(__dirname, '..', 'src', 'filter_process.js');
  git(['config', 'filter.zkznative.process', '"' + process.execPath + '" "' + filterJs + '"']);
  git(['config', 'filter.zkznative.required', 'true']);
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.c filter=zkznative -text\n', 'utf8');
  assert.strictEqual(resmudgeStale(dir), 1);
  const now = fs.readFileSync(path.join(dir, 'a.c'));
  assert.strictEqual(detectKind(now), 'Utf8');
  assert.ok(now.toString('utf8').indexOf('\u4e2d\u6587') >= 0);
  const st = git(['status', '--porcelain', '--', 'a.c']);
  assert.strictEqual(String(st.stdout || '').trim(), '');
  const cached = git(['diff', '--cached', '--numstat', '--', 'a.c']);
  assert.strictEqual(String(cached.stdout || '').trim(), '');
});

test('worktreeBytes inserts CRLF only when autocrlf and blob has no CR', () => {
  const { worktreeBytes } = require('../src/bootstrap');
  const lf = Buffer.from('a\nb\n');
  const crlf = worktreeBytes(lf, true);
  assert.strictEqual(crlf.toString('latin1'), 'a\r\nb\r\n');
  assert.strictEqual(worktreeBytes(lf, false).equals(lf), true);
  const mixed = Buffer.from('a\r\nb\n');
  assert.strictEqual(worktreeBytes(mixed, true).equals(mixed), true);
});

test('disable restore writes CRLF so autocrlf status stays clean', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { restoreOriginalStale } = require('../src/bootstrap');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-restore-'));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  git(['config', 'core.autocrlf', 'true']);
  fs.writeFileSync(path.join(dir, 'a.c'), Buffer.from('int x;\n'));
  git(['add', 'a.c']);
  git(['commit', '-q', '-m', 'init']);
  fs.mkdirSync(path.join(dir, '.zkz', 'run'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.zkz', 'run', '.workspace_source_encodings.json'),
    JSON.stringify({ files: { 'a.c': 'Gbk' } }),
    'utf8'
  );
  const r = restoreOriginalStale(dir);
  assert.strictEqual(r.checked, 1);
  assert.strictEqual(r.leftover.length, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.c')).toString('latin1'), 'int x;\r\n');
  const st = git(['status', '--porcelain', '--', 'a.c']);
  assert.strictEqual(String(st.stdout || '').trim(), '');
  const cached = git(['diff', '--cached', '--numstat', '--', 'a.c']);
  assert.strictEqual(String(cached.stdout || '').trim(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disable restore keeps CRLF blobs from showing as empty edits', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { restoreOriginalStale } = require('../src/bootstrap');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-crlf-'));
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'a.c'), Buffer.from('int x;\r\n'));
  git(['add', 'a.c']);
  git(['commit', '-q', '-m', 'init']);
  git(['config', 'core.autocrlf', 'true']);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'a.c'), future, future);
  fs.mkdirSync(path.join(dir, '.zkz', 'run'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.zkz', 'run', '.workspace_source_encodings.json'),
    JSON.stringify({ files: { 'a.c': 'Gbk+crlf' } }),
    'utf8'
  );
  const r = restoreOriginalStale(dir);
  assert.strictEqual(r.checked, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.c')).toString('latin1'), 'int x;\r\n');
  const st = git(['status', '--porcelain', '--', 'a.c']);
  assert.strictEqual(String(st.stdout || '').trim(), '');
  const cached = git(['diff', '--cached', '--numstat', '--', 'a.c']);
  assert.strictEqual(String(cached.stdout || '').trim(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runtime files move from .zkz into .zkz/run', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { tablePath, keilStampPath, relocateRunFiles } = require('../src/paths');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-run-'));
  const zkz = path.join(dir, '.zkz');
  fs.mkdirSync(zkz, { recursive: true });
  fs.writeFileSync(path.join(zkz, '.workspace_source_encodings.json'), '{"a.c":"Utf8"}\n', 'utf8');
  fs.writeFileSync(path.join(zkz, 'keil-native-stamp.json'), '{}\n', 'utf8');
  fs.mkdirSync(path.join(zkz, 'locks'));
  fs.writeFileSync(path.join(zkz, 'locks', 'x.lock'), '1', 'utf8');
  relocateRunFiles(dir);
  assert.strictEqual(fs.existsSync(path.join(zkz, '.workspace_source_encodings.json')), false);
  assert.strictEqual(fs.readFileSync(tablePath(dir), 'utf8'), '{"a.c":"Utf8"}\n');
  assert.strictEqual(fs.readFileSync(keilStampPath(dir), 'utf8'), '{}\n');
  assert.strictEqual(fs.existsSync(path.join(zkz, 'locks')), false);
  assert.strictEqual(fs.readFileSync(path.join(zkz, 'run', 'locks', 'x.lock'), 'utf8'), '1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live lock owner is not stolen after the ttl', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { isStale, lockDirFor } = require('../src/lock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-live-lock-'));
  const ld = lockDirFor(dir);
  fs.mkdirSync(ld, { recursive: true });
  fs.writeFileSync(path.join(ld, 'owner.json'), JSON.stringify({
    pid: process.pid,
    at: Date.now() - 120000
  }), 'utf8');
  assert.strictEqual(isStale(ld), false);
  fs.writeFileSync(path.join(ld, 'owner.json'), JSON.stringify({
    pid: 99999999,
    at: Date.now()
  }), 'utf8');
  assert.strictEqual(isStale(ld), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('corrupt encoding table is not replaced with an empty one', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { loadTable, noteNewFile } = require('../src/enc_table');
  const { tablePath } = require('../src/paths');
  const { lockDirFor } = require('../src/lock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-bad-table-'));
  const file = tablePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{', 'utf8');
  assert.throws(() => loadTable(dir), /编码表无法解析/);
  assert.throws(() => noteNewFile(dir, 'a.c', 'Utf8'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{');
  assert.strictEqual(fs.existsSync(lockDirFor(dir, 'encoding-table')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ascii source with chinese cleans back to gbk', () => {
  const table = { 'User/a.c': 'Ascii' };
  const text = '// \u4e2d\u6587\n';
  const out = clean('User/a.c', Buffer.from(text, 'utf8'), table);
  assert.ok(out.equals(encodeCp936(text)));
  assert.strictEqual(table['User/a.c'], 'Gbk');
});

test('ascii source with emoji stays unchanged', () => {
  const table = { 'User/a.c': 'Ascii' };
  const wt = Buffer.from('emoji \u{1F600}\n', 'utf8');
  const out = clean('User/a.c', wt, table);
  assert.ok(out.equals(wt));
  assert.strictEqual(table['User/a.c'], 'Ascii');
});

test('precommit rejects ascii table with non-ascii blob', () => {
  const { evaluateStagedBlob } = require('../src/precommit');
  const r = evaluateStagedBlob('core/a.c', Buffer.from('\u4e2d\u6587\n', 'utf8'), 'Ascii');
  assert.ok(r.error);
});

test('indexBlobOid matches staged git oids', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { indexBlobOid } = require('../src/git_exec');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-index-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, String(r.stderr || r.stdout));
    return String(r.stdout || '');
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 'User', 'new dir'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'root.c'), 'int root;\n');
  fs.writeFileSync(path.join(dir, 'User', 'new dir', 'a.c'), 'int a;\n');
  git(['add', '.']);
  const listed = git(['ls-files', '-s', '-z']).split('\0').filter(Boolean);
  assert.ok(listed.length >= 2);
  for (let i = 0; i < listed.length; i++) {
    const tab = listed[i].indexOf('\t');
    const rel = listed[i].slice(tab + 1).replace(/\\/g, '/');
    const oid = listed[i].slice(0, tab).split(' ')[1];
    assert.strictEqual(indexBlobOid(dir, rel), oid, rel);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clean of a tracked gbk file missing from the table keeps the blob encoding', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { loadTable } = require('../src/enc_table');
  const { parseMapped } = require('../src/encoding');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-tracked-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, String(r.stderr || r.stdout));
    return r.stdout;
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  git(['config', 'core.autocrlf', 'false']);
  const text = '// \u4e2d\u6587\n';
  const gbk = encodeCp936(text);
  fs.writeFileSync(path.join(dir, 'a.c'), gbk);
  git(['add', 'a.c']);
  git(['commit', '-q', '-m', 'init']);
  const out = clean('a.c', Buffer.from(text, 'utf8'), {}, dir);
  assert.ok(out.equals(gbk));
  assert.strictEqual(parseMapped(loadTable(dir)['a.c']).kind, 'Gbk');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disable restore keeps uncommitted edits in the original encoding', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { restoreOriginalStale } = require('../src/bootstrap');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-keep-edit-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, String(r.stderr || r.stdout));
    return String(r.stdout || '');
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  git(['config', 'core.autocrlf', 'false']);
  const original = '// \u4e2d\u6587\n';
  const edited = '// \u4e2d\u6587\nint y;\n';
  fs.writeFileSync(path.join(dir, 'a.c'), encodeCp936(original));
  git(['add', 'a.c']);
  git(['commit', '-q', '-m', 'init']);
  fs.mkdirSync(path.join(dir, '.zkz', 'run'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.zkz', 'run', '.workspace_source_encodings.json'), JSON.stringify({
    files: { 'a.c': 'Gbk' }
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.c'), Buffer.from(edited, 'utf8'));
  const r = restoreOriginalStale(dir);
  assert.strictEqual(r.leftover.length, 0);
  assert.ok(fs.readFileSync(path.join(dir, 'a.c')).equals(encodeCp936(edited)));
  assert.ok(git(['status', '--porcelain', '--', 'a.c']).indexOf('a.c') >= 0);
  assert.strictEqual(git(['diff', '--cached', '--numstat', '--', 'a.c']).trim(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('full keil sync copies root sources and skips gitignored files', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { syncKeilTree } = require('../src/keil_tree');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-root-sync-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, windowsHide: true });
    assert.strictEqual(r.status, 0, String(r.stderr));
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  git(['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n.zkz/\nUser/secret.c\n');
  fs.mkdirSync(path.join(dir, 'User'));
  fs.writeFileSync(path.join(dir, 'root.c'), 'int root;\n');
  fs.writeFileSync(path.join(dir, 'User', 'a.c'), 'int a;\n');
  git(['add', 'root.c', 'User/a.c']);
  git(['commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(dir, 'User', 'secret.c'), 'int secret;\n');
  syncKeilTree(dir);
  const kn = path.join(dir, '.zkz', 'keil-native');
  assert.strictEqual(fs.readFileSync(path.join(kn, 'root.c'), 'utf8'), 'int root;\n');
  assert.strictEqual(fs.readFileSync(path.join(kn, 'User', 'a.c'), 'utf8'), 'int a;\n');
  assert.strictEqual(fs.existsSync(path.join(kn, 'User', 'secret.c')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('library warning for one file does not erase another', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { inspectLibEncoding, loadLibWarnings } = require('../src/lib_encoding');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-lib-merge-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, windowsHide: true });
    assert.strictEqual(r.status, 0, String(r.stderr));
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 'Libraries'));
  const gbk = encodeCp936('// \u4e2d\u6587\n');
  fs.writeFileSync(path.join(dir, 'Libraries', 'a.c'), gbk);
  fs.writeFileSync(path.join(dir, 'Libraries', 'b.c'), gbk);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(dir, 'Libraries', 'a.c'), '// \u4e2d\u6587\n', 'utf8');
  inspectLibEncoding(dir, ['Libraries/a.c'], { mode: 'worktree', persist: true });
  inspectLibEncoding(dir, ['Libraries/b.c'], { mode: 'worktree', persist: true });
  const left = loadLibWarnings(dir);
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].rel, 'Libraries/a.c');
  fs.rmSync(dir, { recursive: true, force: true });
});

runAsync();
