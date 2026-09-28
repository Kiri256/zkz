'use strict';

const vscode = require('vscode');
const { statusSnapshot } = require('./bootstrap');
const { formatStatus, resolveRepo } = require('./commands');
const { isInstalled } = require('./git_config');
const { FILTER_FAIL_LIMIT, markFilterFailNotified } = require('./observe');
const { markLibWarningsNotified } = require('./lib_encoding');

const NATIVE_MENU = [
  { label: '启用过滤器', command: 'zkz-native.enable' },
  { label: '关闭过滤器', command: 'zkz-native.disable' },
  { label: '刷新编码表', command: 'zkz-native.refreshTable' },
  { label: '检查 cp936 往返', command: 'zkz-native.checkRoundtrip' },
  { label: '查看状态', command: 'zkz-native.status' },
  { label: '同步编烧树', command: 'zkz-native.syncKeilTree' },
  { label: '拷贝调试 axf', command: 'zkz-native.copyDebugAxf' },
  { label: '保存本地配置', command: 'zkz-native.saveConfigOverlay' },
  { label: '还原本地配置', command: 'zkz-native.restoreConfigOverlay' }
];

// 左侧状态栏，数字越大越靠左：code 10、clangd 9、native 8、keil 7。
const PRIORITY = 8;

function create(context, opts) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, PRIORITY);
  item.name = 'zkz Native';
  item.command = 'zkz-native.showCommandMenu';
  context.subscriptions.push(item);
  context.subscriptions.push(vscode.commands.registerCommand('zkz-native.showCommandMenu', async () => {
    const pick = await vscode.window.showQuickPick(NATIVE_MENU, {
      title: 'zkz-native',
      placeHolder: '选择要执行的命令'
    });
    if (!pick) return;
    await vscode.commands.executeCommand(pick.command);
  }));

  const refresh = () => {
    try {
      const repo = resolveRepo();
      if (!isInstalled(repo)) {
        item.text = '$(circle-slash) zkz-native: off';
        item.tooltip = '过滤器未启用，点击选择命令';
        item.backgroundColor = undefined;
        item.show();
        return;
      }
      const st = statusSnapshot(repo);
      item.text = '$(symbol-enum) ' + formatStatus(st);
      const tips = ['zkz-native 过滤器与编码表'];
      if (st.roundtripFails && st.roundtripFails.length) {
        tips.push('往返失败: ' + st.roundtripFails.slice(0, 8).join(', '));
      }
      if (st.tableDrift) tips.push('编码表落后于 HEAD，将自动刷新或请执行 refreshTable');
      const libItems = st.libWarnings || [];
      if (libItems.length) {
        tips.push('库编码告警: ' + libItems.slice(0, 8).map((it) => it.rel).join(', '));
      }
      if (st.filterFails >= FILTER_FAIL_LIMIT) {
        tips.push('filter 连续失败。可运行 zkz-native.disable 卸过滤器（不依赖 filter 进程）');
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        if (!st.filterFailNotified) {
          markFilterFailNotified(repo);
          void vscode.window.showWarningMessage(
            'zkz-native filter 连续失败 ' + st.filterFails + ' 次，git 可能不可用。可执行 zkz-native.disable'
          );
        }
      } else if ((st.roundtripFails && st.roundtripFails.length) || st.tableDrift || libItems.length) {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        if (libItems.length && !st.libWarningsNotified) {
          markLibWarningsNotified(repo);
          void vscode.window.showWarningMessage(
            'zkz-native: ' + libItems.length + ' 个库文件编码疑似漂移或损坏。库不过滤，不会自动改回。见 .zkz/lib-encoding-warnings.json'
          );
        }
      } else {
        item.backgroundColor = undefined;
      }
      tips.push('点击选择命令');
      item.tooltip = tips.join('\n');
      item.show();
    } catch (_) {
      item.hide();
    }
  };

  if (opts && opts.defer) {
    item.text = '$(symbol-enum) zkz-native: 初始化中';
    item.tooltip = 'zkz-native 正在校验过滤器与编码表';
    item.show();
  } else {
    refresh();
  }
  const timer = setInterval(refresh, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  return { item: item, refresh: refresh };
}

module.exports = { create };
