'use strict';
/**
 * Fold inactive #if/#elif/#else branches using yt_version.h + .clangd -D/-U.
 * Fold only (not hide). Source .c/.cpp only; headers are skipped.
 * Conditions that mention macros absent from the scanned table are left open.
 * 自动重折只动这次从活变死、或从死变活的行。点「刷新折叠」才把死分支重新折上。
 *
 * Important: editor.fold WITHOUT levels/direction uses setCollapseStateUp and may
 * fold the parent #if (whole-file wrapper). Always pass levels:1 + direction:down.
 */
const vscode = require('vscode');
const path = require('path');
const {
  loadMacroTable,
  invalidateMacroTable,
  resolveMacroRoot
} = require('./macros');
const { evalPpExprResult } = require('./pp_expr');

const LANGS = ['c', 'cpp', 'cuda-cpp'];
const SRC_EXT_RE = /\.(c|cpp|cc|cxx)$/i;
const HEADER_EXT_RE = /\.(h|hpp|hh|hxx)$/i;

/** @type {Map<string, { inactive: number[], stamp: string }>} */
const gLastApplied = new Map();
let gApplyTimer = null;
let gPendingRetry = 0;
/** 启动时宏表可能还没就绪，失败后最多重试这么多次。 */
const MAX_PENDING_RETRY = 4;
/** 等宏表就绪后再折一次。 */
const FOLD_PENDING_RETRY_MS = 800;
const FOLD_INIT_DELAY_MS = 600;
/** @type {vscode.EventEmitter<void>|null} */
let gFoldingChangeEmitter = null;
let gFoldCount = 0;
let gFoldListener = null;
let gCommandPrefix = 'zkz-code';
let gSettingsWatch = null;

function command(name) {
  return gCommandPrefix + '.' + name;
}

function repoRoot() {
  try { return require('./pair').resolvePair().root; } catch (_) { return ''; }
}

function cfgEnabled() {
  try {
    const root = repoRoot();
    if (!root) return true;
    return require('../../shared/zkz_settings').get(root, 'code', 'ifdefFold.enabled', true) !== false;
  } catch (_) {
    return true;
  }
}

