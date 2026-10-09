'use strict';

const vscode = require('vscode');
const ifdefFold = require('./ifdef_fold');

const PREFIX = 'zkz-code';
// 左侧状态栏，数字越大越靠左：code 10、clangd 9、native 8、keil 7。
const CODE_PRIORITY = 10;
const CLANGD_PRIORITY = 9;

function command(name) {
  return PREFIX + '.' + name;
}

const CODE_MENU = [
  { label: '折叠未激活 #if', command: 'foldInactiveIfdef' },
  { label: '展开未激活 #if', command: 'unfoldInactiveIfdef' },
  { label: '刷新折叠', command: 'refreshIfdefFolds' },
  { label: '检查 FFFD', command: 'checkFffd' },
  { label: '刷新状态栏', command: 'refreshStatus' }
];

const CLANGD_MENU = [
  { label: '刷新 compile_commands', command: 'refreshCompileCommands' },
  { label: '按宏影响刷新索引', command: 'invalidateMacroImpactIndex' },
  { label: '重建 clangd 索引', command: 'reindexClangd' },
  { label: '重启 clangd', command: 'restartClangd' }
];

let state = null;

function paintCode() {
  if (!state || !state.item) return;
  const item = state.item;
  const parts = [state.macroText || '$(symbol-misc) zkz-code'];
  const fold = ifdefFold.foldBadge ? ifdefFold.foldBadge() : null;
  if (fold && fold.text) parts.push(fold.text);
  item.text = parts.join('  ');
  const tips = [];
  if (state.macroTip) tips.push(state.macroTip);
  if (fold && fold.tip) tips.push(fold.tip);
  tips.push('点击选择命令');
  item.tooltip = tips.join('\n');
  item.backgroundColor = undefined;
  item.command = command('showCommandMenu');
  item.show();
}

function paintClangd() {
  if (!state || !state.clangdItem) return;
  const item = state.clangdItem;
  if (!state.ccTrack) {
    item.hide();
    return;
  }
  item.text = state.ccStale ? '$(warning) clangd' : '$(file-code) clangd';
  item.tooltip = [
    state.ccStale ? 'compile_commands 落后于 HEAD' : 'compile_commands 与 HEAD 一致',
    '点击选择命令'
  ].join('\n');
  item.backgroundColor = state.ccStale
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  item.command = command('showClangdMenu');
  item.show();
}

function showCommandMenu(hooks) {
  return async () => {
    let items = CODE_MENU.slice();
    if (hooks && hooks.macroItems) {
      try { items = items.concat(hooks.macroItems() || []); } catch (_) { /* 宏表读失败时仍显示命令 */ }
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'zkz-code',
      placeHolder: '选择要执行的命令'
    });
    if (!pick) return;
    try {
      if (pick.command) {
        await vscode.commands.executeCommand(command(pick.command));
        return;
      }
      if (hooks && hooks.openMacro) await hooks.openMacro(pick);
    } catch (e) {
      vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
    }
  };
}

async function showClangdMenu() {
  const pick = await vscode.window.showQuickPick(CLANGD_MENU, {
    title: 'clangd',
    placeHolder: '选择要执行的命令'
  });
  if (!pick) return;
  try {
    await vscode.commands.executeCommand(command(pick.command));
  } catch (e) {
    vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
  }
}

function create(context, hooks) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, CODE_PRIORITY);
  item.name = 'zkz Code';
  item.command = command('showCommandMenu');
  const clangdItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, CLANGD_PRIORITY);
  clangdItem.name = 'zkz clangd';
  clangdItem.command = command('showClangdMenu');
  state = {
    item: item,
    clangdItem: clangdItem,
    macroText: '$(symbol-misc) zkz-code',
    macroTip: '',
    ccTrack: false,
    ccStale: false
  };
  context.subscriptions.push(
    item,
    clangdItem,
    vscode.commands.registerCommand(command('showCommandMenu'), showCommandMenu(hooks)),
    vscode.commands.registerCommand(command('showClangdMenu'), showClangdMenu)
  );
  ifdefFold.onFoldStatus(paintCode);
  return {
    alive: () => !!state,
    setMacro: (text, tip) => {
      if (!state) return;
      state.macroText = text;
      state.macroTip = tip;
      paintCode();
    },
    setCc: (track, stale) => {
      if (!state) return;
      state.ccTrack = !!track;
      state.ccStale = !!stale;
      paintClangd();
    },
    dispose: () => { state = null; }
  };
}

module.exports = { create };
