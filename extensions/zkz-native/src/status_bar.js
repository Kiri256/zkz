'use strict';

const vscode = require('vscode');
const { statusSnapshot } = require('./bootstrap');
const { formatStatus, resolveRepo } = require('./commands');

function create(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 8);
  item.command = 'zkz-native.status';
  context.subscriptions.push(item);

  const refresh = () => {
    try {
      const repo = resolveRepo();
      const st = statusSnapshot(repo);
      item.text = '$(symbol-enum) ' + formatStatus(st);
      item.tooltip = 'zkz-native 过滤器与编码表';
      item.show();
    } catch (_) {
      item.hide();
    }
  };

  refresh();
  return { item: item, refresh: refresh };
}

module.exports = { create };
