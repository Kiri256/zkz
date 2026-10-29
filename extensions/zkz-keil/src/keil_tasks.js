'use strict';

const path = require('path');
const vscode = require('vscode');
const loadShared = require('./load_shared');
const { folderForRoot } = loadShared('project_root');

const ACTIONS = [
  { action: 'build', name: 'Keil Build', group: 'build', title: '编译', listed: true },
  { action: 'rebuild', name: 'Keil Rebuild', title: '重新编译', listed: false },
  { action: 'flash', name: 'J-Link Flash', title: '烧录', listed: false },
  { action: 'prepare', name: 'Prepare Cortex Debug', title: '准备调试', listed: true },
  { action: 'buildFlashPrepare', name: 'Build + Flash + Prepare Debug', title: '编译、烧录并准备调试', listed: true }
];

function taskTitle(action) {
  for (let i = 0; i < ACTIONS.length; i++) {
    if (ACTIONS[i].action === action) return ACTIONS[i].title;
  }
  return action;
}

function taskChecksBuild(action) {
  return action === 'build' || action === 'rebuild' || action === 'buildFlashPrepare';
}

/** 把任务失败写进终端。扩展宿主线程调用。 */
function reportTaskError(emit, err) {
  emit(String(err && err.message ? err.message : err));
}

function specFor(action) {
  for (let i = 0; i < ACTIONS.length; i++) {
    if (ACTIONS[i].action === action) return ACTIONS[i];
  }
  return null;
}

class KeilPty {
  constructor(action) {
    this.action = action;
    this._write = new vscode.EventEmitter();
    this.onDidWrite = this._write.event;
    this._close = new vscode.EventEmitter();
    this.onDidClose = this._close.event;
    this._cancel = new vscode.CancellationTokenSource();
  }
  open() {
    const { runKeilAction, normalizeEmitText } = require('./keil');
    const emit = (msg) => {
      const s = normalizeEmitText(msg).replace(/\n/g, '\r\n');
      this._write.fire(s + '\r\n');
    };
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: taskTitle(this.action), cancellable: true },
      (progress, uiToken) => {
        const sub = uiToken.onCancellationRequested(() => this._cancel.cancel());
        return Promise.resolve(runKeilAction(this.action, {
          log: emit,
          token: this._cancel.token,
          progress: progress
        })).finally(() => sub.dispose());
      }
    ).then((code) => {
      this._close.fire(code ? 1 : 0);
    }).catch((e) => {
      reportTaskError(emit, e);
      this._close.fire(1);
    });
  }
  close() {
    this._cancel.cancel();
  }
}

function makeTask(folder, spec) {
  const def = { type: 'zkz-keil', action: spec.action };
  const exec = new vscode.CustomExecution(async () => new KeilPty(spec.action));
  const scope = folder || vscode.TaskScope.Workspace;
  const task = new vscode.Task(def, scope, spec.name, 'zkz-keil', exec);
  if (spec.group === 'build') task.group = { id: 'build', isDefault: true };
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    showReuseMessage: false,
    clear: true
  };
  task.problemMatchers = taskChecksBuild(spec.action) ? ['$zkz-keil'] : [];
  return task;
}

function taskFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return undefined;
  let root = '';
  try { root = loadShared('pair').resolvePair().root; } catch (_) { return undefined; }
  const chosen = folderForRoot(folders.map(function (f) { return f.uri.fsPath; }), root);
  const want = path.resolve(chosen).toLowerCase();
  for (let i = 0; i < folders.length; i++) {
    if (path.resolve(folders[i].uri.fsPath).toLowerCase() === want) return folders[i];
  }
  return undefined;
}

function activate(context) {
  const provider = {
    provideTasks() {
      const folder = taskFolder();
      if (!folder) return [];
      return ACTIONS.filter((spec) => spec.listed).map((spec) => makeTask(folder, spec));
    },
    resolveTask(task) {
      const action = task && task.definition && task.definition.action;
      const spec = specFor(action);
      if (!spec) return undefined;
      const folder = taskFolder();
      if (!folder) return undefined;
      return makeTask(folder, spec);
    }
  };
  context.subscriptions.push(vscode.tasks.registerTaskProvider('zkz-keil', provider));
}

/** 跑一条 Keil 任务。日志在任务终端，通知由任务打开。扩展宿主线程调用。 */
async function runTask(action) {
  const folder = taskFolder();
  if (!folder) throw new Error('未打开工作区文件夹');
  const spec = specFor(action);
  if (!spec) throw new Error('未知的 Keil 动作：' + action);
  await vscode.tasks.executeTask(makeTask(folder, spec));
}

module.exports = { activate, runTask };
