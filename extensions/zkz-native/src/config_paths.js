'use strict';

const fs = require('fs');
const { configPathsFile, slashRel } = require('./paths');
const settings = require('../../shared/zkz_settings');

const DEFAULT_PATHS = {
  paths: settings.DEFAULTS.native.paths.slice()
};

const ALWAYS_FORBID = [
  '.zkz/config_paths.json',
  '.zkz/settings.json',
  '.zkz/run/.workspace_source_encodings.json'
];

function uniqRels(lists) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < lists.length; i++) {
    const arr = lists[i] || [];
    for (let j = 0; j < arr.length; j++) {
      const rel = slashRel(arr[j]);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

function isZkzInternal(rel) {
  const p = slashRel(rel);
  return p === '.zkz' || p.indexOf('.zkz/') === 0;
}

function listsFromRaw(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return uniqRels([raw]);
  if (Array.isArray(raw.paths) && raw.paths.length) return uniqRels([raw.paths]);
  return uniqRels([raw.skipWorktree, raw.overlay, raw.forbidStage]);
}

function readOldFile(repoRoot) {
  const file = configPathsFile(repoRoot);
  try {
    if (!fs.existsSync(file)) return [];
    return listsFromRaw(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return [];
  }
}

function settingsPaths(repoRoot) {
  const native = settings.load(repoRoot).native;
  if (!native || !Array.isArray(native.paths)) return [];
  return listsFromRaw(native.paths);
}

function loadConfigPaths(repoRoot) {
  let paths = settingsPaths(repoRoot);
  const old = readOldFile(repoRoot);
  if (old.length) {
    paths = uniqRels([paths, old]);
    try {
      settings.set(repoRoot, 'native', 'paths', paths);
      fs.unlinkSync(configPathsFile(repoRoot));
    } catch (_) { /* 下次再迁 */ }
  }
  if (!paths.length) paths = DEFAULT_PATHS.paths.slice();
  const local = paths.filter((rel) => !isZkzInternal(rel));
  return {
    paths: paths,
    skipWorktree: local,
    overlay: local,
    forbidStage: ALWAYS_FORBID.slice()
  };
}

function saveConfigPaths(repoRoot, obj) {
  const paths = listsFromRaw(obj);
  settings.set(repoRoot, 'native', 'paths', paths.length ? paths : DEFAULT_PATHS.paths.slice());
  try {
    const old = configPathsFile(repoRoot);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  } catch (_) { /* ignore */ }
}

function matchesPrefix(rel, prefixes) {
  const p = slashRel(rel);
  for (const raw of prefixes) {
    const pre = slashRel(raw);
    if (p === pre || p.indexOf(pre.replace(/\/?$/, '/')) === 0) return true;
  }
  return false;
}

function isForbiddenStage(repoRoot, rel, cfg) {
  const c = cfg || loadConfigPaths(repoRoot);
  return matchesPrefix(rel, c.forbidStage);
}

module.exports = {
  DEFAULT_PATHS,
  loadConfigPaths,
  saveConfigPaths,
  isForbiddenStage,
  matchesPrefix
};
