'use strict';

const { loadTable } = require('./enc_table');
const { smudge, clean } = require('./filter_core');
const { findRepoRoot, appendLog } = require('./paths');
const { PktReader, encodePacket, encodeFlush, encodeContent, writeAll } = require('./pktline');

function setBlocking() {
  try {
    if (process.stdout._handle && process.stdout._handle.setBlocking) {
      process.stdout._handle.setBlocking(true);
    }
  } catch (_) { /* ignore */ }
}

async function handshake(reader, out) {
  const first = await reader.readTextHeaders();
  if (first.eof) return false;
  const raw = String(first.raw || '');
  const isClient = raw.indexOf('git-filter-client') >= 0 || first.headers['git-filter-client'] || first.headers.command === 'git-filter-client';
  const ver = first.headers.version || (/\bversion=2\b/.test(raw) ? '2' : '');
  if (!isClient || String(ver) !== '2') {
    throw new Error('unsupported filter handshake');
  }
  await writeAll(out, Buffer.concat([
    encodePacket(Buffer.from('git-filter-server\n', 'utf8')),
    encodePacket(Buffer.from('version=2\n', 'utf8')),
    encodeFlush()
  ]));

  const caps = await reader.readTextHeaders();
  if (caps.eof) return false;
  await writeAll(out, Buffer.concat([
    encodePacket(Buffer.from('capability=clean\n', 'utf8')),
    encodePacket(Buffer.from('capability=smudge\n', 'utf8')),
    encodeFlush()
  ]));
  return true;
}

async function writeSuccess(out, body) {
  await writeAll(out, Buffer.concat([
    encodePacket(Buffer.from('status=success\n', 'utf8')),
    encodeFlush(),
    encodeContent(body),
    encodeFlush(),
    encodePacket(Buffer.from('status=success\n', 'utf8')),
    encodeFlush()
  ]));
}

async function writeError(out, msg) {
  await writeAll(out, Buffer.concat([
    encodePacket(Buffer.from('status=error\n', 'utf8')),
    encodeFlush()
  ]));
  return msg;
}

async function handleOne(reader, out, table, repoRoot) {
  const head = await reader.readTextHeaders();
  if (head.eof) return false;
  const command = String(head.headers.command || '');
  const pathname = String(head.headers.pathname || '');
  const body = await reader.readBinaryUntilFlush();
  if (body.eof && !body.data.length && !command) return false;
  try {
    let result;
    if (command === 'smudge') result = smudge(pathname, body.data, table, repoRoot);
    else if (command === 'clean') result = clean(pathname, body.data, table, repoRoot);
    else throw new Error('unknown command: ' + command);
    await writeSuccess(out, result);
  } catch (e) {
    const msg = pathname + ': ' + String(e && e.message ? e.message : e);
    appendLog(repoRoot, 'filter error ' + command + ' ' + msg);
    await writeError(out, msg);
  }
  return true;
}

async function main() {
  setBlocking();
  if (process.stdin.setEncoding) { /* keep binary */ }
  try { process.stdin.resume(); } catch (_) { /* ignore */ }
  const repoRoot = findRepoRoot(process.env.GIT_WORK_TREE || process.cwd());
  const table = loadTable(repoRoot);
  const reader = new PktReader(process.stdin);
  const out = process.stdout;
  if (!await handshake(reader, out)) return;
  for (; ;) {
    const more = await handleOne(reader, out, table, repoRoot);
    if (!more) break;
  }
}

main().catch((e) => {
  try { process.stderr.write(String(e && e.stack ? e.stack : e) + '\n'); } catch (_) { /* ignore */ }
  process.exit(1);
});
