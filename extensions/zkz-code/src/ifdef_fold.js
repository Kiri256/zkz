'use strict';
/**
 * Fold inactive #if/#elif/#else branches using yt_version.h + .clangd -D/-U.
 * Fold only (not hide). Source .c/.cpp only; headers are skipped.
 *
 * Important: editor.fold WITHOUT levels/direction uses setCollapseStateUp and may
 * fold the parent #if (whole-file wrapper). Always pass levels:1 + direction:down.
 */
const vscode = require('vscode');
const {
  findYtVersion,
  loadMacroTable,
  invalidateMacroTable,
  evalPpExpr
} = require('./macros');

const LANGS = ['c', 'cpp', 'cuda-cpp'];
const SRC_EXT_RE = /\.(c|cpp|cc|cxx)$/i;
const HEADER_EXT_RE = /\.(h|hpp|hh|hxx)$/i;

/** Skip auto-fold when branch covers this fraction of the file (file-wrapper #if). */
const MAX_FILE_FRACTION = 0.45;

/** @type {Map<string, { inactive: number[], active: number[], stamp: string }>} */
const gLastApplied = new Map();
let gApplyTimer = null;
let gPendingRetry = 0;
const MAX_PENDING_RETRY = 4;
let gFoldingProvider = null;
/** @type {vscode.EventEmitter<void>|null} */
let gFoldingChangeEmitter = null;
/** @type {vscode.StatusBarItem | null} */
let gStatusBar = null;
let gCommandPrefix = 'zkz-code';
let gConfigNamespace = 'zkzCode';

function command(name) {
  return gCommandPrefix + '.' + name;
}

function cfgEnabled() {
  try {
    return vscode.workspace.getConfiguration(gConfigNamespace).get('ifdefFold.enabled', true) !== false;
  } catch (_) {
    return true;
  }
}

function cfgMinLines() {
  try {
    const n = Number(vscode.workspace.getConfiguration(gConfigNamespace).get('ifdefFold.minLines', 2));
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
  } catch (_) {
    return 2;
  }
}

function isCppLikeDoc(doc) {
  if (!doc || doc.uri.scheme !== 'file') return false;
  const fp = doc.uri.fsPath || '';
  if (HEADER_EXT_RE.test(fp)) return false;
  if (SRC_EXT_RE.test(fp)) return true;
  if (/\.[^.]*h[^.]*$/i.test(fp) && !SRC_EXT_RE.test(fp)) return false;
  return LANGS.includes(doc.languageId);
}

function loadMacroEnv(workspaceRoot) {
  const table = loadMacroTable({ workspaceRoot });
  return { macros: table.macros, ready: table.ready };
}

function resolveWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    if (findYtVersion(f.uri.fsPath)) return f.uri.fsPath;
  }
  return folders.length ? folders[0].uri.fsPath : '';
}

/**
 * @returns {{ startLine: number, endLine: number, active: boolean, kind: string }[]}
 */
