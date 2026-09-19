'use strict';

const { slashRel, isSourceExt, isLibRel } = require('./paths');
const { loadTable } = require('./enc_table');
const { detectKind, applyClean, decodeCp936, parseMapped, roundtripOk } = require('./encoding');
const { isForbiddenStage, loadConfigPaths } = require('./config_freeze');
const { gitText, catFileBatch } = require('./git_exec');

function stagedNameStatus(repoRoot) {
  const out = gitText(repoRoot, ['diff', '--cached', '--name-status', '-z'], { allowFail: true });
  const recs = [];
  if (!out) return recs;
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    const code = status.charAt(0);
    if (code === 'R' || code === 'C') {
      const scoreAndOld = status;
      const oldPath = parts[i + 1] || '';
      const newPath = parts[i + 2] || '';
      recs.push({ status: code, oldPath: slashRel(oldPath), newPath: slashRel(newPath), raw: scoreAndOld });
      i += 2;
    } else {
      recs.push({ status: code, path: slashRel(status.slice(1).replace(/^\s+/, '') || parts[i + 1]), oldPath: '', newPath: '' });
      if (status.length <= 2) i += 1;
    }
  }
  return recs;
}

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

  const statusOut = gitText(repoRoot, ['diff', '--cached', '--name-status'], { allowFail: true });
  for (const line of String(statusOut || '').split('\n')) {
    const m = /^R\d+\t(.+)\t(.+)$/.exec(line);
    if (!m) continue;
    const oldPath = slashRel(m[1]);
    const newPath = slashRel(m[2]);
    if (parseMapped(table[oldPath]).kind === 'Gbk' && !table[newPath]) {
      errors.push('重命名 GBK 文件后未刷新编码表: ' + oldPath + ' -> ' + newPath);
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

module.exports = { checkStaged, runPrecommit, stagedPaths, evaluateStagedBlob };