function cfgMinLines() {
  try {
    const root = repoRoot();
    if (!root) return 2;
    const n = Number(require('../../shared/zkz_settings').get(root, 'code', 'ifdefFold.minLines', 2));
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
  return { macros: table.macros, ready: table.ready, key: table.key };
}

function isKnownMacro(name, known) {
  return !!(name && known && known.has(name));
}

/** 表达式里有宏表没有的名字时为真。字符常量里的字母不算宏名。 */
function ppExprHasUnknown(expr, known) {
  let e = String(expr || '');
  e = e.replace(/\/\*.*?\*\//g, ' ');
  e = e.replace(/\/\/.*$/, '').trim();
  e = e.replace(/'(?:\\.|[^'\\])*'/g, ' ');
  if (!e) return false;
  const re = /[A-Za-z_]\w*/g;
  let m;
  while ((m = re.exec(e)) !== null) {
    if (m[0] === 'defined') continue;
    if (!isKnownMacro(m[0], known)) return true;
  }
  return false;
}

/**
 * Ancestor frames: known-dead wins; otherwise any unknown makes the nest unknown.
 * @returns {{ live: boolean, unknown: boolean, dead: boolean }}
 */
function framesState(frames) {
  let unknown = false;
  let dead = false;
  for (const f of frames || []) {
    if (f.unknown) unknown = true;
    else if (!f.active) dead = true;
  }
  if (dead) return { live: false, unknown: false, dead: true };
  if (unknown) return { live: false, unknown: true, dead: false };
  return { live: true, unknown: false, dead: false };
}

let gRootCache = { at: 0, root: '' };
const gBranchCache = new Map();

function resolveWorkspaceRoot() {
  const now = Date.now();
  if (gRootCache.at && (now - gRootCache.at) < 2000) return gRootCache.root;
  const root = resolveMacroRoot() || '';
  gRootCache = { at: now, root: root };
  return root;
}

function cachedBranches(doc, macros, macroKey) {
  const key = doc.uri.toString() + '|' + doc.version + '|' + (macroKey || '');
  const hit = gBranchCache.get(key);
  if (hit) return hit;
  const branches = collectPpBranches(doc.getText(), macros);
  gBranchCache.set(key, branches);
  if (gBranchCache.size > 32) {
    const first = gBranchCache.keys().next().value;
    gBranchCache.delete(first);
  }
  return branches;
}

function clearFoldCache() {
  gBranchCache.clear();
  gRootCache = { at: 0, root: '' };
}

/**
 * @returns {{ startLine: number, endLine: number, active: boolean, unknown: boolean, kind: string }[]}
 */
function collectPpBranches(text, macros) {
  const env = Object.assign({}, macros || {});
  const known = new Set(Object.keys(env));
  /** @type {{ active: boolean, unknown: boolean, seenTrue: boolean, seenUnknown: boolean, dirLine: number, kind: string }[]} */
  const stack = [];
  /** @type {{ startLine: number, endLine: number, active: boolean, unknown: boolean, kind: string }[]} */
  const out = [];

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
        unknown: !!top.unknown,
        kind: top.kind
      });
    }
  };

  const pushCond = (startLi, kind, condUnknown, condVal) => {
    const p = framesState(stack);
    if (p.dead) {
      stack.push({
        active: false, unknown: false, seenTrue: false, seenUnknown: false,
        dirLine: startLi, kind
      });
      return;
    }
    if (condUnknown) {
      stack.push({
        active: false, unknown: true, seenTrue: false, seenUnknown: true,
        dirLine: startLi, kind
      });
      return;
    }
    if (p.unknown) {
      // Parent not scanned: only a known-false child is dead enough to fold.
      stack.push({
        active: false,
        unknown: !!condVal,
        seenTrue: !!condVal,
        seenUnknown: !!condVal,
        dirLine: startLi,
        kind
      });
      return;
    }
    stack.push({
      active: !!condVal,
      unknown: false,
      seenTrue: !!condVal,
      seenUnknown: false,
      dirLine: startLi,
      kind
    });
  };

  const condOf = (expr) => {
    if (ppExprHasUnknown(expr, known)) return { unknown: true, value: false };
    const r = evalPpExprResult(expr, env);
    if (!r.ok) return { unknown: true, value: false };
    return { unknown: false, value: !!r.value };
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
      const c = condOf(body.replace(/^if\b/, '').trim());
      pushCond(startLi, 'if', c.unknown, c.value);
      li += 1;
      continue;
    }
    if (/^ifdef\b/.test(body)) {
      const name = body.replace(/^ifdef\b/, '').trim().split(/\s+/)[0];
      const seen = isKnownMacro(name, known);
      pushCond(startLi, 'ifdef', !seen, seen && (name in env));
      li += 1;
      continue;
    }
    if (/^ifndef\b/.test(body)) {
      const name = body.replace(/^ifndef\b/, '').trim().split(/\s+/)[0];
      const seen = isKnownMacro(name, known);
      pushCond(startLi, 'ifndef', !seen, seen && !(name in env));
      li += 1;
      continue;
    }
    if (/^elif\b/.test(body)) {
      closeArm(startLi);
      if (stack.length) {
        const top = stack[stack.length - 1];
        const p = framesState(stack.slice(0, -1));
        const expr = body.replace(/^elif\b/, '').trim();
        const taken = top.seenTrue && !top.seenUnknown && !p.unknown;
        if (p.dead || taken) {
          top.active = false;
          top.unknown = false;
        } else {
          const c = condOf(expr);
          // 已知为假的分支到不到都不会进，可以折。已知为真但前面还有未知，则不能折。
          if (!c.unknown && !c.value) {
            top.active = false;
            top.unknown = false;
          } else if (!c.unknown && c.value && !p.unknown && !top.seenUnknown) {
            top.active = true;
            top.unknown = false;
            top.seenTrue = true;
          } else {
            top.active = false;
            top.unknown = true;
            top.seenUnknown = true;
          }
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
        const p = framesState(stack.slice(0, -1));
        if (p.dead || (top.seenTrue && !top.seenUnknown && !p.unknown)) {
          top.active = false;
          top.unknown = false;
        } else if (p.unknown || top.seenUnknown) {
          top.active = false;
          top.unknown = true;
        } else {
          top.active = true;
          top.unknown = false;
          top.seenTrue = true;
        }
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
    const st = framesState(stack);
    const def = body.match(/^define\s+([A-Za-z_]\w*)(\()?/);
    if (def && (st.live || st.unknown)) {
      const name = def[1];
      if (st.unknown) {
        // 未知分支里的定义可能生效，后面不能再沿用表里的旧值
        delete env[name];
        known.delete(name);
      } else if (!def[2]) {
        let val = body.replace(/^define\s+[A-Za-z_]\w*/, '').trim();
        val = val.replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '').trim();
        env[name] = val;
        known.add(name);
      }
    }
    if ((st.live || st.unknown) && /^undef\b/.test(body)) {
      const name = body.replace(/^undef\b/, '').trim().split(/\s+/)[0];
      if (name && st.unknown) {
        delete env[name];
        known.delete(name);
      } else if (name) {
        delete env[name];
        known.add(name);
      }
    }
    li += 1;
  }
  while (stack.length) {
    closeArm(lines.length);
    stack.pop();
  }
  return out;
}

function passesFoldSize(b, minLines) {
  return b.endLine > b.startLine && (b.endLine - b.startLine + 1) >= minLines;
}

/** 已知未激活、且够长的分支。大段死代码也折。 */
function isFoldableInactive(b, minLines) {
  if (!passesFoldSize(b, minLines)) return false;
  if (b.active || b.unknown) return false;
  return true;
}

/** 当前文件里要折的死分支起始行。 */
function selectFoldTargets(branches) {
  const minLines = cfgMinLines();
  const inactive = [];
  for (const b of branches) {
    if (isFoldableInactive(b, minLines)) inactive.push(b.startLine);
  }
  return { inactive };
}

/**
 * 自动重折只动变化的行。force 时把当前死分支全部重新折上。
 * 不再死的行展开。已经折过、用户又打开的行留着。
 * @param {number[]|null|undefined} prevInactive
 * @param {number[]} inactive
 * @param {boolean} force
 * @returns {{ reopen: number[], toFold: number[] }}
 */
function foldDelta(prevInactive, inactive, force) {
  const now = new Set(inactive || []);
  const reopen = [];
  const prev = prevInactive || null;
  if (prev) {
    for (let i = 0; i < prev.length; i++) {
      if (!now.has(prev[i])) reopen.push(prev[i]);
    }
  }
  if (force || !prev) return { reopen: reopen, toFold: (inactive || []).slice() };
  const was = new Set(prev);
  const toFold = [];
  const list = inactive || [];
  for (let i = 0; i < list.length; i++) {
    if (!was.has(list[i])) toFold.push(list[i]);
  }
  return { reopen: reopen, toFold: toFold };
}

function branchesToFoldingRanges(branches) {
  const minLines = cfgMinLines();
  /** @type {vscode.FoldingRange[]} */
  const ranges = [];
  for (const b of branches) {
    if (!isFoldableInactive(b, minLines)) continue;
    ranges.push(new vscode.FoldingRange(b.startLine, b.endLine, vscode.FoldingRangeKind.Region));
  }
  return ranges;
}

function provideFoldingRanges(document) {
  if (!cfgEnabled() || !isCppLikeDoc(document)) return null;
  const root = resolveWorkspaceRoot();
  if (!root) return null;
  try {
    const env = loadMacroEnv(root);
    if (!env.ready) return null;
    const branches = cachedBranches(document, env.macros, env.key);
    const ranges = branchesToFoldingRanges(branches);
    return ranges.length ? ranges : null;
  } catch (_) {
    return null;
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

/** 关掉折叠时要展开的行。优先用这次会话折过的行，否则按当前死分支算。 */
function linesToReopen(editor) {
  const key = editor.document.uri.toString();
  const prev = gLastApplied.get(key);
  gLastApplied.delete(key);
  if (prev && prev.inactive && prev.inactive.length) return prev.inactive;
  try {
    const root = resolveWorkspaceRoot();
    const env = root && loadMacroEnv(root);
    if (!env || !env.ready) return [];
    const branches = cachedBranches(editor.document, env.macros, env.key);
    return selectFoldTargets(branches).inactive;
  } catch (_) {
    return [];
  }
}

async function applyFoldsToEditor(editor, reason) {
  if (!cfgEnabled()) {
    if (editor && editor === vscode.window.activeTextEditor) {
      if (isCppLikeDoc(editor.document)) {
        const lines = linesToReopen(editor);
        if (lines.length) {
          try { await unfoldLines(lines); } catch (_) { /* ignore */ }
        }
      }
      updateStatusBar(0);
    }
    return true;
  }
  if (!editor || !isCppLikeDoc(editor.document)) {
    if (editor && editor === vscode.window.activeTextEditor) updateStatusBar(0);
    return false;
  }
  // editor.fold 只作用于当前编辑器。对其他可见编辑器下折会把别人的行号折进当前文件。
  if (editor !== vscode.window.activeTextEditor) return true;
  const root = resolveWorkspaceRoot();
  if (!root) return false;
  const env = loadMacroEnv(root);
  if (!env.ready) return false;

  const doc = editor.document;
  const branches = cachedBranches(doc, env.macros, env.key);
  const { inactive } = selectFoldTargets(branches);

  const key = doc.uri.toString();
  const prev = gLastApplied.get(key);
  const stamp = inactive.join(',');
  // 行号没变就不再下折，个数仍改成当前文件的。刷新折叠除外。
  if (prev && prev.stamp === stamp && reason !== 'force') {
    updateStatusBar(inactive.length);
    return true;
  }

  fireFoldingChanged();
  await new Promise((r) => setTimeout(r, reason === 'init' || reason === 'open' ? 120 : 40));
  if (vscode.window.activeTextEditor !== editor) return true;

  const delta = foldDelta(prev && prev.inactive, inactive, reason === 'force');
  if (delta.reopen.length) {
    try { await unfoldLines(delta.reopen); } catch (_) { /* ignore */ }
  }
  if (delta.toFold.length) {
    try { await foldLines(delta.toFold); } catch (_) { /* ignore */ }
  }
  gLastApplied.set(key, { inactive, stamp });
  updateStatusBar(inactive.length);
  return true;
}

function updateStatusBar(count) {
  gFoldCount = typeof count === 'number' ? count : 0;
  if (gFoldListener) gFoldListener();
}

function foldBadge() {
  if (!cfgEnabled()) return { text: '$(fold) off', tip: '未激活 #if 折叠已关闭' };
  return { text: '$(fold) ' + gFoldCount, tip: '未激活 #if 已折 ' + gFoldCount };
}

function onFoldStatus(fn) {
  gFoldListener = fn;
}

function scheduleApplyVisible(reason) {
  if (gApplyTimer) clearTimeout(gApplyTimer);
  const delay = reason === 'force' ? 50 : (reason === 'init' ? 400 : 250);
  gApplyTimer = setTimeout(() => {
    gApplyTimer = null;
    void (async () => {
      const ed = vscode.window.activeTextEditor;
      let anyPending = false;
      if (ed) {
        try {
          const ok = await applyFoldsToEditor(ed, reason);
          if (!ok && isCppLikeDoc(ed.document)) anyPending = true;
        } catch (_) { /* ignore */ }
      }
      // 启动时宏表可能还没就绪；只按失败次数重试，不再无条件晚折两遍
      if (anyPending && (reason === 'init' || reason === 'retry' || reason === 'open' || reason === 'macros')
        && gPendingRetry < MAX_PENDING_RETRY) {
        gPendingRetry += 1;
        setTimeout(() => scheduleApplyVisible('retry'), FOLD_PENDING_RETRY_MS);
      } else if (!anyPending) {
        gPendingRetry = 0;
      }
    })();
  }, delay);
}

function invalidateEnvCache() {
  invalidateMacroTable();
  clearFoldCache();
  fireFoldingChanged();
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ commandPrefix?: string }} [options]
 */
function activate(context, options) {
  options = options || {};
  gCommandPrefix = String(options.commandPrefix || 'zkz-code');
  gFoldingChangeEmitter = new vscode.EventEmitter();
  context.subscriptions.push(gFoldingChangeEmitter);

  updateStatusBar(0);

  const provider = {
    onDidChange: gFoldingChangeEmitter.event,
    provideFoldingRanges(document) {
      return provideFoldingRanges(document);
    }
  };
  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider(
    [
      { language: 'c', pattern: '**/*.{c,C}' },
      { language: 'cpp', pattern: '**/*.{cpp,cc,cxx,CPP,CC,CXX}' },
      { language: 'cuda-cpp', pattern: '**/*.{c,cpp,cc,cxx}' }
    ],
    provider
  ));

  const wrap = (fn) => async (...args) => {
    try { await fn(...args); }
    catch (e) {
      vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(command('refreshIfdefFolds'), wrap(async () => {
      invalidateEnvCache();
      scheduleApplyVisible('force');
    })),
    vscode.commands.registerCommand(command('toggleIfdefFolds'), wrap(toggleIfdefFold))
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
    {
      dispose: () => {
        if (gApplyTimer) clearTimeout(gApplyTimer);
        gApplyTimer = null;
        gPendingRetry = 0;
        gLastApplied.clear();
        gFoldListener = null;
      }
    }
  );

  watchSettingsFile(context);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => watchSettingsFile(context)));

  // 会话恢复的已打开编辑器：宏表稍后才齐，失败走 anyPending 重试
  setTimeout(() => scheduleApplyVisible('init'), FOLD_INIT_DELAY_MS);
}

