'use strict';

const fs = require('fs');
const path = require('path');
const {
  ensureZkz, slashRel, formatLocalNow, atomicWriteJson,
  roundtripFailPath, filterFailPath, handshakeRejectPath, commitRejectPath, appendLog
} = require('./paths');

const FILTER_FAIL_LIMIT = 3;
const FILTER_FAIL_STALE_MS = 5 * 60 * 1000;

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

// 同一次过滤里只读一次。切回含大量 GBK 的分支时，不再每个文件打开这份记录。
let roundtripCache = { path: '', ready: false, obj: null };

function cachedRoundtrip(repoRoot) {
  const p = roundtripFailPath(repoRoot);
  if (roundtripCache.ready && roundtripCache.path === p) return roundtripCache.obj;
  const obj = readJson(p, null);
  roundtripCache = { path: p, ready: true, obj: obj };
  return obj;
}

function writeRoundtrip(repoRoot, obj) {
  const p = roundtripFailPath(repoRoot);
  atomicWriteJson(p, obj);
  roundtripCache = { path: p, ready: true, obj: obj };
}

function loadRoundtripFailures(repoRoot) {
  const obj = readJson(roundtripFailPath(repoRoot), { files: {} });
  const files = (obj && obj.files && typeof obj.files === 'object') ? obj.files : {};
  return Object.keys(files).filter((rel) => {
    try { return fs.statSync(path.join(repoRoot, rel)).isFile(); } catch (err) {
      // A removed or renamed source no longer contributes an active warning.
      return err.code !== 'ENOENT' && err.code !== 'ENOTDIR';
    }
  }).sort().map((rel) => ({
    rel: rel,
    message: files[rel] && files[rel].message ? String(files[rel].message) : '',
    at: files[rel] && files[rel].at ? String(files[rel].at) : ''
  }));
}

function recordRoundtripFailure(repoRoot, pathname, err) {
  if (!repoRoot) return;
  try {
    ensureZkz(repoRoot);
    let obj = cachedRoundtrip(repoRoot);
    if (!obj || typeof obj !== 'object') obj = { files: {} };
    if (!obj.files || typeof obj.files !== 'object') obj.files = {};
    const rel = slashRel(pathname);
    obj.at = formatLocalNow();
    obj.files[rel] = {
      message: String(err && err.message ? err.message : err),
      at: obj.at
    };
    writeRoundtrip(repoRoot, obj);
    appendLog(repoRoot, 'roundtrip soft-fail ' + rel);
  } catch (_) { /* ignore */ }
}

function loadCp936Drops(repoRoot) {
  const obj = readJson(roundtripFailPath(repoRoot), { files: {} });
  const files = (obj && obj.drops && typeof obj.drops === 'object') ? obj.drops : {};
  return Object.keys(files).filter((rel) => {
    try { return fs.statSync(path.join(repoRoot, rel)).isFile(); } catch (err) {
      return err.code !== 'ENOENT' && err.code !== 'ENOTDIR';
    }
  }).sort().map((rel) => {
    const rec = files[rel] || {};
    const stages = [];
    let count = 0;
    let at = '';
    const messages = [];
    ['clean', 'smudge'].forEach((stage) => {
      const item = rec[stage];
      if (!item || !item.count) return;
      stages.push(stage);
      count += item.count;
      if (item.message) messages.push(String(item.message));
      if (item.at && String(item.at) > at) at = String(item.at);
    });
    const positions = [];
    ['clean', 'smudge'].forEach((stage) => {
      const item = rec[stage];
      if (!item || !Array.isArray(item.positions)) return;
      item.positions.forEach((n) => {
        if (positions.length < 8 && Number.isFinite(n)) positions.push(n);
      });
    });
    return { rel: rel, count: count, stages: stages, message: messages.join('; '), at: at, positions: positions };
  }).filter((item) => item.count > 0);
}

function recordCp936Drop(repoRoot, pathname, info) {
  if (!repoRoot || !info || !info.count) return;
  try {
    ensureZkz(repoRoot);
    let obj = cachedRoundtrip(repoRoot);
    if (!obj || typeof obj !== 'object') obj = { files: {} };
    if (!obj.drops || typeof obj.drops !== 'object') obj.drops = {};
    const rel = slashRel(pathname);
    const stage = info.stage === 'smudge' ? 'smudge' : 'clean';
    const at = formatLocalNow();
    if (!obj.drops[rel] || typeof obj.drops[rel] !== 'object') obj.drops[rel] = {};
    obj.at = at;
    obj.drops[rel][stage] = {
      count: info.count,
      positions: Array.isArray(info.positions) ? info.positions.slice(0, 8) : [],
      message: String(info.message || ''),
      at: at
    };
    writeRoundtrip(repoRoot, obj);
    appendLog(repoRoot, 'cp936 drop ' + rel + ' ' + (info.message || ''));
  } catch (_) { /* ignore */ }
}

function clearCp936Drop(repoRoot, pathname, stage) {
  if (!repoRoot) return;
  try {
    const obj = cachedRoundtrip(repoRoot);
    if (!obj || !obj.drops) return;
    const rel = slashRel(pathname);
    const rec = obj.drops[rel];
    if (!rec || typeof rec !== 'object') return;
    if (stage === 'smudge' || stage === 'clean') delete rec[stage];
    else delete obj.drops[rel];
    if (obj.drops[rel] && !obj.drops[rel].clean && !obj.drops[rel].smudge) delete obj.drops[rel];
    obj.at = formatLocalNow();
    writeRoundtrip(repoRoot, obj);
  } catch (_) { /* ignore */ }
}

