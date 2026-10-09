'use strict';

// 库文件不走 clean/smudge。这里只比较「仓库字节」和「即将交给 Keil/提交的字节」，
// 发现 GBK→UTF-8 漂移或 U+FFFD 时记下告警，不改文件、不拦编译。

const fs = require('fs');
const path = require('path');
const { detectKind, decodeCp936, roundtripOk } = require('./encoding');
const { slashRel, isSourceExt, isLibRel, ensureZkz, formatLocalNow, atomicWriteJson, libEncodingWarnPath } = require('./paths');
const { catFileBatchSync, gitConfigGet } = require('./git_exec');

function countFffdBytes(buf) {
  if (!buf || buf.length < 3) return 0;
  let n = 0;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xEF && buf[i + 1] === 0xBF && buf[i + 2] === 0xBD) n++;
  }
  return n;
}

function judgeLibChange(rel, oldBuf, newBuf, hasOld) {
  const next = newBuf ? Buffer.from(newBuf) : Buffer.alloc(0);
  const wtKind = detectKind(next);
  const fffd = countFffdBytes(next);
  const reasons = [];
  let blobKind = '';
  if (hasOld) {
    blobKind = detectKind(oldBuf ? Buffer.from(oldBuf) : Buffer.alloc(0));
    if (blobKind === 'Gbk' && (wtKind === 'Utf8' || wtKind === 'Utf8Bom')) reasons.push('drift');
  }
  if (fffd > 0) reasons.push('fffd');
  if (wtKind === 'Gbk' && next.length) {
    try {
      if (!roundtripOk(decodeCp936(next))) reasons.push('roundtrip');
    } catch (_) {
      reasons.push('roundtrip');
    }
  }
  if (!reasons.length) return null;
  return {
    rel: slashRel(rel),
    blobKind: blobKind,
    wtKind: wtKind,
    fffd: fffd,
    reasons: reasons
  };
}

function warningKey(items) {
  return (items || []).map((it) => it.rel + '|' + (it.reasons || []).join(',')).sort().join('\n');
}

function readLibWarningFile(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(libEncodingWarnPath(repoRoot), 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadLibWarnings(repoRoot) {
  const raw = readLibWarningFile(repoRoot);
  if (!raw || !Array.isArray(raw.items)) return [];
  return raw.items;
}

function libWarningsNotified(repoRoot) {
  const raw = readLibWarningFile(repoRoot);
  return !!(raw && raw.notified);
}

function saveLibWarnings(repoRoot, items) {
  ensureZkz(repoRoot);
  const list = items || [];
  const key = warningKey(list);
  const prev = readLibWarningFile(repoRoot);
  const notified = !!(prev && prev.key === key && prev.notified);
  atomicWriteJson(libEncodingWarnPath(repoRoot), {
    at: formatLocalNow(),
    key: key,
    notified: list.length ? notified : true,
    items: list
  });
  return list;
}

function markLibWarningsNotified(repoRoot) {
  const raw = readLibWarningFile(repoRoot);
  if (!raw) return;
  raw.notified = true;
  try {
    ensureZkz(repoRoot);
    atomicWriteJson(libEncodingWarnPath(repoRoot), raw);
  } catch (_) { /* ignore */ }
}

function libEncodingStrict(repoRoot) {
  if (process.env.ZKZ_LIB_ENCODING_STRICT === '1') return true;
  try {
    const v = String(gitConfigGet(repoRoot, 'zkz.libEncodingStrict') || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  } catch (_) {
    return false;
  }
}

function libSourceRels(repoRoot, rels) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < (rels || []).length; i++) {
    const rel = slashRel(rels[i]);
    if (!rel || seen.has(rel)) continue;
    if (!isSourceExt(rel) || !isLibRel(repoRoot, rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

function readWorktree(repoRoot, rel) {
  try {
    return { missing: false, data: fs.readFileSync(path.join(repoRoot, ...slashRel(rel).split('/'))) };
  } catch (_) {
    return { missing: true, data: Buffer.alloc(0) };
  }
}

/**
 * @param {'worktree'|'index'|'range'} mode
 * range 需要 opts.oldSha / opts.newSha
 */
function inspectLibEncoding(repoRoot, rels, opts) {
  const o = opts || {};
  const mode = o.mode || 'worktree';
  const libs = libSourceRels(repoRoot, rels);
  if (!libs.length) {
    if (o.persist) saveLibWarnings(repoRoot, []);
    return [];
  }
  const heads = catFileBatchSync(repoRoot, libs.map((rel) => 'HEAD:' + rel));
  let news;
  if (mode === 'worktree') {
    news = libs.map((rel) => readWorktree(repoRoot, rel));
  } else if (mode === 'index') {
    news = catFileBatchSync(repoRoot, libs.map((rel) => ':' + rel));
  } else {
    const sha = o.newSha || 'HEAD';
    news = catFileBatchSync(repoRoot, libs.map((rel) => sha + ':' + rel));
    if (o.oldSha) {
      const olds = catFileBatchSync(repoRoot, libs.map((rel) => o.oldSha + ':' + rel));
      for (let i = 0; i < libs.length; i++) heads[i] = olds[i];
    }
  }
  const items = [];
  for (let i = 0; i < libs.length; i++) {
    const head = heads[i];
    const next = news[i];
    if (!next || next.missing) continue;
    const hasOld = !!(head && !head.missing);
    const hit = judgeLibChange(libs[i], hasOld ? head.data : null, next.data, hasOld);
    if (hit) items.push(hit);
  }
  if (o.persist !== false) saveLibWarnings(repoRoot, items);
  return items;
}

function formatLibWarning(item) {
  const why = (item.reasons || []).join(',');
  return item.rel + ': 库文件编码 ' + why + '（blob=' + (item.blobKind || '-') + '，当前=' + item.wtKind + '，FFFD=' + item.fffd + '）';
}

module.exports = {
  countFffdBytes,
  judgeLibChange,
  loadLibWarnings,
  saveLibWarnings,
  libWarningsNotified,
  markLibWarningsNotified,
  libEncodingStrict,
  libSourceRels,
  inspectLibEncoding,
  formatLibWarning
};
