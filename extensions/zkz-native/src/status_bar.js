'use strict';

const path = require('path');
const vscode = require('vscode');
const { statusSnapshot, barLabel, statusLines, encodingActions } = require('./bootstrap');
const commands = require('./commands');
const { resolveRepo } = commands;
const { isInstalled, isLocalInstalled } = require('./git_config');
const { FILTER_FAIL_LIMIT, markFilterFailNotified } = require('./observe');

// 左侧状态栏，数字越大越靠左。clangd 扩展自己是 10，后面依次 code 9、keil 8、native 7。
const PRIORITY = 7;
const FLASH_MS = 4000;

function sep(label) {
  return { label: label, kind: vscode.QuickPickItemKind.Separator };
}

function hoverOf(st) {
  return statusLines(st).concat(['点击打开菜单']).join('\n');
}

async function openAt(repo, rel, position) {
  if (!repo || !rel) return;
  const abs = path.join(repo, ...String(rel).split('/'));
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
  const editor = await vscode.window.showTextDocument(doc);
  if (!Number.isFinite(position) || position < 0) return;
  const pos = doc.positionAt(position);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

function create(context, opts) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, PRIORITY);
  item.name = 'zkz Native';
  item.command = 'zkz-native.showCommandMenu';
  context.subscriptions.push(item);

  let latest = null;
  let flashText = '';
  let flashTimer = null;
  let watchRepo = '';
  let watchSubs = [];
  let watchBound = false;

  const refresh = () => {
    try {
      const repo = resolveRepo();
      watchRun(repo);
      if (!isInstalled(repo)) {
        const st = { installed: false, tableCount: 0 };
        latest = { repo: repo, st: st, actions: encodingActions(st) };
        if (!flashText) {
          item.text = '$(circle-slash) ' + barLabel(st);
          item.backgroundColor = undefined;
        }
        item.tooltip = '过滤器未启用\n点击打开菜单';
        item.show();
        return;
      }
      const st = statusSnapshot(repo);
      latest = { repo: repo, st: st, actions: encodingActions(st) };
      if ((st.filterFails || 0) >= FILTER_FAIL_LIMIT && !st.filterFailNotified) {
        markFilterFailNotified(repo);
        void vscode.window.showWarningMessage('过滤器连续失败，Git 可能不可用。', '关闭过滤器').then((choice) => {
          if (choice === '关闭过滤器') void vscode.commands.executeCommand('zkz-native.disable');
        });
      }
      item.tooltip = hoverOf(st);
      if (flashText) {
        item.show();
        return;
      }
      item.text = '$(symbol-enum) ' + barLabel(st);
      item.backgroundColor = undefined;
      item.show();
    } catch (_) {
      if (!flashText) item.hide();
    }
  };

  function watchRun(repo) {
    if (!repo || watchRepo === repo) return;
    watchRepo = repo;
    watchSubs.forEach((d) => { try { d.dispose(); } catch (_) { /* ignore */ } });
    watchSubs = [];
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.join(repo, '.zkz', 'run'), '*.json'));
      const kick = () => refresh();
      watchSubs.push(w, w.onDidChange(kick), w.onDidCreate(kick), w.onDidDelete(kick));
    } catch (_) { /* ignore */ }
    if (!watchBound) {
      watchBound = true;
      context.subscriptions.push({
        dispose: () => {
          watchSubs.forEach((d) => { try { d.dispose(); } catch (_) { /* ignore */ } });
          watchSubs = [];
        }
      });
    }
  }

  function flash(text) {
    flashText = String(text || '');
    item.text = '$(symbol-enum) ' + flashText;
    item.backgroundColor = undefined;
    item.show();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashText = '';
      flashTimer = null;
      refresh();
    }, FLASH_MS);
  }

  async function showMenu() {
    if (!latest) {
      try { refresh(); } catch (_) { /* ignore */ }
    }
    const repo = latest && latest.repo;
    const st = (latest && latest.st) || {};
    const actions = (latest && latest.actions) || { restage: [], opens: [], notes: [], unstable: [] };
    const items = [];
    if ((st.filterFails || 0) >= FILTER_FAIL_LIMIT) {
      items.push({ label: '关闭过滤器', command: 'zkz-native.disable', description: '过滤器连续失败，Git 可能不可用' });
    }
    if (actions.restage.length === 1) {
      items.push({
        label: '重新暂存 ' + actions.restage[0].rel,
        action: 'restage',
        rels: [actions.restage[0].rel],
        description: actions.restage[0].message
      });
    } else if (actions.restage.length > 1) {
      items.push({
        label: '重新暂存 ' + actions.restage.length + ' 个文件',
        action: 'restage',
        rels: actions.restage.map((x) => x.rel),
        description: actions.restage.map((x) => x.rel).slice(0, 8).join('、')
      });
    }
    if (actions.opens.length === 1) {
      const one = actions.opens[0];
      items.push({
        label: one.rel + '：这个字符写不回 GBK',
        action: 'open',
        rel: one.rel,
        position: one.position,
        description: one.message
      });
    } else if (actions.opens.length > 1) {
      items.push({ label: actions.opens.length + ' 个文件编不回 GBK', action: 'list-open', files: actions.opens });
    }
    actions.notes.slice(0, 4).forEach((n) => {
      items.push({ label: String(n.message || '').slice(0, 80), action: 'note', detail: n.message });
    });
    if (!actions.restage.length && !actions.opens.length && actions.unstable.length) {
      items.push({
        label: actions.unstable.length + ' 个文件没能对齐索引',
        action: 'note',
        detail: actions.unstable.join('\n')
      });
    }
    items.push(sep('日常'));
    let filterOn = false;
    try { filterOn = !!(repo && isInstalled(repo)); } catch (_) { filterOn = false; }
    items.push({
      label: filterOn ? '过滤器 开' : '过滤器 关',
      command: filterOn ? 'zkz-native.disable' : 'zkz-native.enable',
      description: '点击切换'
    });
    let localOn = false;
    try { localOn = !!(repo && isLocalInstalled(repo)); } catch (_) { localOn = false; }
    items.push({
      label: localOn ? '本地配置 开' : '本地配置 关',
      command: 'zkz-native.toggleLocalConfig',
      description: '点击切换'
    });
    items.push(sep('出了问题'));
    items.push({ label: '刷新编码表', command: 'zkz-native.refreshTable' });
    items.push({ label: '查看编不回的文件', action: 'list-open', files: actions.opens });
    items.push({ label: '同步编烧树', command: 'zkz-native.syncKeilTree' });
    const pick = await vscode.window.showQuickPick(items, {
      title: 'zkz-native',
      placeHolder: '选择要执行的命令'
    });
    if (!pick || pick.kind === vscode.QuickPickItemKind.Separator) return;
    if (pick.command) {
      await vscode.commands.executeCommand(pick.command);
      return;
    }
    if (pick.action === 'restage') {
      await commands.restage(pick.rels);
      return;
    }
    if (pick.action === 'open') {
      await openAt(repo, pick.rel, pick.position);
      return;
    }
    if (pick.action === 'list-open') {
      const files = pick.files || [];
      if (!files.length) {
        commands.note('没有编不回的文件');
        return;
      }
      if (files.length === 1) {
        await openAt(repo, files[0].rel, files[0].position);
        return;
      }
      const sub = await vscode.window.showQuickPick(files.map((f) => ({
        label: f.rel,
        description: f.message,
        rel: f.rel,
        position: f.position
      })), { title: '编不回 GBK 的文件' });
      if (sub) await openAt(repo, sub.rel, sub.position);
      return;
    }
    if (pick.action === 'note') commands.note(pick.detail);
  }

  context.subscriptions.push(vscode.commands.registerCommand('zkz-native.showCommandMenu', showMenu));

  if (opts && opts.defer) {
    item.text = '$(symbol-enum) native';
    item.tooltip = '正在检查';
    item.show();
  } else {
    refresh();
  }
  const timer = setInterval(refresh, 15000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  context.subscriptions.push({ dispose: () => { if (flashTimer) clearTimeout(flashTimer); } });
  return { item: item, refresh: refresh, flash: flash };
}

module.exports = { create };
