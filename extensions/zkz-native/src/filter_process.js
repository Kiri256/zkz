'use strict';

const { loadTable } = require('./enc_table');
const { smudge, clean } = require('./filter_core');
const { findRepoRoot } = require('./paths');
const { PktReader, encodePacket, encodeFlush, encodeContent, writeAll } = require('./pktline');
const { recordFilterFail, resetFilterFail, recordHandshakeReject } = require('./observe');

function setBlocking() {
  // Windows 上 git 以管道读 filter stdout；不阻塞时半包会让握手失败。
  // _handle.setBlocking 是私有 API，没有就继续（best-effort），宁可透传也不崩。
  try {
    if (process.stdout._handle && process.stdout._handle.setBlocking) {
      process.stdout._handle.setBlocking(true);
    }
  } catch (_) { /* ignore */ }
}

async function handshake(reader, out, repoRoot) {
  const first = await reader.readTextHeaders();
  if (first.eof) return false;
  const raw = String(first.raw || '');
  // 容错：不同 git 客户端的握手负载分隔不一致（有的不带尾随 \n，见 pktline.readTextHeaders 注释）。
  // 用 indexOf 而非 \b 单词边界，避免 client 与 version 黏连时误判。
  const isClient = raw.indexOf('git-filter-client') >= 0 || !!first.headers['git-filter-client'] || first.headers.command === 'git-filter-client';
  const hasV2 = first.headers.version === '2' || raw.indexOf('version=2') >= 0;
  if (!isClient || !hasV2) {
    try { recordHandshakeReject(repoRoot, first); } catch (_) { /* ignore */ }
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
    resetFilterFail(repoRoot);
  } catch (e) {
    const msg = pathname + ': ' + String(e && e.message ? e.message : e);
    try { process.stderr.write('zkz-native filter error ' + command + ' ' + msg + '\n'); } catch (_) { /* ignore */ }
    recordFilterFail(repoRoot, command + ' ' + msg);
    try { await writeError(out, msg); } catch (_2) { /* protocol already broken */ }
  }
  return true;
}

async function main() {
  setBlocking();
  const reader = new PktReader(process.stdin);
  const repoRoot = findRepoRoot(process.env.GIT_WORK_TREE || process.cwd());
  const table = loadTable(repoRoot);
  const out = process.stdout;
  if (!await handshake(reader, out, repoRoot)) return;
  for (; ;) {
    const more = await handleOne(reader, out, table, repoRoot);
    if (!more) break;
  }
}

if (require.main === module) {
  main().catch((e) => {
    const msg = String(e && e.message ? e.message : e);
    try { process.stderr.write('zkz-native filter: ' + msg + '\n'); } catch (_) { /* ignore */ }
    try {
      const repoRoot = findRepoRoot(process.env.GIT_WORK_TREE || process.cwd());
      recordFilterFail(repoRoot, msg);
    } catch (_2) { /* ignore */ }
    process.exit(1);
  });
}

module.exports = { handshake, main, setBlocking };
