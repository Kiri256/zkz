'use strict';

const fs = require('fs');
const path = require('path');
const { slashRel, isSourceExt, isLibRel } = require('./paths');
const { loadTable, noteNewFile } = require('./enc_table');
const { detectKind, applyClean, decodeCp936, parseMapped, roundtripOk, encodeMapped, hasCrlf, firstUnencodable, wtToText } = require('./encoding');
const { recordCommitReject, clearCommitReject, loadCommitRejects } = require('./observe');
const { git, gitText, catFileBatch } = require('./git_exec');
const { parseNameStatusZ } = require('./git_status');
const { inspectLibEncoding, formatLibWarning, libSourceRels } = require('./lib_encoding');

function stagedPaths(repoRoot) {
  const out = gitText(repoRoot, ['diff', '--cached', '--name-only', '-z'], { allowFail: true });
  if (!out) return [];
  return out.split('\0').filter(Boolean).map(slashRel);
}

function evaluateStagedBlob(rel, data, mapped) {
  const kind = detectKind(data);
  const mappedKind = parseMapped(mapped).kind;
  if (!mapped) {
    if (kind === 'Gbk') {
      try {
        const text = decodeCp936(data);
        if (!roundtripOk(text)) return openError(rel, rel + ': 新文件 GBK 往返失败');
      } catch (e) {
        return openError(rel, rel + ': 新文件不是合法 GBK (' + (e && e.message ? e.message : e) + ')');
      }
      return {};
    }
    return {};
  }
  if (mappedKind === 'Gbk') {
    if (kind === 'Utf8' || kind === 'Utf8Bom') {
      return gbkObligation(rel, data, parseMapped(mapped).crlf, 'Gbk');
    }
    try {
      const text = decodeCp936(data);
      if (!roundtripOk(text)) return openError(rel, rel + ': 暂存 blob 往返自检失败');
      applyClean('Gbk', Buffer.from(text, 'utf8'), { crlf: parseMapped(mapped).crlf });
    } catch (e) {
      return openError(rel, rel + ': 暂存 blob 往返自检失败 (' + (e && e.message ? e.message : e) + ')');
    }
    return {};
  }
  if (mappedKind === 'Ascii' && kind !== 'Ascii') return gbkObligation(rel, data, false, 'Ascii');
  if (mappedKind !== kind && !(mappedKind === 'Utf8' && kind === 'Ascii')) {
    return { warning: rel + ': 表为 ' + mapped + '，暂存检测为 ' + kind };
  }
  return {};
}

function inheritMapping(repoRoot, table, oldPath, newPath, mapped) {
  const next = mapped || table[oldPath];
  if (!next) return '';
  const stored = noteNewFile(repoRoot, newPath, next, { overwrite: true }) || next;
  table[newPath] = stored;
  return stored;
}

function encHint(data) {
  try {
    const hint = firstUnencodable(wtToText(data));
    const m = hint && /at (\d+)/.exec(hint);
    return { hint: hint || '', position: m ? Number(m[1]) : undefined };
  } catch (_) {
    return { hint: '', position: undefined };
  }
}

function openError(rel, message) {
  return { error: message, message: message, action: 'open', rel: rel };
}

function describeUnencodable(rel, data) {
  const hint = encHint(data);
  return rel + ': HEAD 是 GBK，暂存内容无法编回 cp936' + (hint.hint ? '（' + hint.hint + '）' : '');
}

// 一条路径只要改名前、HEAD 或编码表有一处是 GBK，暂存 blob 就得是 GBK。
function gbkObligation(rel, data, crlf, source, oldPath) {
  const kind = data ? detectKind(data) : '';
  const hint = encHint(data);
  if (canEncodeGbk(data, crlf)) {
    const message = source === 'rewritten'
      ? gbkRestageError(oldPath || '', rel, kind)
      : (rel + ': 表为 ' + source + '，暂存 blob 是 ' + kind + '。请重新 git add：' + rel);
    return { rel: rel, action: 'restage', message: message, error: message, position: hint.position };
  }
  let message;
  if (source === 'rewritten') message = describeUnencodable(rel, data);
  else if (source === 'Ascii') message = rel + ': 表为 Ascii，暂存内容无法编回 cp936' + (hint.hint ? '（' + hint.hint + '）' : '');
  else message = rel + ': 表为 Gbk，暂存内容无法编回 cp936' + (hint.hint ? '（' + hint.hint + '）' : '');
  return { rel: rel, action: 'open', message: message, error: message, position: hint.position };
}

