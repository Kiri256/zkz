'use strict';

const { spawnSync, spawn } = require('child_process');

function git(repoRoot, args, opts) {
  const o = opts || {};
  const r = spawnSync('git', args, {
    cwd: repoRoot,
    windowsHide: true,
    encoding: o.encoding === 'buffer' ? undefined : (o.encoding || 'utf8'),
    maxBuffer: o.maxBuffer || 64 * 1024 * 1024,
    input: o.input,
    env: process.env
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !o.allowFail) {
    const err = (r.stderr && r.stderr.toString()) || (r.stdout && r.stdout.toString()) || '';
    throw new Error('git ' + args.join(' ') + ' failed: ' + err.trim());
  }
  return r;
}

function gitText(repoRoot, args, opts) {
  const r = git(repoRoot, args, opts);
  return String(r.stdout || '').replace(/\r\n/g, '\n');
}

function gitOk(repoRoot, args) {
  const r = git(repoRoot, args, { allowFail: true });
  return r.status === 0;
}

function gitConfigGet(repoRoot, key) {
  const r = git(repoRoot, ['config', '--local', '--get', key], { allowFail: true });
  if (r.status !== 0) return '';
  return String(r.stdout || '').trim();
}

function gitConfigSet(repoRoot, key, value) {
  git(repoRoot, ['config', '--local', key, value]);
}

function gitConfigUnset(repoRoot, key) {
  git(repoRoot, ['config', '--local', '--unset', key], { allowFail: true });
}

function isWorktreeClean(repoRoot) {
  const out = gitText(repoRoot, ['status', '--porcelain']);
  return !out.trim();
}

function currentHead(repoRoot) {
  const r = git(repoRoot, ['rev-parse', 'HEAD'], { allowFail: true });
  if (r.status !== 0) return '';
  return String(r.stdout || '').trim();
}

function currentBranch(repoRoot) {
  const r = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  if (r.status !== 0) return '';
  return String(r.stdout || '').trim();
}

function listSourceFiles(repoRoot) {
  const out = gitText(repoRoot, ['ls-files', '-z', '--', '*.c', '*.h']);
  if (!out) return [];
  return out.split('\0').filter(Boolean);
}

function catFileBatch(repoRoot, specs) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: repoRoot,
      windowsHide: true
    });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', () => { /* ignore */ });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('git cat-file --batch failed'));
        return;
      }
      resolve(parseBatch(Buffer.concat(chunks), specs.length));
    });
    for (const spec of specs) child.stdin.write(spec + '\n');
    child.stdin.end();
  });
}

function parseBatch(buf, expect) {
  const out = [];
  let i = 0;
  while (i < buf.length && out.length < expect) {
    let nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const header = buf.slice(i, nl).toString('utf8');
    i = nl + 1;
    if (/\smissing$/.test(header)) {
      out.push({ missing: true, header: header, data: Buffer.alloc(0) });
      continue;
    }
    const parts = header.split(' ');
    const size = parseInt(parts[2], 10);
    if (!isFinite(size) || size < 0) {
      out.push({ missing: true, header: header, data: Buffer.alloc(0) });
      continue;
    }
    const data = buf.slice(i, i + size);
    i += size;
    if (buf[i] === 0x0a) i += 1;
    out.push({ missing: false, header: header, oid: parts[0], data: data });
  }
  return out;
}

module.exports = {
  git,
  gitText,
  gitOk,
  gitConfigGet,
  gitConfigSet,
  gitConfigUnset,
  isWorktreeClean,
  currentHead,
  currentBranch,
  listSourceFiles,
  catFileBatch
};
