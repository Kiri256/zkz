'use strict';

const vscode = require('vscode');

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
    const { runKeilAction } = require('./keil');
    const emit = (msg) => {
      const s = String(msg == null ? '' : msg);
      this._write.fire(s.replace(/\r?\n/g, '\r\n') + '\r\n');
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

function activate(context) {
  const provider = {
    provideTasks() {
      const folder = (vscode.workspace.workspaceFolders || [])[0];
      return ACTIONS.map((spec) => makeTask(folder, spec));
    },
    resolveTask(task) {
      const action = task && task.definition && task.definition.action;
      if (!action) return undefined;
      const spec = ACTIONS.filter((a) => a.action === action)[0]
        || { action: action, name: task.name || action, group: '' };
      const folder = (vscode.workspace.workspaceFolders || [])[0];
      return makeTask(folder, spec);
    }
  };
  context.subscriptions.push(vscode.tasks.registerTaskProvider('zkz-keil', provider));
}

module.exports = { activate };
