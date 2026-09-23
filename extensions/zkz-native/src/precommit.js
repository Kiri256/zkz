'use strict';

const { slashRel, isSourceExt, isLibRel } = require('./paths');
const { loadTable } = require('./enc_table');
const { detectKind, applyClean, decodeCp936, parseMapped, roundtripOk } = require('./encoding');
const { isForbiddenStage, loadConfigPaths } = require('./config_freeze');
const { gitText, catFileBatch } = require('./git_exec');
const { parseNameStatusZ } = require('./git_status');
const { inspectLibEncoding, libEncodingStrict, formatLibWarning, libSourceRels } = require('./lib_encoding');

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
      return { error: rel + ': 新文件按 UTF-8 入库，但暂存 blob 是 GBK' };
    }
    return {};
  }
  if (mappedKind === 'Gbk') {
    if (kind === 'Utf8' || kind === 'Utf8Bom') {
      return { error: rel + ': 表为 Gbk，暂存 blob 是 ' + kind + '（含 cp936 无法编码的字符，或过滤器未转回）' };
    }
    try {
      const text = decodeCp936(data);
      if (!roundtripOk(text)) {
        return { error: rel + ': 暂存 blob 往返自检失败' };
      }
      applyClean('Gbk', Buffer.from(text, 'utf8'), { crlf: parseMapped(mapped).crlf });
    } catch (e) {
      return { error: rel + ': 暂存 blob 往返自检失败 (' + (e && e.message ? e.message : e) + ')' };
    }
    return {};
  }
  if (mappedKind !== kind && !(mappedKind === 'Ascii' && kind === 'Utf8') && !(mappedKind === 'Utf8' && kind === 'Ascii')) {
    if (mappedKind === 'Utf8Bom' && kind === 'Utf8Bom') return {};
    if (mappedKind === kind) return {};
    return { warning: rel + ': 表为 ' + mapped + '，暂存检测为 ' + kind };
  }
  return {};
}

async function checkStaged(repoRoot) {
  const errors = [];
  const warnings = [];
  const table = loadTable(repoRoot);
  const paths = stagedPaths(repoRoot);
  const forbidCfg = loadConfigPaths(repoRoot);
  for (const rel of paths) {
    if (isForbiddenStage(repoRoot, rel, forbidCfg)) {
      errors.push('禁止暂存本机配置: ' + rel);
    }
  }

  const statusOut = gitText(repoRoot, ['diff', '--cached', '--name-status', '-z'], { allowFail: true });
  const parsed = parseNameStatusZ(statusOut);
  for (const rec of parsed.records) {
    if (rec.status !== 'R' && rec.status !== 'C') continue;
    const oldPath = rec.oldPath;
    const newPath = rec.path;
    if (parseMapped(table[oldPath]).kind === 'Gbk' && !table[newPath]) {
      errors.push('重命名 GBK 文件后未刷新编码表: ' + oldPath + ' -> ' + newPath);
    }
  }

  const stagedLibs = libSourceRels(repoRoot, paths);
  if (stagedLibs.length) {
    const libHits = inspectLibEncoding(repoRoot, stagedLibs, { mode: 'index', persist: true });
    const strictLib = libEncodingStrict(repoRoot);
    for (const hit of libHits) {
      const msg = formatLibWarning(hit);
      if (strictLib) errors.push(msg);
      else warnings.push(msg);
    }
  }

  const src = paths.filter((p) => isSourceExt(p) && !isLibRel(repoRoot, p));
  if (src.length) {
    const blobs = await catFileBatch(repoRoot, src.map((p) => ':' + p));
    for (let i = 0; i < src.length; i++) {
      const rel = src[i];
      const rec = blobs[i];
      if (!rec || rec.missing) continue;
      const mapped = table[rel];
      const verdict = evaluateStagedBlob(rel, rec.data, mapped);
      if (verdict.error) errors.push(verdict.error);
      if (verdict.warning) warnings.push(verdict.warning);
    }
  }

  return { errors: errors, warnings: warnings };
}

async function runPrecommit(repoRoot) {
  const r = await checkStaged(repoRoot);
  for (const w of r.warnings) process.stderr.write('zkz-native warning: ' + w + '\n');
  if (r.errors.length) {
    for (const e of r.errors) process.stderr.write('zkz-native: ' + e + '\n');
    process.stderr.write('提交已拒绝。刷新编码表: zkz-native.refreshTable\n');
    return 1;
  }
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
    const pushedLibs = libSourceRels(repoRoot, all);
    if (!isZeroSha(remoteSha) && pushedLibs.length) {
      const hits = inspectLibEncoding(repoRoot, pushedLibs, {
        mode: 'range',
        oldSha: remoteSha,
        newSha: localSha,
        persist: true
      });
      const strictLib = libEncodingStrict(repoRoot);
      for (const hit of hits) {
        const msg = formatLibWarning(hit);
        if (strictLib) errors.push(msg);
        else process.stderr.write('zkz-native warning: ' + msg + '\n');
      }
    }
  }
  if (errors.length) {
    for (const e of errors) process.stderr.write('zkz-native: ' + e + '\n');
    process.stderr.write('推送已拒绝。编码与表不一致，请刷新编码表后重提交。\n');
    return 1;
  }
  return 0;
}

module.exports = { checkStaged, runPrecommit, runPrepush, stagedPaths, evaluateStagedBlob };
