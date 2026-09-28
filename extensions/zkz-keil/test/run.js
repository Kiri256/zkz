'use strict';

const assert = require('assert');
const { parseIntelHex } = require('../src/keil_flash');

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

if (failed) {
  console.log('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