function collectPpBranches(text, macros) {
  const env = Object.assign({}, macros || {});
  /** @type {{ active: boolean, seenTrue: boolean, dirLine: number, kind: string }[]} */
  const stack = [];
  /** @type {{ startLine: number, endLine: number, active: boolean, kind: string }[]} */
  const out = [];
  const effectiveActive = () => stack.every((f) => f.active);

  const closeArm = (endLineExclusive) => {
    if (!stack.length) return;
    const top = stack[stack.length - 1];
    const start = top.dirLine;
    const end = endLineExclusive - 1;
    if (end >= start) {
      out.push({
        startLine: start,
        endLine: end,
        active: !!top.active,
        kind: top.kind
      });
    }
  };

  const lines = String(text || '').split(/\r?\n/);
  let li = 0;
  while (li < lines.length) {
    let line = lines[li];
    const startLi = li;
    while (/\\\s*$/.test(line) && li + 1 < lines.length) {
      li += 1;
      line = line.replace(/\\\s*$/, '') + lines[li];
    }
    const trim = line.trim();
    if (!trim.startsWith('#')) {
      li += 1;
      continue;
    }
    const body = trim.replace(/^#\s*/, '');

    if (/^if\b/.test(body) && !/^ifdef\b/.test(body) && !/^ifndef\b/.test(body)) {
      const expr = body.replace(/^if\b/, '').trim();
      const parent = effectiveActive();
      const val = parent ? evalPpExpr(expr, env) : false;
      stack.push({ active: parent && val, seenTrue: parent && val, dirLine: startLi, kind: 'if' });
      li += 1;
      continue;
    }
    if (/^ifdef\b/.test(body)) {
      const name = body.replace(/^ifdef\b/, '').trim().split(/\s+/)[0];
      const parent = effectiveActive();
      const val = parent && (name in env);
      stack.push({ active: !!val, seenTrue: !!val, dirLine: startLi, kind: 'ifdef' });
      li += 1;
      continue;
    }
    if (/^ifndef\b/.test(body)) {
      const name = body.replace(/^ifndef\b/, '').trim().split(/\s+/)[0];
      const parent = effectiveActive();
      const val = parent && !(name in env);
      stack.push({ active: !!val, seenTrue: !!val, dirLine: startLi, kind: 'ifndef' });
      li += 1;
      continue;
    }
    if (/^elif\b/.test(body)) {
      closeArm(startLi);
      if (stack.length) {
        const top = stack[stack.length - 1];
        const parent = stack.slice(0, -1).every((f) => f.active);
        if (!parent || top.seenTrue) {
          top.active = false;
        } else {
          const expr = body.replace(/^elif\b/, '').trim();
          const val = evalPpExpr(expr, env);
          top.active = val;
          if (val) top.seenTrue = true;
        }
        top.dirLine = startLi;
        top.kind = 'elif';
      }
      li += 1;
      continue;
    }
    if (/^else\b/.test(body)) {
      closeArm(startLi);
      if (stack.length) {
        const top = stack[stack.length - 1];
        const parent = stack.slice(0, -1).every((f) => f.active);
        top.active = parent && !top.seenTrue;
        if (top.active) top.seenTrue = true;
        top.dirLine = startLi;
        top.kind = 'else';
      }
      li += 1;
      continue;
    }
    if (/^endif\b/.test(body)) {
      closeArm(startLi);
      if (stack.length) stack.pop();
      li += 1;
      continue;
    }
    if (effectiveActive() && /^define\s+[A-Za-z_]\w*(?:\s+|$)/.test(body) && !/^define\s+[A-Za-z_]\w*\(/.test(body)) {
      const dm = body.match(/^define\s+([A-Za-z_]\w*)(?:\s+(.*))?$/);
      if (dm) {
        let val = (dm[2] || '').trim();
        val = val.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '').trim();
        env[dm[1]] = val;
      }
    }
    if (effectiveActive() && /^undef\b/.test(body)) {
      const name = body.replace(/^undef\b/, '').trim().split(/\s+/)[0];
      if (name) delete env[name];
    }
    li += 1;
  }
  while (stack.length) {
    closeArm(lines.length);
    stack.pop();
  }
  return out;
}

function isFileWrapperBranch(b, lineCount) {
  if (!lineCount || lineCount < 1) return false;
  const span = b.endLine - b.startLine + 1;
  return span / lineCount >= MAX_FILE_FRACTION;
}

/** Only inactive, non-wrapper branches become fold targets. */
function selectFoldTargets(branches, lineCount) {
  const minLines = cfgMinLines();
  const inactive = [];
  const activeKeepOpen = [];
  for (const b of branches) {
    if (b.endLine <= b.startLine) continue;
    if ((b.endLine - b.startLine + 1) < minLines) continue;
    if (isFileWrapperBranch(b, lineCount)) {
      // Never auto-fold file-level wrappers; always try to keep them open
      activeKeepOpen.push(b.startLine);
      continue;
    }
    if (b.active) activeKeepOpen.push(b.startLine);
    else inactive.push(b.startLine);
  }
  return { inactive, activeKeepOpen };
}

function branchesToFoldingRanges(branches, lineCount) {
  const minLines = cfgMinLines();
  /** @type {vscode.FoldingRange[]} */
  const ranges = [];
  for (const b of branches) {
    if (b.active) continue; // only expose inactive as our fold ranges
    if (isFileWrapperBranch(b, lineCount)) continue;
    if (b.endLine <= b.startLine) continue;
    if ((b.endLine - b.startLine + 1) < minLines) continue;
    ranges.push(new vscode.FoldingRange(b.startLine, b.endLine, vscode.FoldingRangeKind.Region));
  }
  return ranges;
}

function provideFoldingRanges(document) {
  if (!cfgEnabled() || !isCppLikeDoc(document)) return [];
  const root = resolveWorkspaceRoot();
  if (!root) return [];
  try {
    const { macros, ready } = loadMacroEnv(root);
    if (!ready) return [];
    const text = document.getText();
    const lineCount = document.lineCount || text.split(/\r?\n/).length;
    const branches = collectPpBranches(text, macros);
    return branchesToFoldingRanges(branches, lineCount);
  } catch (_) {
    return [];
  }
}

function fireFoldingChanged() {
  try {
    if (gFoldingChangeEmitter) gFoldingChangeEmitter.fire();
  } catch (_) { /* ignore */ }
}

async function foldLines(lines) {
  if (!lines || !lines.length) return;
  // levels+direction required to avoid setCollapseStateUp folding parent #if
  await vscode.commands.executeCommand('editor.fold', {
    levels: 1,
    direction: 'down',
    selectionLines: lines
  });
}

async function unfoldLines(lines) {
  if (!lines || !lines.length) return;
  await vscode.commands.executeCommand('editor.unfold', {
    levels: 1,
    direction: 'down',
    selectionLines: lines
  });
}

async function applyFoldsToEditor(editor, reason) {
  if (!cfgEnabled() || !editor || !isCppLikeDoc(editor.document)) return false;
  const root = resolveWorkspaceRoot();
  if (!root) return false;
  const { macros, ready } = loadMacroEnv(root);
  if (!ready) return false;

  const doc = editor.document;
  const text = doc.getText();
  const lineCount = doc.lineCount || text.split(/\r?\n/).length;
  const branches = collectPpBranches(text, macros);
  const { inactive, activeKeepOpen } = selectFoldTargets(branches, lineCount);

  const key = doc.uri.toString();
  const stamp = inactive.join(',') + '|' + activeKeepOpen.join(',');
  const prev = gLastApplied.get(key);
  if (prev && prev.stamp === stamp && reason !== 'force' && reason !== 'retry') return true;

  // Ensure provider ranges refreshed before fold commands
  fireFoldingChanged();
  await new Promise((r) => setTimeout(r, reason === 'init' || reason === 'open' ? 120 : 40));

  // Keep wrappers / active arms open first
  if (activeKeepOpen.length) {
    try { await unfoldLines(activeKeepOpen); } catch (_) { /* ignore */ }
  }
  if (inactive.length) {
    try { await foldLines(inactive); } catch (_) { /* ignore */ }
  }
  gLastApplied.set(key, { inactive, active: activeKeepOpen, stamp });
  updateStatusBar(inactive.length);
  return true;
}

function updateStatusBar(count) {
  if (!gStatusBar) return;
  const on = cfgEnabled();
  if (!on) {
    gStatusBar.text = '$(fold) ifdef off';
    gStatusBar.tooltip = 'zkz ifdef fold disabled (click to refresh)';
    return;
  }
  const n = typeof count === 'number' ? count : 0;
  gStatusBar.text = '$(fold) ifdef ' + n;
  gStatusBar.tooltip = 'zkz: inactive #if folded x' + n + ' (click to refresh; macros from shared table)';
}

function scheduleApplyVisible(reason) {
  if (gApplyTimer) clearTimeout(gApplyTimer);
  const delay = reason === 'force' ? 50 : (reason === 'init' ? 400 : 250);
  gApplyTimer = setTimeout(() => {
    gApplyTimer = null;
    void (async () => {
      const eds = vscode.window.visibleTextEditors || [];
      let anyPending = false;
      for (const ed of eds) {
        try {
          const ok = await applyFoldsToEditor(ed, reason);
          if (!ok && isCppLikeDoc(ed.document)) anyPending = true;
        } catch (_) { /* ignore */ }
      }
      // 启动时宏表可能还没就绪；只按失败次数重试，不再无条件晚折两遍
      if (anyPending && (reason === 'init' || reason === 'retry' || reason === 'open')
        && gPendingRetry < MAX_PENDING_RETRY) {
        gPendingRetry += 1;
        setTimeout(() => scheduleApplyVisible('retry'), 800);
      } else if (!anyPending) {
        gPendingRetry = 0;
      }
    })();
  }, delay);
}

function invalidateEnvCache() {
  invalidateMacroTable();
  gLastApplied.clear();
  fireFoldingChanged();
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ commandPrefix?: string, configNamespace?: string }} [options]
 */