function clearRoundtripFailure(repoRoot, pathname) {
  if (!repoRoot) return;
  try {
    const obj = cachedRoundtrip(repoRoot);
    if (!obj || !obj.files) return;
    const rel = slashRel(pathname);
    if (!Object.prototype.hasOwnProperty.call(obj.files, rel)) return;
    delete obj.files[rel];
    obj.at = formatLocalNow();
    writeRoundtrip(repoRoot, obj);
  } catch (_) { /* ignore */ }
}

function parseStampMs(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

function loadFilterFail(repoRoot) {
  const obj = readJson(filterFailPath(repoRoot), { count: 0 });
  const count = obj && typeof obj.count === 'number' ? obj.count : 0;
  const at = obj && obj.at ? String(obj.at) : '';
  const last = obj && obj.last ? String(obj.last) : '';
  const notified = !!(obj && obj.notified);
  const age = parseStampMs(at);
  if (count && age && Date.now() - age > FILTER_FAIL_STALE_MS) {
    return { count: 0, at: at, last: last, notified: false };
  }
  return { count: count, at: at, last: last, notified: notified };
}

function pickGitEnv() {
  const out = { cwd: process.cwd(), execPath: process.execPath };
  const keys = Object.keys(process.env);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.indexOf('GIT_') === 0) out[k] = process.env[k];
  }
  return out;
}

function recordHandshakeReject(repoRoot, first) {
  if (!repoRoot) return;
  try {
    ensureZkz(repoRoot);
    const raw = String((first && first.raw) || '');
    const buf = Buffer.from(raw, 'utf8');
    atomicWriteJson(handshakeRejectPath(repoRoot), {
      at: formatLocalNow(),
      pid: process.pid,
      raw: raw.slice(0, 2000),
      hex: buf.toString('hex').slice(0, 4000),
      headers: (first && first.headers) || {},
      env: pickGitEnv()
    });
    appendLog(repoRoot, 'handshake reject pid=' + process.pid + ' raw=' + raw.slice(0, 80));
  } catch (_) { /* ignore */ }
}

function recordFilterFail(repoRoot, msg) {
  if (!repoRoot) return loadFilterFail('');
  try {
    ensureZkz(repoRoot);
    const prev = loadFilterFail(repoRoot);
    const rec = {
      count: prev.count + 1,
      at: formatLocalNow(),
      last: String(msg == null ? '' : msg).slice(0, 400),
      notified: prev.notified
    };
    atomicWriteJson(filterFailPath(repoRoot), rec);
    appendLog(repoRoot, 'filter fail #' + rec.count + ' ' + rec.last);
    return rec;
  } catch (_) {
    return { count: 0, at: '', last: '', notified: false };
  }
}

function resetFilterFail(repoRoot) {
  if (!repoRoot) return;
  try {
    const prev = loadFilterFail(repoRoot);
    if (!prev.count) return;
    atomicWriteJson(filterFailPath(repoRoot), {
      count: 0,
      at: formatLocalNow(),
      last: '',
      notified: false
    });
  } catch (_) { /* ignore */ }
}

function loadCommitRejects(repoRoot) {
  const obj = readJson(commitRejectPath(repoRoot), { items: [] });
  const items = Array.isArray(obj && obj.items) ? obj.items : [];
  return items.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    if (!item.rel) return true;
    try { return fs.statSync(path.join(repoRoot, item.rel)).isFile(); } catch (err) {
      return err.code !== 'ENOENT' && err.code !== 'ENOTDIR';
    }
  }).map((item) => ({
    rel: String(item.rel || ''),
    action: item.action === 'restage' || item.action === 'open' ? item.action : 'message',
    message: String(item.message || ''),
    position: Number.isFinite(item.position) ? item.position : undefined
  }));
}

function recordCommitReject(repoRoot, actions) {
  if (!repoRoot) return;
  try {
    ensureZkz(repoRoot);
    const items = (actions || []).map((item) => {
      const row = {
        rel: item && item.rel ? String(item.rel) : '',
        action: item && (item.action === 'restage' || item.action === 'open') ? item.action : 'message',
        message: item && item.message ? String(item.message) : ''
      };
      if (item && Number.isFinite(item.position)) row.position = item.position;
      return row;
    });
    atomicWriteJson(commitRejectPath(repoRoot), { at: formatLocalNow(), items: items });
  } catch (_) { /* ignore */ }
}

function clearCommitReject(repoRoot) {
  if (!repoRoot) return;
  try {
    const p = commitRejectPath(repoRoot);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) { /* ignore */ }
}

// 去掉已经处理过的项。action 省略时只去掉重新暂存。
function dismissCommitReject(repoRoot, rels, action) {
  const drop = new Set(rels || []);
  const which = action || 'restage';
  const left = loadCommitRejects(repoRoot).filter((item) => !(item.action === which && drop.has(item.rel)));
  if (!left.length) clearCommitReject(repoRoot);
  else recordCommitReject(repoRoot, left);
}

function markFilterFailNotified(repoRoot) {
  if (!repoRoot) return;
  try {
    const prev = loadFilterFail(repoRoot);
    if (!prev.count) return;
    atomicWriteJson(filterFailPath(repoRoot), {
      count: prev.count,
      at: prev.at,
      last: prev.last,
      notified: true
    });
  } catch (_) { /* ignore */ }
}

module.exports = {
  FILTER_FAIL_LIMIT,
  FILTER_FAIL_STALE_MS,
  loadRoundtripFailures,
  recordRoundtripFailure,
  clearRoundtripFailure,
  loadCp936Drops,
  recordCp936Drop,
  clearCp936Drop,
  loadFilterFail,
  recordFilterFail,
  resetFilterFail,
  markFilterFailNotified,
  recordHandshakeReject,
  loadCommitRejects,
  recordCommitReject,
  clearCommitReject,
  dismissCommitReject
};
