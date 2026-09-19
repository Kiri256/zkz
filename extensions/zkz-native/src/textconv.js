'use strict';

const fs = require('fs');
const { detectKind, applySmudge } = require('./encoding');

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: textconv.js <tempfile>\n');
    process.exit(1);
  }
  const buf = fs.readFileSync(file);
  const kind = detectKind(buf);
  const out = applySmudge(kind, buf);
  process.stdout.write(out);
}

main();