function gbkRestageError(oldPath, newPath, kind) {
  const where = oldPath && oldPath !== newPath ? (oldPath + ' -> ' + newPath) : newPath;
  return 'GBK 文件暂存成了 ' + kind + '。编码表已改回 GBK，请重新 git add：' + where;
}

function canEncodeGbk(data, crlf) {
  let soft = false;
  let encoded = null;
  try {
    encoded = applyClean('Gbk', data, {
      crlf: !!crlf,
      onSoftFail: () => { soft = true; }
    });
  } catch (_) {
    return false;
  }
  return !soft && !!encoded && detectKind(encoded) === 'Gbk';
}

function pushFinding(findings, item) {
  if (!item || !item.message) return;
  findings.push({
    rel: item.rel || '',
    action: item.action || 'message',
    message: item.message,
    position: item.position
  });
}

async function checkStaged(repoRoot) {
  const findings = [];
  const warnings = [];
  const table = loadTable(repoRoot);
  const paths = stagedPaths(repoRoot);
  const statusOut = gitText(repoRoot, ['diff', '--cached', '--name-status', '-z'], { allowFail: true });
  const parsed = parseNameStatusZ(statusOut);
  const stagedLibs = libSourceRels(repoRoot, paths);
  if (stagedLibs.length) {
    const libHits = inspectLibEncoding(repoRoot, stagedLibs, { mode: 'index', persist: true });
    for (const hit of libHits) warnings.push(formatLibWarning(hit));
  }

  const src = paths.filter((p) => isSourceExt(p) && !isLibRel(repoRoot, p));
  const indexBlobs = new Map();
  const blocked = new Set();
  if (src.length) {
    const blobs = await catFileBatch(repoRoot, src.map((p) => ':' + p));
    for (let i = 0; i < src.length; i++) {
      const rec = blobs[i];
      if (rec && !rec.missing) indexBlobs.set(src[i], rec.data);
    }
    await guardGbkSources(repoRoot, table, parsed, src, indexBlobs, findings, blocked);
    for (let i = 0; i < src.length; i++) {
      const rel = src[i];
      if (blocked.has(rel) || !indexBlobs.has(rel)) continue;
      const verdict = evaluateStagedBlob(rel, indexBlobs.get(rel), table[rel]);
      if (verdict.error) {
        pushFinding(findings, {
          rel: verdict.rel || rel,
          action: verdict.action || 'message',
          message: verdict.message || verdict.error,
          position: verdict.position
        });
      }
      if (verdict.warning) warnings.push(verdict.warning);
    }
  }

  return { errors: findings.map((item) => item.message), warnings: warnings, findings: findings };
}

async function guardGbkSources(repoRoot, table, parsed, src, indexBlobs, findings, blocked) {
  for (let i = 0; i < parsed.records.length; i++) {
    const rec = parsed.records[i];
    if (rec.status !== 'R' && rec.status !== 'C') continue;
    if (parseMapped(table[rec.oldPath]).kind !== 'Gbk') continue;
    const data = indexBlobs.get(rec.path);
    const kind = data ? detectKind(data) : '';
    if (kind && kind !== 'Gbk') {
      inheritMapping(repoRoot, table, rec.oldPath, rec.path);
      pushFinding(findings, gbkObligation(rec.path, data, parseMapped(table[rec.oldPath]).crlf, 'rewritten', rec.oldPath));
      blocked.add(rec.path);
    } else if (parseMapped(table[rec.path]).kind !== 'Gbk') {
      inheritMapping(repoRoot, table, rec.oldPath, rec.path);
    }
  }
  const deleted = parsed.records.filter((rec) => rec.status === 'D' && parseMapped(table[rec.path]).kind === 'Gbk');
  const added = parsed.records.filter((rec) => rec.status === 'A' && indexBlobs.has(rec.path));
  if (deleted.length && added.length) {
    const oldBlobs = await catFileBatch(repoRoot, deleted.map((rec) => 'HEAD:' + rec.path));
    for (let a = 0; a < added.length; a++) {
      const rel = added[a].path;
      if (blocked.has(rel)) continue;
      const data = indexBlobs.get(rel);
      if (!data || detectKind(data) === 'Gbk') continue;
      for (let d = 0; d < deleted.length; d++) {
        const old = oldBlobs[d];
        if (!old || old.missing) continue;
        let encoded = null;
        try {
          encoded = applyClean('Gbk', data, { crlf: parseMapped(table[deleted[d].path]).crlf });
        } catch (_) {
          encoded = null;
        }
        if (!encoded || !encoded.equals(Buffer.from(old.data))) continue;
        inheritMapping(repoRoot, table, deleted[d].path, rel);
        pushFinding(findings, gbkObligation(rel, data, parseMapped(table[deleted[d].path]).crlf, 'rewritten', deleted[d].path));
        blocked.add(rel);
        break;
      }
    }
  }
  const pending = src.filter((rel) => !blocked.has(rel) && indexBlobs.has(rel) && detectKind(indexBlobs.get(rel)) !== 'Gbk');
  if (!pending.length) return;
  const heads = await catFileBatch(repoRoot, pending.map((rel) => 'HEAD:' + rel));
  for (let i = 0; i < pending.length; i++) {
    const head = heads[i];
    if (!head || head.missing || detectKind(head.data) !== 'Gbk') continue;
    const rel = pending[i];
    const mapped = encodeMapped(detectKind(head.data), hasCrlf(head.data));
    inheritMapping(repoRoot, table, '', rel, mapped);
    pushFinding(findings, gbkObligation(rel, indexBlobs.get(rel), hasCrlf(head.data), 'rewritten'));
    blocked.add(rel);
  }
}

