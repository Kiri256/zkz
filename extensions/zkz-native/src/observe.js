'use strict';

const fs = require('fs');
const path = require('path');
const {
  ensureZkz, slashRel, formatLocalNow, atomicWriteJson,
  roundtripFailPath, filterFailPath, handshakeRejectPath, appendLog
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
    const p = roundtripFailPath(repoRoot);
    const obj = readJson(p, { files: {} });
    if (!obj.files || typeof obj.files !== 'object') obj.files = {};
    const rel = slashRel(pathname);
    obj.at = formatLocalNow();
    obj.files[rel] = {
      message: String(err && err.message ? err.message : err),
      at: obj.at
    };
    atomicWriteJson(p, obj);
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
    return { rel: rel, count: count, stages: stages, message: messages.join('; '), at: at };
  }).filter((item) => item.count > 0);
}

function recordCp936Drop(repoRoot, pathname, info) {
  if (!repoRoot || !info || !info.count) return;
  try {
    ensureZkz(repoRoot);
    const p = roundtripFailPath(repoRoot);
    const obj = readJson(p, { files: {} });
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
    atomicWriteJson(p, obj);
    appendLog(repoRoot, 'cp936 drop ' + rel + ' ' + (info.message || ''));
  } catch (_) { /* ignore */ }
}

function clearCp936Drop(repoRoot, pathname, stage) {
  if (!repoRoot) return;
  try {
    const p = roundtripFailPath(repoRoot);
    const obj = readJson(p, null);
    if (!obj || !obj.drops) return;
    const rel = slashRel(pathname);
    const rec = obj.drops[rel];
    if (!rec || typeof rec !== 'object') return;
    if (stage === 'smudge' || stage === 'clean') delete rec[stage];
    else delete obj.drops[rel];
    if (obj.drops[rel] && !obj.drops[rel].clean && !obj.drops[rel].smudge) delete obj.drops[rel];
    obj.at = formatLocalNow();
    atomicWriteJson(p, obj);
  } catch (_) { /* ignore */ }
}

function clearRoundtripFailure(repoRoot, pathname) {
  if (!repoRoot) return;
  try {
    const p = roundtripFailPath(repoRoot);
    const obj = readJson(p, null);
    if (!obj || !obj.files) return;
    const rel = slashRel(pathname);
    if (!Object.prototype.hasOwnProperty.call(obj.files, rel)) return;
    delete obj.files[rel];
    obj.at = formatLocalNow();
    atomicWriteJson(p, obj);
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
  recordHandshakeReject
};
