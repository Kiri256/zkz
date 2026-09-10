'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { showInfoAuto } = require('./toast');
const { withProgress } = require('./shared');
const { resolvePair, assertSandboxSync } = require('./pair');
const { bufferToText } = require('./encoding');
const { loadWorkspaceLists } = require('./lists');
const { diffSandboxW1 } = require('./pair_diff');

const MAX_COMPARE_BYTES = 2 * 1024 * 1024;
const MAX_REPORT = 500;
let gPanel = null;
let gLastReport = null;

function sleep0() {
  return new Promise((r) => setImmediate(r));
}

function normalizeText(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function buildSkipDirSet() {
  const lists = loadWorkspaceLists();
  const names = []
    .concat(lists.excludeDirNames || [])
    .concat(lists.libraryDirNames || [])
    .concat([
      '.git', '.vscode', '.cursor', '.codex', '.claude', '.cache',
      'node_modules', 'Flash', 'Obj', 'List', 'Listings'
    ]);
  return new Set(names.map((s) => String(s)));
}

/**
 * Batch-diff tops: modern tree prefers core/application/driver;
 * old User-layout uses User (+ system/fpga_motion/emWin if present in scanTops).
 * @param {string} [rootAbs] sandbox or W1 root for existence checks
 */
function scanTopsForBatch(rootAbs) {
  const lists = loadWorkspaceLists();
  const configured = (lists.scanTops || ['core', 'application', 'driver', 'User']).map(String);
  const exists = (name) => {
    if (!rootAbs) return true;
    try {
      return fs.existsSync(path.join(rootAbs, name)) && fs.statSync(path.join(rootAbs, name)).isDirectory();
    } catch (_) {
      return false;
    }
  };
  const hasCore = exists('core');
  const hasUser = exists('User');
  let tops;
  if (hasUser && !hasCore) {
    // Old flat layout: GUI may live under emWin; include configured non-core tops that exist
    const oldPrefer = new Set(['user', 'system', 'fpga_motion', 'emwin']);
    tops = configured.filter((t) => oldPrefer.has(t.toLowerCase()) && exists(t));
    if (!tops.length) tops = ['User'].filter(exists);
  } else {
    // Modern / mixed: skip User (often huge or legacy leftover)
    tops = configured.filter((t) => t.toLowerCase() !== 'user' && exists(t));
    if (!tops.length) {
      tops = ['core', 'application', 'driver'].filter(exists);
    }
  }
  return tops;
}

/** Short label for sync menu description */
function describeBatchScanTops(rootAbs) {
  const tops = scanTopsForBatch(rootAbs);
  if (!tops.length) return '\u65e0\u53ef\u626b\u9876\u5c42'; // 无可扫顶层
  const s = tops.join('/');
  if (tops.some((t) => t.toLowerCase() === 'user') && !tops.some((t) => t.toLowerCase() === 'core')) {
    return '\u65e7\u5e03\u5c40 ' + s; // 旧布局
  }
  return s;
}

function textExtSet() {
  const lists = loadWorkspaceLists();
  const exts = lists.fffdTextExtensions || lists.textExtensions || ['.c', '.h', '.cpp', '.hpp'];
  return new Set(exts.map((e) => String(e).toLowerCase()));
}

async function collectRels(rootAbs, tops, skipDir, textExt) {
  const out = new Set();
  let steps = 0;
  for (const top of tops) {
    const topAbs = path.join(rootAbs, top);
    if (!fs.existsSync(topAbs) || !fs.statSync(topAbs).isDirectory()) continue;
    const stack = [{ abs: topAbs, rel: top }];
    while (stack.length) {
      const { abs, rel } = stack.pop();
      let ents;
      try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of ents) {
        const name = ent.name;
        if (!name || name === '.' || name === '..') continue;
        if (skipDir.has(name)) continue;
        const childRel = (rel + '/' + name).replace(/\\/g, '/');
        const childAbs = path.join(abs, name);
        let isDir = false;
        try { isDir = ent.isDirectory(); } catch (_) { continue; }
        if (isDir) stack.push({ abs: childAbs, rel: childRel });
        else if (ent.isFile() || ent.isSymbolicLink()) {
          const ext = path.posix.extname(childRel).toLowerCase();
          if (textExt.has(ext)) out.add(childRel);
        }
      }
      steps++;
      if ((steps % 50) === 0) await sleep0();
    }
  }
  return out;
}

