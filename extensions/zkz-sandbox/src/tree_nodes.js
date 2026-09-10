'use strict';
const vscode = require('vscode');

function statusLetter(xy) {
  const a = xy[0];
  const b = xy[1];
  if (a === '?' || b === '?') return 'U';
  if (a === 'U' || b === 'U') return 'U';
  if (a === 'A' || b === 'A') return 'A';
  if (a === 'D' || b === 'D') return 'D';
  if (a === 'R' || b === 'R') return 'R';
  if (a === 'C' || b === 'C') return 'C';
  if (a === 'M' || b === 'M') return 'M';
  return (a !== ' ' ? a : b).trim() || 'M';
}

function iconForStatus(letter, staged) {
  if (letter === 'A') return 'diff-added';
  if (letter === 'D') return 'diff-removed';
  if (letter === 'R' || letter === 'C') return 'diff-renamed';
  if (letter === 'U') return 'diff-ignored';
  return staged ? 'diff-modified' : 'file';
}

class Node extends vscode.TreeItem {
  constructor(label, collapsible, kind, data) {
    super(label, collapsible);
    this.kind = kind;
    this.data = data || {};
    this.contextValue = kind;
  }
}

module.exports = { Node, statusLetter, iconForStatus };
