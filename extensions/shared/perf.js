'use strict';

const fs = require('fs');
const path = require('path');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const timestampFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function formatTimestamp(date) {
  const parts = Object.fromEntries(timestampFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day + ' '
    + parts.hour + ':' + parts.minute + ':' + parts.second + '.'
    + String(date.getUTCMilliseconds()).padStart(3, '0') + ' +0800';
}

function record(root, phase, fields) {
  if (!root || !phase) return;
  try {
    const dir = path.join(root, '.zkz', 'run');
    fs.mkdirSync(dir, { recursive: true });
    const row = Object.assign({
      at: formatTimestamp(new Date()),
      phase: String(phase)
    }, fields || {});
    const file = path.join(dir, 'performance.jsonl');
    try {
      if (fs.statSync(file).size >= MAX_LOG_BYTES) {
        const backup = file + '.1';
        try { fs.unlinkSync(backup); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        fs.renameSync(file, backup);
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch (_) { /* performance logging must never affect the operation */ }
}

module.exports = { record, formatTimestamp };
