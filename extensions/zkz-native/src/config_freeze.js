'use strict';

const fs = require('fs');
const {
  configPathsFile, ensureZkz, slashRel, skipWorktreeStampPath, atomicWriteJson
} = require('./paths');
const { git, gitText } = require('./git_exec');

const DEFAULT_PATHS = {
  paths: [
    '.cursor/rules',
    '.cursor/skills',
    '.codex/skills',
    '.vscode/settings.json'
  ]
};

const ALWAYS_FORBID = [
  '.zkz/config_paths.json',
  '.zkz/.workspace_source_encodings.json'
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

function loadConfigPaths(repoRoot) {
  const p = configPathsFile(repoRoot);
  let raw = null;
  try {
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    raw = null;
  }
  let paths;
  if (raw && Array.isArray(raw.paths) && raw.paths.length) {
    paths = uniqRels([raw.paths]);
  } else if (raw) {
    paths = uniqRels([raw.skipWorktree, raw.overlay, raw.forbidStage]);
  }
  if (!paths || !paths.length) paths = DEFAULT_PATHS.paths.slice();
  const local = paths.filter((rel) => !isZkzInternal(rel));
  return {
    paths: paths,
    skipWorktree: local,
    overlay: local,
    forbidStage: ALWAYS_FORBID.slice()
  };
}

function saveConfigPaths(repoRoot, obj) {
  ensureZkz(repoRoot);
  atomicWriteJson(configPathsFile(repoRoot), obj);
}

function trackedUnder(repoRoot, prefixes) {
  if (!prefixes || !prefixes.length) return [];
  const args = ['ls-files', '-z', '--'];
  args.push.apply(args, prefixes);
  const out = gitText(repoRoot, args, { allowFail: true });
  if (!out) return [];
  return out.split('\0').filter(Boolean).map(slashRel);
}

function skipWorktreeTargets(cfg) {
  return (cfg && cfg.skipWorktree) ? cfg.skipWorktree.slice() : [];
}

function applySkipWorktree(repoRoot) {
  const cfg = loadConfigPaths(repoRoot);
  if (!fs.existsSync(configPathsFile(repoRoot))) saveConfigPaths(repoRoot, { paths: cfg.paths });
  const files = clearSkipWorktree(repoRoot);
  return { files: files, failed: [], skipped: false };
}

function clearSkipWorktree(repoRoot) {
  const cfg = loadConfigPaths(repoRoot);
  const files = trackedUnder(repoRoot, skipWorktreeTargets(cfg));
  const chunk = 80;
  for (let i = 0; i < files.length; i += chunk) {
    git(repoRoot, ['update-index', '--no-skip-worktree', '--'].concat(files.slice(i, i + chunk)), { allowFail: true });
  }
  try { fs.unlinkSync(skipWorktreeStampPath(repoRoot)); } catch (_) { /* ignore */ }
  return files;
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
  applySkipWorktree,
  clearSkipWorktree,
  isForbiddenStage,
  matchesPrefix
};
