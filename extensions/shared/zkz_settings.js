'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  native: {
    enabled: true,
    glob: '*.c,*.h',
    paths: [
      '.cursor/rules',
      '.cursor/skills',
      '.codex/skills',
      '.vscode/settings.json'
    ]
  },
  keil: {
    uv4Path: '',
    gdbPath: '',
    flavor: 'f429',
    speedKHz: 6000,
    debugSpeedKHz: 4000,
    patchGlobalJLinkDevices: true,
    h750: {
      jlinkPath: '',
      flmPath: '',
      device: 'STM32H750IB',
      svdFile: '',
      target: 'H750_N',
      qspiBase: '0x90000000',
      qspiSize: '0x00400000'
    },
    f429: {
      jlinkPath: '',
      device: 'STM32F429BI',
      svdFile: '',
      target: 'Flash'
    }
  },
  code: {
    ifdefFold: {
      enabled: true,
      minLines: 2
    }
  }
};

function settingsFile(root) {
  return path.join(root, '.zkz', 'settings.json');
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function load(root) {
  if (!root) return {};
  const file = settingsFile(root);
  try {
    if (!fs.existsSync(file)) return {};
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    return {};
  }
}

function write(root, obj) {
  const file = settingsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(obj, null, 2) + '\n';
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) { /* replace via rename */ }
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
  }
}

function mergeMissing(dst, src) {
  let changed = false;
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) {
        dst[k] = {};
        changed = true;
      }
      if (mergeMissing(dst[k], sv)) changed = true;
    } else if (!Object.prototype.hasOwnProperty.call(dst, k)) {
      dst[k] = sv;
      changed = true;
    }
  }
  return changed;
}

function ensure(root) {
  if (!root) return null;
  const cur = load(root);
  const next = clone(cur);
  const changed = mergeMissing(next, DEFAULTS) || !fs.existsSync(settingsFile(root));
  if (changed) write(root, next);
  return next;
}

function dig(obj, key) {
  if (!obj || !key) return undefined;
  const parts = String(key).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function put(obj, key, value) {
  const parts = String(key).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function missing(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function get(root, section, key, fallback) {
  const sec = load(root)[section];
  const v = dig(sec, key);
  return missing(v) ? fallback : v;
}

function getNumber(root, section, key, fallback) {
  const v = get(root, section, key, fallback);
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function set(root, section, key, value) {
  if (!root) throw new Error('no repo root');
  const obj = ensure(root) || {};
  if (!obj[section] || typeof obj[section] !== 'object' || Array.isArray(obj[section])) obj[section] = {};
  put(obj[section], key, value);
  write(root, obj);
  return value;
}

module.exports = {
  DEFAULTS,
  settingsFile,
  load,
  ensure,
  get,
  getNumber,
  set
};