function worktreeText(repoRoot, rel) {
  try {
    return wtToText(fs.readFileSync(path.join(repoRoot, ...String(rel).split('/'))));
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    return undefined;
  }
}

function stagedBlob(repoRoot, rel) {
  try {
    const r = git(repoRoot, ['cat-file', 'blob', ':' + rel], { encoding: 'buffer', allowFail: true });
    if (r.status === 0) return r.stdout;
    const err = String((r.stderr && r.stderr.toString()) || '');
    if (/Not a valid object name|does not exist|bad revision|pathspec/i.test(err)) return null;
    return undefined;
  } catch (_) {
    return undefined;
  }
}

function openReject(rel, text) {
  const hint = text ? firstUnencodable(text) : '';
  const at = hint && /at (\d+)/.exec(hint);
  const row = {
    rel: rel,
    action: 'open',
    message: rel + ': 暂存内容无法编回 cp936' + (hint ? '（' + hint + '）' : '')
  };
  if (at) row.position = Number(at[1]);
  return row;
}

function restageReject(rel) {
  return { rel: rel, action: 'restage', message: rel + ': 请重新 git add：' + rel };
}

// 工作区已经改好、或暂存区已经是 GBK 时，丢掉过期的拒绝。仍写不回的保持打开。
function reconcileOne(repoRoot, table, item) {
  if (!item || !item.rel || (item.action !== 'restage' && item.action !== 'open')) return item;
  const text = worktreeText(repoRoot, item.rel);
  if (text === undefined) return item;
  if (text === null) return null;
  if (firstUnencodable(text)) return item.action === 'open' ? item : openReject(item.rel, text);
  const blob = stagedBlob(repoRoot, item.rel);
  if (blob === undefined) return item;
  if (!blob) return null;
  const kind = detectKind(blob);
  const mappedKind = parseMapped(table[item.rel]).kind;
  const wantGbk = mappedKind === 'Gbk' || (mappedKind === 'Ascii' && kind !== 'Ascii') || (!mappedKind && item.action === 'restage');
  if (wantGbk && kind !== 'Gbk') return item.action === 'restage' ? item : restageReject(item.rel);
  return null;
}

function reconcileCommitReject(repoRoot) {
  const items = loadCommitRejects(repoRoot);
  if (!items.length) return items;
  const table = loadTable(repoRoot);
  let changed = false;
  const left = [];
  for (let i = 0; i < items.length; i++) {
    const next = reconcileOne(repoRoot, table, items[i]);
    if (!next) {
      changed = true;
      continue;
    }
    if (next.action !== items[i].action || next.message !== items[i].message || next.position !== items[i].position) {
      changed = true;
    }
    left.push(next);
  }
  if (changed) {
    if (!left.length) clearCommitReject(repoRoot);
    else recordCommitReject(repoRoot, left);
  }
  return left;
}

async function runPrecommit(repoRoot) {
  try { require('./local_filter').keepCommitBlob(repoRoot); }
  catch (e) {
    process.stderr.write('zkz-native: ' + String(e && e.message ? e.message : e) + '\n');
    return 1;
  }
  const r = await checkStaged(repoRoot);
  for (const w of r.warnings) process.stderr.write('zkz-native warning: ' + w + '\n');
  if (r.errors.length) {
    for (const e of r.errors) process.stderr.write('zkz-native: ' + e + '\n');
    process.stderr.write('提交已拒绝。若提示重新 git add，按提示再暂存一次。\n');
    try { recordCommitReject(repoRoot, r.findings || []); } catch (_) { /* ignore */ }
    return 1;
  }
  try { clearCommitReject(repoRoot); } catch (_) { /* ignore */ }
  return 0;
}

function isZeroSha(s) {
  return !s || /^0+$/.test(String(s));
}

