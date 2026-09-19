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
  assert.strictEqual(detectKind(Buffer.from('窗口\n', 'utf8')), 'Utf8');
});

test('detectKind utf8bom', () => {
  const buf = Buffer.concat([UTF8_BOM, Buffer.from('窗口', 'utf8')]);
  assert.strictEqual(detectKind(buf), 'Utf8Bom');
});

test('detectKind gbk', () => {
  const gbk = encodeCp936('窗口的个数');
  assert.strictEqual(detectKind(gbk), 'Gbk');
});

test('cp936 roundtrip chinese', () => {
  const t = '窗口的个数 加工文件 安富莱电子';
  assert.ok(roundtripOk(t));
  assert.strictEqual(decodeCp936(encodeCp936(t)), t);
});

test('smudge/clean Gbk identity', () => {
  const blob = encodeCp936('中文注释\nint x;\n');
  const table = { 'User/a.c': 'Gbk' };
  const wt = smudge('User/a.c', blob, table);
  assert.strictEqual(detectKind(wt), 'Utf8');
  assert.strictEqual(wt.toString('utf8'), '中文注释\nint x;\n');
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
  const blob = Buffer.from('/* 新文件 */\n', 'utf8');
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
  const wt = Buffer.from('/* 新增 */\n', 'utf8');
  const out = clean('User/brand_new.c', wt, {});
  assert.ok(out.equals(wt));
  assert.strictEqual(kindForNewFile(wt), 'Utf8');
});

test('new file gbk rejected', () => {
  const wt = encodeCp936('中文');
  let threw = false;
  try { clean('User/bad.c', wt, {}); } catch (e) { threw = e.code === 'ZKZ_NEW_NOT_UTF8'; }
  assert.ok(threw);
});

test('clean Gbk passthrough leftover repo bytes', () => {
  const blob = encodeCp936('中文注释\nint x;\n');
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
  const gbk = encodeCp936('中文\r\n');
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
  const blob = encodeCp936('中文注释\nint x;\n');
  const r = evaluateStagedBlob('core/a.c', blob, 'Gbk');
  assert.ok(!r.error);
});

test('precommit rejects new file stored as Gbk', () => {
  const { evaluateStagedBlob } = require('../src/precommit');
  const blob = encodeCp936('中文\n');
  const r = evaluateStagedBlob('core/new.c', blob, undefined);
  assert.ok(r.error);
});

if (failed) {
  console.log('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
