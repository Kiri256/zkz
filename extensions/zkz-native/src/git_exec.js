'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

function gitArgs(args) {
  const a = args || [];
  if (process.env.ZKZ_NATIVE_HOOK === '1') {
    return ['-c', 'filter.zkznative.required=false'].concat(a);
  }
  return a;
}

function git(repoRoot, args, opts) {
  const o = opts || {};
  const r = spawnSync('git', gitArgs(args), {
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
    const child = spawn('git', gitArgs(['cat-file', '--batch']), {
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

function isOid(s) {
  return /^[0-9a-f]{40}$/i.test(s);
}

function gitDirOf(repoRoot) {
  if (!repoRoot) return '';
  const dot = path.join(repoRoot, '.git');
  let st = null;
  try { st = fs.statSync(dot); } catch (_) { return ''; }
  if (st.isDirectory()) return dot;
  try {
    const text = fs.readFileSync(dot, 'utf8');
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (!m) return '';
    return path.resolve(repoRoot, m[1].trim());
  } catch (_) {
    return '';
  }
}

function readPackedOid(gitDir, ref) {
  let text = '';
  try { text = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8'); } catch (_) { return ''; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.charAt(0) === '#' || line.charAt(0) === '^') continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const oid = line.slice(0, sp).trim();
    const name = line.slice(sp + 1).trim();
    if (name === ref && isOid(oid)) return oid.toLowerCase();
  }
  return '';
}

/** 读 .git/HEAD 得到当前 oid，不启动 git 进程。 */
function readHeadOid(repoRoot) {
  const gitDir = gitDirOf(repoRoot);
  if (!gitDir) return '';
  let head = '';
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch (_) { return ''; }
  if (isOid(head)) return head.toLowerCase();
  const m = head.match(/^ref:\s*(.+)$/);
  if (!m) return '';
  const ref = m[1].trim();
  try {
    const oid = fs.readFileSync(path.join(gitDir, ...ref.split('/')), 'utf8').trim();
    if (isOid(oid)) return oid.toLowerCase();
  } catch (_) { /* loose ref 不存在时查 packed-refs */ }
  return readPackedOid(gitDir, ref);
}

function catFileBatchSync(repoRoot, specs) {
  if (!specs || !specs.length) return [];
  const r = git(repoRoot, ['cat-file', '--batch'], {
    input: specs.join('\n') + '\n',
    encoding: 'buffer',
    allowFail: true
  });
  if (r.status !== 0 || !r.stdout) {
    return specs.map(() => ({ missing: true, data: Buffer.alloc(0) }));
  }
  const parsed = parseBatch(r.stdout, specs.length);
  while (parsed.length < specs.length) parsed.push({ missing: true, data: Buffer.alloc(0) });
  return parsed;
}

module.exports = {
  git,
  gitArgs,
  gitText,
  gitOk,
  gitConfigGet,
  gitConfigSet,
  gitConfigUnset,
  isWorktreeClean,
  currentHead,
  currentBranch,
  readHeadOid,
  gitDirOf,
  listSourceFiles,
  catFileBatch,
  catFileBatchSync
};
