'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { slashRel } = require('./paths');

function gitArgs(args) {
  const a = args || [];
  if (process.env.ZKZ_NATIVE_HOOK === '1') {
    return ['-c', 'filter.zkznative.required=false'].concat(a);
  }
  return a;
}

function git(repoRoot, args, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env);
  // 监视进程自己也会调用 git。这两个变量如果传进过滤器，过滤器会再开一个监视进程，clean 就不跑了。
  delete env.ZKZ_LOCAL_WATCH;
  delete env.ZKZ_LOCAL_REPO;
  // 替身进程里指向真正的 git.exe，避免 checkout-index 再进到自己。
  const bin = (process.env.ZKZ_REAL_GIT && fs.existsSync(process.env.ZKZ_REAL_GIT))
    ? process.env.ZKZ_REAL_GIT
    : 'git';
  const r = spawnSync(bin, gitArgs(args), {
    cwd: repoRoot,
    windowsHide: true,
    encoding: o.encoding === 'buffer' ? undefined : (o.encoding || 'utf8'),
    maxBuffer: o.maxBuffer || 64 * 1024 * 1024,
    input: o.input,
    timeout: o.timeout,
    env: env
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
  return readHeadOid(repoRoot);
}

function currentBranch(repoRoot) {
  const ref = readHeadName(repoRoot);
  if (ref === 'detached') return ref;
  return ref.indexOf('refs/heads/') === 0 ? ref.slice('refs/heads/'.length) : ref;
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

function commonGitDir(gitDir) {
  try {
    const text = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (text) return path.resolve(gitDir, text);
  } catch (_) { /* 普通仓库没有 commondir */ }
  return gitDir;
}

// HEAD、分支 loose ref、packed-refs。同分支提交只改 refs/heads，不改 HEAD。
function refWatchPaths(repoRoot) {
  const gitDir = gitDirOf(repoRoot);
  if (!gitDir) return [];
  const common = commonGitDir(gitDir);
  return [
    path.join(gitDir, 'HEAD'),
    path.join(common, 'refs', 'heads'),
    path.join(common, 'packed-refs')
  ];
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

/** 当前分支。符号引用返回 refs/heads/...；分离 HEAD 返回 detached。同分支提交、撤回不变。 */
function readHeadName(repoRoot) {
  const gitDir = gitDirOf(repoRoot);
  if (!gitDir) return '';
  let head = '';
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch (_) { return ''; }
  if (isOid(head)) return 'detached';
  const m = head.match(/^ref:\s*(.+)$/);
  if (!m) return '';
  return m[1].trim();
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

const gIndexCache = { root: '', mtime: 0, size: 0, map: null };

/** 读索引里 stage 0 的 blob oid。索引读不到返回 null；没有 stage 0 返回空串。不启动 git。 */
function indexBlobOid(repoRoot, rel) {
  const map = indexOidMap(repoRoot);
  if (!map) return null;
  return map.get(slashRel(rel)) || '';
}

function indexOidMap(repoRoot) {
  const gitDir = gitDirOf(repoRoot);
  if (!gitDir) return null;
  const file = path.join(gitDir, 'index');
  let st = null;
  try { st = fs.statSync(file); } catch (_) { return null; }
  if (gIndexCache.map && gIndexCache.root === repoRoot && gIndexCache.mtime === st.mtimeMs && gIndexCache.size === st.size) {
    return gIndexCache.map;
  }
  let buf = null;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  const map = parseIndexOids(buf);
  if (!map) return null;
  gIndexCache.root = repoRoot;
  gIndexCache.mtime = st.mtimeMs;
  gIndexCache.size = st.size;
  gIndexCache.map = map;
  return map;
}

// 索引 v4 路径压缩用的变长整数。和 Git 的 decode_varint 一致。
function decodeIndexVarint(buf, offset) {
  if (offset >= buf.length) return null;
  let i = offset;
  let c = buf[i++];
  let val = c & 127;
  while (c & 128) {
    val += 1;
    if (val > 0x0fffffff) return null;
    if (i >= buf.length) return null;
    c = buf[i++];
    val = (val * 128) + (c & 127);
  }
  return { value: val, offset: i };
}

function parseIndexOids(buf) {
  if (!buf || buf.length < 12 || buf.slice(0, 4).toString('ascii') !== 'DIRC') return null;
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3 && version !== 4) return null;
  const count = buf.readUInt32BE(8);
  const map = new Map();
  let offset = 12;
  let prevName = '';
  for (let n = 0; n < count; n++) {
    if (offset + 62 > buf.length) return null;
    const sha = buf.slice(offset + 40, offset + 60).toString('hex');
    const flags = buf.readUInt16BE(offset + 60);
    const stage = (flags >> 12) & 3;
    let nameStart = offset + 62;
    if ((flags & 0x4000) !== 0) {
      if (version < 3 || nameStart + 2 > buf.length) return null;
      nameStart += 2;
    }
    let name = '';
    let entryEnd = nameStart;
    if (version === 4) {
      const decoded = decodeIndexVarint(buf, nameStart);
      if (!decoded) return null;
      const nul = buf.indexOf(0, decoded.offset);
      if (nul < 0 || decoded.value > prevName.length) return null;
      const suffix = buf.slice(decoded.offset, nul).toString('utf8');
      name = prevName.slice(0, prevName.length - decoded.value) + suffix;
      prevName = name;
      entryEnd = nul + 1;
    } else {
      let nameLen = flags & 0x0fff;
      if (nameLen === 0x0fff) {
        const end = buf.indexOf(0, nameStart);
        if (end < 0) return null;
        name = buf.slice(nameStart, end).toString('utf8');
        nameLen = end - nameStart;
      } else {
        if (nameStart + nameLen > buf.length) return null;
        name = buf.slice(nameStart, nameStart + nameLen).toString('utf8');
      }
      entryEnd = nameStart + nameLen + 1;
      const span = entryEnd - offset;
      entryEnd += (8 - (span % 8)) % 8;
    }
    if (entryEnd > buf.length) return null;
    if (stage === 0 && name) map.set(slashRel(name), sha);
    offset = entryEnd;
  }
  return map;
}

function tryCatFileBatch(repoRoot, specs) {
  if (!specs || !specs.length) return [];
  const r = git(repoRoot, ['cat-file', '--batch'], {
    input: specs.join('\n') + '\n',
    encoding: 'buffer',
    allowFail: true,
    timeout: 15000
  });
  if (r.status !== 0 || !r.stdout) return null;
  const parsed = parseBatch(r.stdout, specs.length);
  while (parsed.length < specs.length) parsed.push({ missing: true, data: Buffer.alloc(0) });
  return parsed;
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
  readHeadName,
  readHeadOid,
  gitDirOf,
  refWatchPaths,
  listSourceFiles,
  catFileBatch,
  catFileBatchSync,
  tryCatFileBatch,
  indexBlobOid
};
