'use strict';

const fs = require('fs');
const path = require('path');
const { BEGIN, END, replaceMarkedBlock, stripMarkedBlock, nodeBin, scriptPath } = require('./git_config');

const HOOKS = ['post-checkout', 'post-merge', 'post-rewrite', 'pre-commit'];

function hookFile(repoRoot, name) {
  return path.join(repoRoot, '.git', 'hooks', name);
}

function nativeSnippet(extensionRoot, event) {
  const runner = scriptPath(extensionRoot, 'hook_runner.js');
  const extra = event === 'pre-commit'
    ? 'exec ' + quoteSh(nodeBin()) + ' ' + quoteSh(runner) + ' ' + event + ' "$@"'
    : quoteSh(nodeBin()) + ' ' + quoteSh(runner) + ' ' + event + ' "$@" || true';
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
  maybeFixPostCheckout(repoRoot);
}

function uninstallHooks(repoRoot) {
  for (const name of HOOKS) uninstallOne(repoRoot, name);
}

function hooksPresent(repoRoot) {
  const file = hookFile(repoRoot, 'pre-commit');
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').indexOf(BEGIN) >= 0;
}

function maybeFixPostCheckout(repoRoot) {
  const file = hookFile(repoRoot, 'post-checkout');
  if (!fs.existsSync(file)) return;
  let text = fs.readFileSync(file, 'utf8');
  if (text.indexOf('CMSIS_INCLUDE_COMMIT=') < 0) return;
  if (text.indexOf('zkz-native-cmsis-guard') >= 0) return;
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
  if (!/ZKZ_SCRIPTS="\$\{ZKZ_SCRIPTS-/.test(text)) {
    text = text.replace(
      /ZKZ_SCRIPTS="C:\/Users\/Administrator\/Desktop\/zkz\/scripts"/,
      'ZKZ_SCRIPTS="${ZKZ_SCRIPTS:-$HOME/Desktop/zkz/scripts}"\n# fallback below if HOME unset\n: "${ZKZ_SCRIPTS:=C:/Users/Administrator/Desktop/zkz/scripts}"'
    );
  }
  fs.writeFileSync(file, text, 'utf8');
}

module.exports = {
  HOOKS,
  installHooks,
  uninstallHooks,
  hooksPresent,
  hookFile
};
