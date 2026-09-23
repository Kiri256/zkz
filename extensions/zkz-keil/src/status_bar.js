'use strict';

const vscode = require('vscode');

// 左侧状态栏，数字越大越靠左：code 10、clangd 9、native 8、keil 7。
const PRIORITY = 7;

const MENU = [
  { label: '编译', command: 'zkz-keil.keilBuild' },
  { label: '重新编译', command: 'zkz-keil.keilRebuild' },
  { label: '烧录', command: 'zkz-keil.keilFlash' },
  { label: '准备调试', command: 'zkz-keil.prepareCortexDebug' }
];

function create(context, isPaired) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, PRIORITY);
  item.name = 'zkz Keil';
  item.text = '$(tools) zkz-keil';
  item.tooltip = '点击选择命令';
  item.command = 'zkz-keil.showCommandMenu';
  const refresh = () => {
    if (isPaired()) item.show();
    else item.hide();
  };
  refresh();
  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('zkz-keil.showCommandMenu', async () => {
      const pick = await vscode.window.showQuickPick(MENU, {
        title: 'zkz-keil',
        placeHolder: '选择要执行的命令'
      });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh)
  );
}

module.exports = { create };