function activate(context, options) {
  options = options || {};
  gCommandPrefix = String(options.commandPrefix || 'zkz-code');
  gConfigNamespace = String(options.configNamespace || 'zkzCode');
  gFoldingChangeEmitter = new vscode.EventEmitter();
  context.subscriptions.push(gFoldingChangeEmitter);

  gStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  gStatusBar.command = command('refreshIfdefFolds');
  updateStatusBar(0);
  gStatusBar.show();
  context.subscriptions.push(gStatusBar);

  const provider = {
    onDidChange: gFoldingChangeEmitter.event,
    provideFoldingRanges(document) {
      return provideFoldingRanges(document);
    }
  };
  gFoldingProvider = vscode.languages.registerFoldingRangeProvider(
    [
      { language: 'c', pattern: '**/*.{c,C}' },
      { language: 'cpp', pattern: '**/*.{cpp,cc,cxx,CPP,CC,CXX}' },
      { language: 'cuda-cpp', pattern: '**/*.{c,cpp,cc,cxx}' }
    ],
    provider
  );
  context.subscriptions.push(gFoldingProvider);

  const wrap = (fn) => async (...args) => {
    try { await fn(...args); }
    catch (e) {
      vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(command('foldInactiveIfdef'), wrap(async () => {
      invalidateEnvCache();
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }
      const ok = await applyFoldsToEditor(ed, 'force');
      if (!ok) {
        vscode.window.showWarningMessage('zkz: yt_version macros not ready');
        return;
      }
      const st = gLastApplied.get(ed.document.uri.toString());
      const n = st && st.inactive ? st.inactive.length : 0;
      vscode.window.setStatusBarMessage('zkz: folded inactive #if x' + n, 2500);
    })),
    vscode.commands.registerCommand(command('unfoldInactiveIfdef'), wrap(async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const st = gLastApplied.get(ed.document.uri.toString());
      const lines = st && st.inactive && st.inactive.length ? st.inactive : null;
      if (lines && lines.length) await unfoldLines(lines);
      else await vscode.commands.executeCommand('editor.unfoldAll');
      gLastApplied.delete(ed.document.uri.toString());
    })),
    vscode.commands.registerCommand(command('refreshIfdefFolds'), wrap(async () => {
      invalidateEnvCache();
      scheduleApplyVisible('force');
    }))
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed) return;
      void applyFoldsToEditor(ed, 'active');
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!isCppLikeDoc(doc)) return;
      scheduleApplyVisible('open');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e || !e.affectsConfiguration(gConfigNamespace + '.ifdefFold')) return;
      invalidateEnvCache();
      updateStatusBar(0);
      scheduleApplyVisible('force');
    }),
    {
      dispose: () => {
        if (gApplyTimer) clearTimeout(gApplyTimer);
        gApplyTimer = null;
        gPendingRetry = 0;
        gLastApplied.clear();
        gStatusBar = null;
      }
    }
  );

  // 会话恢复的已打开编辑器：宏表稍后才齐，失败走 anyPending 重试
  setTimeout(() => scheduleApplyVisible('init'), 600);
}

function onMacrosChanged() {
  // 宏表已由 status 更新，这里只重折，避免清表再解析一遍
  gLastApplied.clear();
  fireFoldingChanged();
  scheduleApplyVisible('macros');
}

module.exports = {
  activate,
  onMacrosChanged,
  collectPpBranches,
  loadMacroEnv,
  applyFoldsToEditor,
  selectFoldTargets,
  MAX_FILE_FRACTION
};
