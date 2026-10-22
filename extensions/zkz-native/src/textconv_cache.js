'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { git, gitText, gitOk, gitConfigGet } = require('./git_exec');
const { loadTable } = require('./enc_table');
const { smudge } = require('./filter_core');

const TEXTCONV_NOTES = 'refs/notes/textconv/zkznative';

function notePath(sha) {
  const hex = String(sha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error('非法 blob：' + sha);
  return { prefix: hex.slice(0, 2), name: hex.slice(2), sha: hex };
}

function lsTree(repo, spec) {
  const r = git(repo, ['ls-tree', spec], { allowFail: true });
  if (r.status !== 0) return [];
  const entries = [];
  for (const line of String(r.stdout || '').replace(/\r\n/g, '\n').split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(' ');
    entries.push({ mode: meta[0], type: meta[1], sha: meta[2], name: line.slice(tab + 1) });
  }
  return entries;
}

function mkTree(repo, entries) {
  const sorted = entries.slice().sort(function (a, b) {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  const body = sorted.map(function (e) {
    return e.mode + ' ' + e.type + ' ' + e.sha + '\t' + e.name;
  }).join('\n') + '\n';
  return gitText(repo, ['mktree'], { input: body }).trim();
}

function commitMessage(repo, rev) {
  const raw = git(repo, ['cat-file', 'commit', rev], { encoding: 'buffer' }).stdout;
  const sep = Buffer.from('\n\n');
  const i = raw.indexOf(sep);
  if (i < 0) throw new Error('notes 提交没有说明');
  return raw.subarray(i + sep.length);
}

function writeCommit(repo, tree, message) {
  const header = Buffer.from(
    'tree ' + tree + '\n' +
    'author zkz <zkz@local> 0 +0000\n' +
    'committer zkz <zkz@local> 0 +0000\n' +
    '\n'
  );
  const body = Buffer.concat([header, Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8')]);
  const r = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: body, encoding: 'buffer' });
  return r.stdout.toString('utf8').trim();
}

function notesExist(repo) {
  return gitOk(repo, ['rev-parse', '--verify', '--quiet', TEXTCONV_NOTES]);
}

// 把已有的 note blob 挂进 refs/notes/textconv/zkznative。提交说明必须与 textconv 命令原文一致，否则 Git 会整份丢弃缓存。
function insertNotes(repo, pairs, validity) {
  if (!pairs.length) return { added: 0 };
  const exists = notesExist(repo);
  const message = exists ? commitMessage(repo, TEXTCONV_NOTES) : Buffer.from(String(validity || ''), 'utf8');
  if (!message.length) throw new Error('没有 textconv 命令，不能写缓存');
  const byPrefix = new Map();
  for (const pair of pairs) {
    const obj = notePath(pair.objectSha);
    const note = notePath(pair.noteSha);
    if (!byPrefix.has(obj.prefix)) byPrefix.set(obj.prefix, []);
    byPrefix.get(obj.prefix).push({ mode: '100644', type: 'blob', sha: note.sha, name: obj.name });
  }
  let root = exists ? lsTree(repo, TEXTCONV_NOTES) : [];
  for (const item of byPrefix) {
    const prefix = item[0];
    const adds = item[1];
    let sub = [];
    const existing = root.find(function (e) { return e.name === prefix; });
    if (existing) {
      if (existing.type !== 'tree') throw new Error('notes 扇出不是目录：' + prefix);
      sub = lsTree(repo, TEXTCONV_NOTES + ':' + prefix);
      if (sub.some(function (e) { return e.type !== 'blob'; })) {
        throw new Error('不支持更深的 notes 扇出：' + prefix);
      }
    }
    const map = new Map(sub.map(function (e) { return [e.name, e]; }));
    for (const add of adds) map.set(add.name, add);
    const subSha = mkTree(repo, Array.from(map.values()));
    if (existing) existing.sha = subSha;
    else root.push({ mode: '040000', type: 'tree', sha: subSha, name: prefix });
  }
  const rootSha = mkTree(repo, root);
  const commit = writeCommit(repo, rootSha, message);
  git(repo, ['update-ref', TEXTCONV_NOTES, commit]);
  return { added: pairs.length };
}

function listFollowBlobs(repo, rel) {
  const text = gitText(repo, ['log', '--follow', '--raw', '--no-abbrev', '--pretty=format:', '--', rel]);
  const ids = new Set();
  const re = /^:[0-7]+ [0-7]+ ([0-9a-f]{40}) ([0-9a-f]{40}) /;
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    if (!/^0+$/.test(m[1])) ids.add(m[1]);
    if (!/^0+$/.test(m[2])) ids.add(m[2]);
  }
  return Array.from(ids);
}

function missingNotes(repo, shas) {
  if (!shas.length || !notesExist(repo)) return shas.slice();
  const specs = shas.map(function (sha) {
    const p = notePath(sha);
    return TEXTCONV_NOTES + ':' + p.prefix + '/' + p.name;
  });
  const out = git(repo, ['cat-file', '--batch-check'], {
    input: specs.join('\n') + '\n',
    encoding: 'buffer'
  }).stdout.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  const missing = [];
  for (let i = 0; i < shas.length; i++) {
    if (String(out[i] || '').endsWith(' missing')) missing.push(shas[i]);
  }
  return missing;
}

// 一次 hash-object 写入全部转码结果，避免每个历史版本启动一次 Git。
function hashObjectPaths(repo, paths) {
  if (!paths.length) return [];
  const r = git(repo, ['hash-object', '-w', '--stdin-paths'], {
    input: paths.join('\n') + '\n',
    encoding: 'buffer'
  });
  const lines = r.stdout.toString('utf8').replace(/\r\n/g, '\n').trim().split('\n').filter(Boolean);
  if (lines.length !== paths.length) throw new Error('hash-object 数量不符');
  return lines;
}

// 流式读取 cat-file，缓冲区超过上限就暂停，避免整份历史进内存。
function catFileEach(repo, shas, onObject) {
  if (!shas.length) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: repo, windowsHide: true });
    let buf = Buffer.alloc(0);
    let header = null;
    let failed = false;
    const HIGH = 8 * 1024 * 1024;

    function fail(err) {
      if (failed) return;
      failed = true;
      try { child.kill(); } catch (_) { /* ignore */ }
      reject(err);
    }

    function pump() {
      while (!failed) {
        if (!header) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          const line = buf.slice(0, nl).toString('utf8');
          buf = buf.subarray(nl + 1);
          if (/\smissing$/.test(line)) {
            header = { missing: true };
          } else {
            const parts = line.split(' ');
            const size = parseInt(parts[2], 10);
            if (!isFinite(size) || size < 0) header = { missing: true };
            else header = { missing: false, oid: parts[0], size: size };
          }
        }
        if (header.missing) {
          onObject(header);
          header = null;
          continue;
        }
        const need = header.size + 1;
        if (buf.length < need) return;
        const data = Buffer.from(buf.subarray(0, header.size));
        const item = header;
        buf = buf.subarray(need);
        header = null;
        onObject({ missing: false, oid: item.oid, data: data });
      }
    }

    child.stdout.on('data', function (chunk) {
      if (failed) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try { pump(); } catch (e) { fail(e); return; }
      if (buf.length >= HIGH) child.stdout.pause();
      else child.stdout.resume();
    });
    child.stderr.on('data', function () { /* 错误体现在退出码 */ });
    child.on('error', fail);
    child.on('close', function (code) {
      if (failed) return;
      try { pump(); } catch (e) { fail(e); return; }
      if (header) { fail(new Error('git cat-file --batch 输出被截断')); return; }
      if (code !== 0) { fail(new Error('git cat-file --batch failed')); return; }
      resolve();
    });
    for (let i = 0; i < shas.length; i++) child.stdin.write(shas[i] + '\n');
    child.stdin.end();
  });
}