function readStdinText() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const t = setTimeout(done, 8000);
    process.stdin.on('data', (c) => chunks.push(Buffer.from(c)));
    process.stdin.on('end', () => { clearTimeout(t); done(); });
    process.stdin.on('error', () => { clearTimeout(t); done(); });
    try { process.stdin.resume(); } catch (_) { clearTimeout(t); done(); }
  });
}

async function findPushedEncodingErrors(repoRoot, oldSha, newSha) {
  const errors = [];
  if (isZeroSha(oldSha) || isZeroSha(newSha)) return errors;
  const out = gitText(repoRoot, ['diff', '--name-status', '-z', oldSha, newSha, '--', '*.c', '*.h'], { allowFail: true });
  const parsed = parseNameStatusZ(out);
  const jobs = [];
  for (let i = 0; i < parsed.records.length; i++) {
    const rec = parsed.records[i];
    if (rec.status !== 'M' && rec.status !== 'R' && rec.status !== 'C' && rec.status !== 'T') continue;
    const prev = rec.status === 'R' || rec.status === 'C' ? rec.oldPath : rec.path;
    if (!prev || !rec.path) continue;
    if (isLibRel(repoRoot, prev) || isLibRel(repoRoot, rec.path)) continue;
    jobs.push({ prev: prev, path: rec.path });
  }
  if (!jobs.length) return errors;
  const blobs = await catFileBatch(repoRoot, jobs.reduce((acc, job) => {
    acc.push(oldSha + ':' + job.prev, newSha + ':' + job.path);
    return acc;
  }, []));
  for (let i = 0; i < jobs.length; i++) {
    const old = blobs[i * 2];
    const next = blobs[i * 2 + 1];
    if (!old || old.missing || !next || next.missing) continue;
    if (detectKind(old.data) !== 'Gbk' || detectKind(next.data) === 'Gbk') continue;
    const where = jobs[i].prev === jobs[i].path ? jobs[i].path : (jobs[i].prev + ' -> ' + jobs[i].path);
    errors.push(where + ': 推送把 GBK 改成了 ' + detectKind(next.data));
  }
  return errors;
}

async function checkPushedBlobs(repoRoot, sha, rels) {
  const errors = [];
  if (!rels.length) return errors;
  const table = loadTable(repoRoot);
  const blobs = await catFileBatch(repoRoot, rels.map((p) => sha + ':' + p));
  for (let i = 0; i < rels.length; i++) {
    const rec = blobs[i];
    if (!rec || rec.missing) continue;
    const verdict = evaluateStagedBlob(rels[i], rec.data, table[rels[i]]);
    if (verdict.error) errors.push(verdict.error);
  }
  return errors;
}

async function runPrepush(repoRoot) {
  const raw = await readStdinText();
  const lines = String(raw || '').split(/\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return 0;
  const errors = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const localSha = parts[1] || '';
    const remoteSha = parts[3] || '';
    if (isZeroSha(localSha)) continue;
    let names = '';
    if (isZeroSha(remoteSha)) {
      names = gitText(repoRoot, ['ls-tree', '-z', '-r', '--name-only', localSha], { allowFail: true });
    } else {
      names = gitText(repoRoot, ['diff', '--name-only', '-z', remoteSha, localSha], { allowFail: true });
    }
    const all = String(names || '').split('\0').filter(Boolean).map(slashRel);
    const rels = all.filter((p) => isSourceExt(p) && !isLibRel(repoRoot, p));
    const found = await checkPushedBlobs(repoRoot, localSha, rels);
    found.forEach((e) => errors.push(e));
    const rewritten = await findPushedEncodingErrors(repoRoot, remoteSha, localSha);
    rewritten.forEach((e) => errors.push(e));
    const pushedLibs = libSourceRels(repoRoot, all);
    if (!isZeroSha(remoteSha) && pushedLibs.length) {
      const hits = inspectLibEncoding(repoRoot, pushedLibs, {
        mode: 'range',
        oldSha: remoteSha,
        newSha: localSha,
        persist: true
      });
      for (const hit of hits) process.stderr.write('zkz-native warning: ' + formatLibWarning(hit) + '\n');
    }
  }
  if (errors.length) {
    for (const e of errors) process.stderr.write('zkz-native: ' + e + '\n');
    process.stderr.write('推送已拒绝。编码与表不一致，请刷新编码表后重提交。\n');
    return 1;
  }
  return 0;
}

module.exports = {
  checkStaged,
  runPrecommit,
  runPrepush,
  stagedPaths,
  evaluateStagedBlob,
  findPushedEncodingErrors,
  reconcileCommitReject
};
