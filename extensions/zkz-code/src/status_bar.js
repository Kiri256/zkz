'use strict';

const vscode = require('vscode');
const ifdefFold = require('./ifdef_fold');

const PREFIX = 'zkz-code';
// 左侧状态栏，数字越大越靠左。clangd 扩展自己是 10，后面依次 code、keil、native。
const CODE_PRIORITY = 9;

function command(name) {
  return PREFIX + '.' + name;
}

function codeMenu() {
  const items = [
    { label: ifdefFold.foldToggleLabel(), command: 'toggleIfdefFolds' },
    { label: '刷新折叠', command: 'refreshIfdefFolds' },
    { label: '恢复 CMSIS Include（仅工作区）', command: 'restoreCmsisInclude' },
    { label: '刷新 compile_commands', command: 'refreshCompileCommands' },
    { label: '重启 clangd', command: 'restartClangd' },
    { label: '清空 index 目录', command: 'invalidateMacroImpactIndex' }
  ];
  return items;
}

let state = null;

function paintCode() {
  if (!state || !state.item) return;
  const item = state.item;
  const parts = [state.macroText || '$(symbol-misc) zkz-code'];
  const fold = ifdefFold.foldBadge ? ifdefFold.foldBadge() : null;
  if (fold && fold.text) parts.push(fold.text);
  if (state.ccTrack && state.ccStale) parts.push('$(warning) clangd');
  item.text = parts.join('  ');
  const tips = [];
  if (state.macroTip) tips.push(state.macroTip);
  if (fold && fold.tip) tips.push(fold.tip);
  if (state.ccTrack) {
    tips.push(state.ccStale ? 'compile_commands 未跟上当前分支' : 'compile_commands 可用');
  }
  tips.push('点击选择命令');
  item.tooltip = tips.join('\n');
  item.backgroundColor = state.ccTrack && state.ccStale
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
  item.command = command('showCommandMenu');
  item.show();
}

function showCommandMenu(hooks) {
  return async () => {
    let items = codeMenu();
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

function create(context, hooks) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, CODE_PRIORITY);
  item.name = 'zkz Code';
  item.command = command('showCommandMenu');
  state = {
    item: item,
    macroText: '$(symbol-misc) zkz-code',
    macroTip: '',
    ccTrack: false,
    ccStale: false
  };
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand(command('showCommandMenu'), showCommandMenu(hooks))
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
      paintCode();
    },
    dispose: () => { state = null; }
  };
}

module.exports = { create };
