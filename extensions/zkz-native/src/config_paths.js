'use strict';

const { slashRel } = require('./paths');
const loadShared = require('./load_shared');
const settings = loadShared('zkz_settings');

const DEFAULT_PATHS = {
  paths: settings.DEFAULTS.native.paths.slice()
};

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

function settingsPaths(repoRoot) {
  const native = settings.load(repoRoot).native;
  if (!native || !Array.isArray(native.paths)) return [];
  return listsFromRaw(native.paths);
}

/** 读 settings.json 的 native.paths。空名单用内置默认。返回 skip-worktree 用的路径。扩展宿主或过滤进程调用。 */
function loadConfigPaths(repoRoot) {
  let paths = settingsPaths(repoRoot);
  if (!paths.length) paths = DEFAULT_PATHS.paths.slice();
  const local = paths.filter((rel) => !isZkzInternal(rel));
  return {
    paths: paths,
    skipWorktree: local,
    overlay: local
  };
}

function matchesPrefix(rel, prefixes) {
  const p = slashRel(rel);
  for (const raw of prefixes) {
    const pre = slashRel(raw);
    if (p === pre || p.indexOf(pre.replace(/\/?$/, '/')) === 0) return true;
  }
  return false;
}

/** 把本地配置名单写回 settings.json 的 native.paths。空名单写成内置默认。扩展宿主调用。 */
function saveConfigPaths(repoRoot, obj) {
  const paths = listsFromRaw(obj);
  settings.set(repoRoot, 'native', 'paths', paths.length ? paths : DEFAULT_PATHS.paths.slice());
}

module.exports = {
  DEFAULT_PATHS,
  loadConfigPaths,
  saveConfigPaths,
  matchesPrefix
};