function compareOne(pair, rel) {
  const sandAbs = path.join(pair.sandbox, ...rel.split('/'));
  const w1Abs = path.join(pair.w1, ...rel.split('/'));
  const sandOk = fs.existsSync(sandAbs) && fs.statSync(sandAbs).isFile();
  const w1Ok = fs.existsSync(w1Abs) && fs.statSync(w1Abs).isFile();
  if (!sandOk && !w1Ok) return 'skip';
  if (!sandOk) return 'w1Only';
  if (!w1Ok) return 'sandboxOnly';
  let w1Buf;
  let sandBuf;
  try {
    const st1 = fs.statSync(w1Abs);
    const st2 = fs.statSync(sandAbs);
    if (st1.size > MAX_COMPARE_BYTES || st2.size > MAX_COMPARE_BYTES) return 'skip';
    w1Buf = fs.readFileSync(w1Abs);
    sandBuf = fs.readFileSync(sandAbs);
  } catch (_) {
    return 'skip';
  }
  if (looksBinary(w1Buf) || looksBinary(sandBuf)) return 'skip';
  const left = normalizeText(bufferToText(w1Buf));
  const right = normalizeText(sandBuf.toString('utf8'));
  return left === right ? 'same' : 'differ';
}

async function scanPairDiffs(pair) {
  let tops = scanTopsForBatch(pair.sandbox);
  if (!tops.length) tops = scanTopsForBatch(pair.w1);
  if (!tops.length) tops = ['core', 'application', 'driver'];
  const skipDir = buildSkipDirSet();
  // Old-layout GUI under emWin: allow walking that top (name is also a libraryDirName)
  if (tops.some((t) => String(t).toLowerCase() === 'emwin')) {
    skipDir.delete('emWin');
    skipDir.delete('emwin');
  }
  const textExt = textExtSet();
  const sandRels = await collectRels(pair.sandbox, tops, skipDir, textExt);
  const w1Rels = await collectRels(pair.w1, tops, skipDir, textExt);
  const all = new Set([...sandRels, ...w1Rels]);
  const sorted = [...all].sort((a, b) => a.localeCompare(b));

  const differ = [];
  const sandboxOnly = [];
  const w1Only = [];
  let scanned = 0;
  let truncated = false;

  for (const rel of sorted) {
    scanned++;
    if ((scanned % 40) === 0) await sleep0();
    if (differ.length + sandboxOnly.length + w1Only.length >= MAX_REPORT) {
      truncated = true;
      break;
    }
    const kind = compareOne(pair, rel);
    if (kind === 'differ') differ.push(rel);
    else if (kind === 'sandboxOnly') sandboxOnly.push(rel);
    else if (kind === 'w1Only') w1Only.push(rel);
  }

  return { differ, sandboxOnly, w1Only, scanned, truncated, tops };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPanelHtml(report) {
  const rows = (arr, tag) => arr.map((rel) =>
    `<tr data-rel="${esc(rel)}"><td class="tag">${esc(tag)}</td><td><a href="#" data-rel="${esc(rel)}">${esc(rel)}</a></td></tr>`
  ).join('');
  const body =
    rows(report.differ, '\u5185\u5bb9\u4e0d\u540c') +
    rows(report.sandboxOnly, '\u4ec5\u6c99\u7bb1') +
    rows(report.w1Only, '\u4ec5\u672c\u6e90');
  const total = report.differ.length + report.sandboxOnly.length + report.w1Only.length;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/>
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:12px 16px}
h1{font-size:1.1rem;margin:0 0 8px}
.muted{color:var(--vscode-descriptionForeground);margin-bottom:12px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 10px;margin-right:8px;cursor:pointer}
table{border-collapse:collapse;width:100%;max-width:960px}
td{padding:3px 8px;border-bottom:1px solid var(--vscode-panel-border);font-size:0.92em}
td.tag{width:88px;color:var(--vscode-descriptionForeground)}
a{color:var(--vscode-textLink-foreground);text-decoration:none}
a:hover{text-decoration:underline}
#filter{width:100%;max-width:480px;margin:8px 0 12px;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
</style></head><body>
<h1>\u672c\u6e90 \u2194 \u6c99\u7bb1 \u6279\u91cf\u5dee\u5f02</h1>
<p class="muted">\u5171 ${total} \u9879\uff08\u4e0d\u540c ${report.differ.length} / \u4ec5\u6c99\u7bb1 ${report.sandboxOnly.length} / \u4ec5\u672c\u6e90 ${report.w1Only.length}\uff09\u00b7 \u5df2\u626b ${report.scanned}\u00b7 ${esc(report.tops.join('/'))}${report.truncated ? ' \u00b7 \u5df2\u622a\u65ad' : ''}</p>
<button data-cmd="rescan">\u91cd\u65b0\u626b\u63cf</button>
<button data-cmd="togb">ToGb</button>
<input id="filter" placeholder="\u7b5b\u9009\u8def\u5f84\u5173\u952e\u5b57..."/>
<table id="tbl"><tbody>${body || '<tr><td colspan="2" class="muted">\u65e0\u5dee\u5f02</td></tr>'}</tbody></table>
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('button[data-cmd]').forEach(b => b.onclick = () => vscode.postMessage({cmd:b.dataset.cmd}));
document.querySelectorAll('a[data-rel]').forEach(a => a.onclick = (e) => { e.preventDefault(); vscode.postMessage({cmd:'open', rel:a.dataset.rel}); });
const filter = document.getElementById('filter');
filter.oninput = () => {
  const q = filter.value.trim().toLowerCase();
  document.querySelectorAll('#tbl tr[data-rel]').forEach(tr => {
    tr.style.display = !q || tr.dataset.rel.toLowerCase().includes(q) ? '' : 'none';
  });
};
</script></body></html>`;
}

async function showPairDiffBatch() {
  assertSandboxSync();
  const pair = resolvePair();
  const report = await withProgress(
    '\u626b\u63cf\u672c\u6e90 \u2194 \u6c99\u7bb1\u5dee\u5f02...',
    async () => scanPairDiffs(pair)
  );
  gLastReport = report;
  const total = report.differ.length + report.sandboxOnly.length + report.w1Only.length;
  if (total === 0) {
    void showInfoAuto(
      '\u65e0\u5dee\u5f02\uff08\u5df2\u626b ' + report.scanned + ' \u4e2a\u6587\u4ef6\uff1a' +
      report.tops.join('/') + '\uff09',
      4000
    );
  }

  if (gPanel) {
    gPanel.reveal(vscode.ViewColumn.Beside);
  } else {
    gPanel = vscode.window.createWebviewPanel(
      'zkzPairDiffBatch',
      '\u6279\u91cf\u5dee\u5f02',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    gPanel.onDidDispose(() => { gPanel = null; });
    gPanel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (!msg || !msg.cmd) return;
        if (msg.cmd === 'open' && msg.rel) {
          await diffSandboxW1(msg.rel);
          return;
        }
        if (msg.cmd === 'rescan') {
          await showPairDiffBatch();
          return;
        }
        if (msg.cmd === 'togb') {
          vscode.window.showInformationMessage('Use zkz Sandbox: Sync Menu and run ToGb to write sandbox changes back to W1.');
          return;
        }
      } catch (e) {
        vscode.window.showErrorMessage(String(e && e.message ? e.message : e));
      }
    });
  }
  gPanel.webview.html = renderPanelHtml(report);
}

module.exports = {
  scanTopsForBatch,
  describeBatchScanTops,
  scanPairDiffs,
  showPairDiffBatch,
  compareOne
};
