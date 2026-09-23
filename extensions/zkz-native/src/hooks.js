'use strict';

const fs = require('fs');
const path = require('path');
const { BEGIN, END, replaceMarkedBlock, stripMarkedBlock, markedBody, nodeBin, scriptPath } = require('./git_config');
const { appendLog } = require('./paths');

const HOOKS = ['pre-commit', 'pre-push'];
const LEGACY_REFRESH_HOOKS = ['post-checkout', 'post-merge', 'post-rewrite'];

function hookFile(repoRoot, name) {
  return path.join(repoRoot, '.git', 'hooks', name);
}

function nativeSnippet(extensionRoot, event) {
  const runner = scriptPath(extensionRoot, 'hook_runner.js');
  const extra = 'exec ' + quoteSh(nodeBin()) + ' ' + quoteSh(runner) + ' ' + event + ' "$@"';
  return [
    '# zkz-native ' + event,
    extra
  ].join('\n');
}

function quoteSh(p) {
  return '"' + String(p).replace(/"/g, '\\"') + '"';
}

function ensureShebang(text) {
  const s = String(text || '');
  if (/^#!/.test(s)) return s;
  return '#!/bin/sh\n' + s;
}

function installOne(repoRoot, extensionRoot, name) {
  const file = hookFile(repoRoot, name);
  let cur = '';
  if (fs.existsSync(file)) cur = fs.readFileSync(file, 'utf8');
  const next = ensureShebang(replaceMarkedBlock(cur.replace(/\r\n/g, '\n'), nativeSnippet(extensionRoot, name)));
  fs.writeFileSync(file, next.replace(/\n/g, '\n'), 'utf8');
  try { fs.chmodSync(file, 0o755); } catch (_) { /* windows */ }
}

function uninstallOne(repoRoot, name) {
  const file = hookFile(repoRoot, name);
  if (!fs.existsSync(file)) return;
  const cur = fs.readFileSync(file, 'utf8');
  const next = stripMarkedBlock(cur);
  if (!next.trim() || next.trim() === '#!/bin/sh') {
    fs.unlinkSync(file);
    return;
  }
  fs.writeFileSync(file, next, 'utf8');
}

function installHooks(repoRoot, extensionRoot) {
  for (const name of HOOKS) installOne(repoRoot, extensionRoot, name);
  for (const name of LEGACY_REFRESH_HOOKS) uninstallOne(repoRoot, name);
  maybeFixPostCheckout(repoRoot);
  appendLog(repoRoot, 'hooks installed');
}

function uninstallHooks(repoRoot) {
  for (const name of HOOKS) uninstallOne(repoRoot, name);
  for (const name of LEGACY_REFRESH_HOOKS) uninstallOne(repoRoot, name);
}

function hooksPresent(repoRoot) {
  const file = hookFile(repoRoot, 'pre-commit');
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').indexOf(BEGIN) >= 0;
}

function hooksMatch(repoRoot, extensionRoot) {
  for (const name of HOOKS) {
    const file = hookFile(repoRoot, name);
    if (!fs.existsSync(file)) return false;
    const text = fs.readFileSync(file, 'utf8');
    const have = markedBody(text).replace(/\s+$/, '');
    const want = nativeSnippet(extensionRoot, name).replace(/\s+$/, '');
    if (have !== want) return false;
  }
  return true;
}

function leftoverRefreshHooks(repoRoot) {
  for (const name of LEGACY_REFRESH_HOOKS) {
    const file = hookFile(repoRoot, name);
    if (!fs.existsSync(file)) continue;
    try {
      if (fs.readFileSync(file, 'utf8').indexOf(BEGIN) >= 0) return true;
    } catch (_) { /* ignore */ }
  }
  return false;
}

function verifyHooks(repoRoot, extensionRoot) {
  if (hooksMatch(repoRoot, extensionRoot) && !leftoverRefreshHooks(repoRoot)) {
    return { repaired: false };
  }
  installHooks(repoRoot, extensionRoot);
  return { repaired: true };
}

function scriptsDiscoverBlock() {
  return [
    'ZKZ_SCRIPTS="${ZKZ_SCRIPTS:-}"',
    'if [ -z "$ZKZ_SCRIPTS" ]; then',
    '  _zkz_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)',
    '  if [ -d "$_zkz_root/scripts" ]; then ZKZ_SCRIPTS="$_zkz_root/scripts"; fi',
    '  unset _zkz_root',
    'fi',
    'if [ -z "$ZKZ_SCRIPTS" ] && [ -n "$HOME" ] && [ -d "$HOME/Desktop/zkz/scripts" ]; then',
    '  ZKZ_SCRIPTS="$HOME/Desktop/zkz/scripts"',
    'fi'
  ].join('\n');
}

function maybeFixPostCheckout(repoRoot) {
  const file = hookFile(repoRoot, 'post-checkout');
  if (!fs.existsSync(file)) return;
  let text = fs.readFileSync(file, 'utf8');
  const orig = text;
  if (text.indexOf('CMSIS_INCLUDE_COMMIT=') >= 0 && text.indexOf('zkz-native-cmsis-guard') < 0) {
    const guard = [
      '# zkz-native-cmsis-guard: skip checkout if commit object is gone',
      'if git cat-file -e "$CMSIS_INCLUDE_COMMIT^{commit}" 2>/dev/null; then',
      '  git checkout "$CMSIS_INCLUDE_COMMIT" -- "$CMSIS_INCLUDE_PATH" || true',
      '  git reset HEAD -- "$CMSIS_INCLUDE_PATH" || true',
      'else',
      '  echo "zkz-native: CMSIS commit $CMSIS_INCLUDE_COMMIT missing, skip restore" >&2',
      'fi'
    ].join('\n');
    text = text.replace(
      /git checkout "\$CMSIS_INCLUDE_COMMIT" -- "\$CMSIS_INCLUDE_PATH" \|\| true\s*\n\s*git reset HEAD -- "\$CMSIS_INCLUDE_PATH" \|\| true/,
      guard
    );
  }
  if (/C:\/Users\/Administrator\/Desktop\/zkz\/scripts/.test(text)) {
    text = text.replace(
      /ZKZ_SCRIPTS="\$\{ZKZ_SCRIPTS:-\$HOME\/Desktop\/zkz\/scripts\}"\n# fallback below if HOME unset\n: "\$\{ZKZ_SCRIPTS:=C:\/Users\/Administrator\/Desktop\/zkz\/scripts\}"/,
      scriptsDiscoverBlock()
    );
    text = text.replace(
      /ZKZ_SCRIPTS="C:\/Users\/Administrator\/Desktop\/zkz\/scripts"/,
      scriptsDiscoverBlock()
    );
    text = text.replace(/C:\/Users\/Administrator\/Desktop\/zkz\/scripts/g, '${ZKZ_SCRIPTS}');
  }
  if (text !== orig) fs.writeFileSync(file, text, 'utf8');
}

module.exports = {
  HOOKS,
  LEGACY_REFRESH_HOOKS,
  installHooks,
  uninstallHooks,
  hooksPresent,
  verifyHooks,
  hooksMatch,
  hookFile
};
