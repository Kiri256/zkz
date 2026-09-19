'use strict';

const fs = require('fs');
const {
  configPathsFile, ensureZkz, slashRel, skipWorktreeStampPath, formatLocalNow
} = require('./paths');
const { git, gitText } = require('./git_exec');

const DEFAULT_PATHS = {
  skipWorktree: [
    '.cursor/rules',
    '.cursor/skills',
    '.codex/skills'
  ],
  forbidStage: [
    '.cursor/rules',
    '.cursor/skills',
    '.codex/skills',
    '.zkz/config_paths.json',
    '.zkz/.workspace_source_encodings.json'
  ]
};

function loadConfigPaths(repoRoot) {
  const p = configPathsFile(repoRoot);
  if (!fs.existsSync(p)) return JSON.parse(JSON.stringify(DEFAULT_PATHS));
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      skipWorktree: Array.isArray(obj.skipWorktree) ? obj.skipWorktree : DEFAULT_PATHS.skipWorktree.slice(),
      forbidStage: Array.isArray(obj.forbidStage) ? obj.forbidStage : DEFAULT_PATHS.forbidStage.slice()
    };
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_PATHS));
  }
}

function saveConfigPaths(repoRoot, obj) {
  ensureZkz(repoRoot);
  fs.writeFileSync(configPathsFile(repoRoot), JSON.stringify(obj, null, 2), 'utf8');
}

function trackedUnder(repoRoot, prefixes) {
  if (!prefixes || !prefixes.length) return [];
  const args = ['ls-files', '-z', '--'];
  args.push.apply(args, prefixes);
  const out = gitText(repoRoot, args, { allowFail: true });
  if (!out) return [];
  return out.split('\0').filter(Boolean).map(slashRel);
}

function readSkipStamp(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(skipWorktreeStampPath(repoRoot), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeSkipStamp(repoRoot, key, count) {
  ensureZkz(repoRoot);
  fs.writeFileSync(skipWorktreeStampPath(repoRoot), JSON.stringify({
    key: key,
    count: count,
    at: formatLocalNow()
  }, null, 2), 'utf8');
}

function applySkipWorktree(repoRoot, opts) {
  const force = !!(opts && opts.force);
  const cfg = loadConfigPaths(repoRoot);
  if (!fs.existsSync(configPathsFile(repoRoot))) saveConfigPaths(repoRoot, cfg);
  const key = (cfg.skipWorktree || []).map(slashRel).join('|');
  const stamp = readSkipStamp(repoRoot);
  if (!force && stamp && stamp.key === key && typeof stamp.count === 'number') {
    return { files: [], failed: [], skipped: true };
  }

  const files = trackedUnder(repoRoot, cfg.skipWorktree);
  const need = [];
  if (files.length) {
    const r = git(repoRoot, ['ls-files', '-v', '-z', '--'].concat(files), { allowFail: true });
    const marked = new Set();
    const parts = String(r.stdout || '').split('\0').filter(Boolean);
    for (const rec of parts) {
      const flag = rec.charAt(0);
      const rel = slashRel(rec.slice(1).replace(/^\s+/, ''));
      if (/^[Ss]/.test(flag)) marked.add(rel);
    }
    for (const rel of files) {
      if (!marked.has(rel)) need.push(rel);
    }
    const chunk = 80;
    for (let i = 0; i < need.length; i += chunk) {
      git(repoRoot, ['update-index', '--skip-worktree', '--'].concat(need.slice(i, i + chunk)), { allowFail: true });
    }
  }
  writeSkipStamp(repoRoot, key, files.length);
  return { files: files, failed: [], skipped: false };
}

function clearSkipWorktree(repoRoot) {
  const cfg = loadConfigPaths(repoRoot);
  const files = trackedUnder(repoRoot, cfg.skipWorktree);
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

function defaultConfigPaths() {
  return JSON.parse(JSON.stringify(DEFAULT_PATHS));
}

module.exports = {
  DEFAULT_PATHS,
  loadConfigPaths,
  saveConfigPaths,
  applySkipWorktree,
  clearSkipWorktree,
  isForbiddenStage,
  matchesPrefix,
  defaultConfigPaths
};
