'use strict';

const fs = require('fs');
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
  return Object.keys(files).sort().map((rel) => ({
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
  loadFilterFail,
  recordFilterFail,
  resetFilterFail,
  markFilterFailNotified,
  recordHandshakeReject
};
