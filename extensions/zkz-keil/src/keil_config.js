'use strict';

function cfg() {
  try {
    const vscode = require('vscode');
    if (vscode && vscode.workspace) return vscode.workspace.getConfiguration('zkz-keil');
  } catch (_) { /* tests / no vscode */ }
  return { get: (_k, d) => d };
}

function get(key, fallback) {
  const v = cfg().get(key);
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return v;
}

function getNumber(key, fallback) {
  const v = cfg().get(key);
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

module.exports = { get, getNumber };
