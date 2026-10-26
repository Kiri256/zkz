'use strict';

const path = require('path');
const vscode = require('vscode');
const { folderForRoot } = require('../../shared/project_root');

const ACTIONS = [
  { action: 'build', name: 'Keil Build', group: 'build' },
  { action: 'rebuild', name: 'Keil Rebuild', group: 'build' },
  { action: 'flash', name: 'J-Link Flash', group: 'test' },
  { action: 'prepare', name: 'Prepare Cortex Debug', group: '' },
  { action: 'buildFlash', name: 'Build + Flash', group: 'build' },
  { action: 'buildFlashPrepare', name: 'Build + Flash + Prepare Debug', group: '' },
  { action: 'flashPrepare', name: 'Flash + Prepare Debug', group: '' }
];

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
    Promise.resolve(runKeilAction(this.action, { log: emit, token: this._cancel.token }))
      .then((code) => this._close.fire(code ? 1 : 0))
      .catch((e) => {
        emit(String(e && e.message ? e.message : e));
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
  if (spec.group === 'build') task.group = vscode.TaskGroup.Build;
  else if (spec.group === 'test') task.group = vscode.TaskGroup.Test;
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    showReuseMessage: false,
    clear: true
  };
  task.problemMatchers = ['$msCompile'];
  return task;
}

function taskFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return undefined;
  let root = '';
  try { root = require('./pair').resolvePair().root; } catch (_) { return undefined; }
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
      return ACTIONS.map((spec) => makeTask(folder, spec));
    },
    resolveTask(task) {
      const action = task && task.definition && task.definition.action;
      if (!action) return undefined;
      const spec = ACTIONS.filter((a) => a.action === action)[0]
        || { action: action, name: task.name || action, group: '' };
      const folder = taskFolder();
      if (!folder) return undefined;
      return makeTask(folder, spec);
    }
  };
  context.subscriptions.push(vscode.tasks.registerTaskProvider('zkz-keil', provider));
}

module.exports = { activate };