// 一次进程转完这个文件的全部历史 blob，避免 git blame 对每个版本各启动一次 node。
async function warmFile(repo, rel) {
  const blobs = listFollowBlobs(repo, rel);
  const missing = missingNotes(repo, blobs);
  if (!missing.length) return { blobs: blobs.length, added: 0 };
  const validity = gitConfigGet(repo, 'diff.zkznative.textconv');
  const table = loadTable(repo);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-warm-'));
  const files = [];
  const objectShas = [];
  try {
    await catFileEach(repo, missing, function (item) {
      if (item.missing) return;
      const text = smudge(rel, item.data, table, repo);
      const file = path.join(dir, String(files.length) + '.bin');
      fs.writeFileSync(file, text);
      files.push(file.split(path.sep).join('/'));
      objectShas.push(item.oid);
    });
    const notes = hashObjectPaths(repo, files);
    const pairs = [];
    for (let i = 0; i < notes.length; i++) {
      pairs.push({ objectSha: objectShas[i], noteSha: notes[i] });
    }
    const wrote = insertNotes(repo, pairs, validity);
    return { blobs: blobs.length, added: wrote.added };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  TEXTCONV_NOTES,
  insertNotes,
  listFollowBlobs,
  missingNotes,
  warmFile,
  commitMessage,
  hashObjectPaths,
  catFileEach
};
