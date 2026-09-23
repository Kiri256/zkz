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

test('new file utf8 passthrough', () => {
  const wt = Buffer.from('/* \u65b0\u589e */\n', 'utf8');
  const out = clean('User/brand_new.c', wt, {});
  assert.ok(out.equals(wt));
  assert.strictEqual(kindForNewFile(wt), 'Utf8');
});

test('new file gbk rejected', () => {
  const wt = encodeCp936('\u4e2d\u6587');
  let threw = false;
  try { clean('User/bad.c', wt, {}); } catch (e) { threw = e.code === 'ZKZ_NEW_NOT_UTF8'; }
  assert.ok(threw);
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
  const utf = Buffer.from('emoji \u{1F600}\n', 'utf8');
  const r = evaluateStagedBlob('core/a.c', utf, 'Gbk');
  assert.ok(r.error);
  assert.ok(r.error.indexOf('UTF-8') >= 0 || r.error.indexOf('Utf8') >= 0);
});

test('precommit accepts Gbk blob for Gbk table', () => {
  const { evaluateStagedBlob } = require('../src/precommit');
  const blob = encodeCp936('\u4e2d\u6587\u6ce8\u91ca\nint x;\n');
  const r = evaluateStagedBlob('core/a.c', blob, 'Gbk');
  assert.ok(!r.error);
});

test('precommit rejects new file stored as Gbk', () => {
  const { evaluateStagedBlob } = require('../src/precommit');
  const blob = encodeCp936('\u4e2d\u6587\n');
  const r = evaluateStagedBlob('core/new.c', blob, undefined);
  assert.ok(r.error);
});


test('parseNameStatusZ rename and delete', () => {
  const { parseNameStatusZ } = require('../src/git_status');
  const z = String.fromCharCode(0);
  const out = ['R100', 'User/old.c', 'User/new.c', 'D', 'core/gone.h', 'M', 'core/keep.c'].join(z) + z;
  const p = parseNameStatusZ(out);
  assert.ok(p.removed.indexOf('User/old.c') >= 0);
  assert.ok(p.added.indexOf('User/new.c') >= 0);
  assert.ok(p.removed.indexOf('core/gone.h') >= 0);
  assert.ok(p.added.indexOf('core/keep.c') >= 0);
  assert.strictEqual(p.records.filter((r) => r.status === 'R').length, 1);
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
  clean('User/a.c', wt, table, dir);
  const list = loadRoundtripFailures(dir);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].rel, 'User/a.c');
  clearRoundtripFailure(dir, 'User/a.c');
  assert.strictEqual(loadRoundtripFailures(dir).length, 0);
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
    assert.ok(!overlaySeeded(root));
    assert.ok(seedOverlay(root).seeded.indexOf('.vscode/settings.json') >= 0);
    assert.ok(overlaySeeded(root));
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
  const { loadConfigPaths } = require('../src/config_freeze');
  const { seedOverlay, restoreOverlay } = require('../src/overlay');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-cfgp-'));
  try {
    atomicWriteJson(configPathsFile(root), {
      skipWorktree: ['.cursor'],
      forbidStage: ['.vscode', 'AGENTS.md']
    });
    const cfg = loadConfigPaths(root);
    assert.ok(cfg.overlay.indexOf('.cursor') >= 0);
    assert.ok(cfg.overlay.indexOf('.vscode') >= 0);
    assert.ok(cfg.overlay.indexOf('AGENTS.md') >= 0);
    assert.ok(cfg.skipWorktree.indexOf('.cursor') >= 0);
    assert.ok(cfg.forbidStage.indexOf('AGENTS.md') < 0);
    assert.ok(cfg.forbidStage.indexOf('.zkz/config_paths.json') >= 0);
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

  finish(extra);
}

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

runAsync();
