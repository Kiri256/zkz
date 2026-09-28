'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zkzDir, sleepSync } = require('./paths');

const chains = Object.create(null);
const LOCK_TTL_MS = 60 * 1000;
const LOCK_WAIT_MS = 10 * 1000;
const LOCK_POLL_MS = 50;

function lockDirFor(key) {
  const root = path.resolve(String(key || 'default'));
  const h = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16);
  return path.join(zkzDir(root), 'locks', h + '.lock');
}

function ownerFile(lockDir) {
  return path.join(lockDir, 'owner.json');
}

function isAlive(pid) {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function readOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(lockDir), 'utf8'));
  } catch (_) {
    return null;
  }
}

function isStale(lockDir) {
  if (!fs.existsSync(lockDir)) return true;
  const rec = readOwner(lockDir);
  if (!rec) {
    try {
      return Date.now() - fs.statSync(lockDir).mtimeMs > 2000;
    } catch (_) {
      return true;
    }
  }
  if (rec.pid && isAlive(rec.pid)) {
    const at = Number(rec.at) || 0;
    return !!(at && Date.now() - at > LOCK_TTL_MS);
  }
  return true;
}

function steal(lockDir) {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) {
    try { fs.rmdirSync(lockDir); } catch (_2) { /* ignore */ }
  }
}

function tryAcquire(lockDir) {
  try {
    fs.mkdirSync(lockDir);
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeFileSync(ownerFile(lockDir), JSON.stringify({
      pid: process.pid,
      at: Date.now()
    }));
    return true;
  } catch (_) {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_2) { /* ignore */ }
    return false;
  }
}

function acquireLock(key) {
  const lockDir = lockDirFor(key);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const start = Date.now();
  while (Date.now() - start < LOCK_WAIT_MS) {
    if (tryAcquire(lockDir)) return lockDir;
    if (isStale(lockDir)) steal(lockDir);
    else sleepSync(LOCK_POLL_MS);
  }
  if (isStale(lockDir)) {
    steal(lockDir);
    if (tryAcquire(lockDir)) return lockDir;
  }
  throw new Error('zkz-native lock timeout');
}

function releaseLock(lockDir) {
  if (!lockDir) return;
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) {
    try { fs.rmdirSync(lockDir); } catch (_2) { /* ignore */ }
  }
}

function withLock(key, fn) {
  const k = String(key || 'default');
  const prev = chains[k] || Promise.resolve();
  const run = prev.then(() => hold(k, fn), () => hold(k, fn));
  chains[k] = run.then(() => undefined, () => undefined);
  return run;
}

async function hold(key, fn) {
  const lockDir = acquireLock(key);
  try {
    return await fn();
  } finally {
    releaseLock(lockDir);
  }
}

module.exports = {
  withLock,
  lockDirFor,
  LOCK_TTL_MS,
  LOCK_WAIT_MS
};