function watchSettingsFile(context) {
  if (gSettingsWatch) {
    gSettingsWatch.dispose();
    gSettingsWatch = null;
  }
  const root = repoRoot();
  if (!root) return;
  try { require('../../shared/zkz_settings').ensure(root); } catch (_) { /* ignore */ }
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.join(root, '.zkz'), 'settings.json')
  );
  const onChange = () => {
    clearFoldCache();
    fireFoldingChanged();
    updateStatusBar(0);
    scheduleApplyVisible('settings');
  };
  gSettingsWatch = vscode.Disposable.from(
    watcher,
    watcher.onDidChange(onChange),
    watcher.onDidCreate(onChange),
    watcher.onDidDelete(onChange)
  );
  context.subscriptions.push(gSettingsWatch);
}

function foldToggleLabel() {
  return cfgEnabled() ? '关闭折叠' : '打开折叠';
}

/** 写入 code.ifdefFold.enabled。设置文件变化后由监视器重折或展开。 */
async function toggleIfdefFold() {
  const root = repoRoot();
  if (!root) throw new Error('Open a workspace first');
  require('../../shared/zkz_settings').set(root, 'code', 'ifdefFold.enabled', !cfgEnabled());
}

function onMacrosChanged() {
  // 宏表已由 status 更新。只折新死的行，只展开不再死的行。
  clearFoldCache();
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
  foldDelta,
  foldBadge,
  foldToggleLabel,
  onFoldStatus
};
