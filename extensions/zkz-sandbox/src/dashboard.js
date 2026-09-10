'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { loadWorkspaceLists } = require('./lists');
const { collectSyncHints } = require('./sync_hint');
const { isSandboxWorkspace } = require('./pair');

const MAX_SCAN_FILES = 400;

function scanTops() {
  return loadWorkspaceLists().scanTops || ['core', 'application', 'driver', 'User', 'emWin'];
}
function scanExtSet() {
  const L = loadWorkspaceLists();
  return new Set(L.fffdTextExtensions || ['.c', '.h', '.cpp', '.hpp', '.md', '.json', '.txt']);
}

let panel = null;

function runGitShort(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, stdout) => {
      if (e) resolve('');
      else resolve(String(stdout || '').trim());
    });
  });
}

function readMeta(sandbox) {
  const p = path.join(sandbox, '.zkz', '.workspace_sync_meta.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/** Windows Junction / symlink 检测 */
function listJunctions(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of ents) {
    const full = path.join(root, ent.name);
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        let target = '';
        try { target = fs.readlinkSync(full); } catch (e2) { }
        out.push({ name: ent.name, kind: 'symlink', target: String(target) });
        continue;
      }
      // Junction：目录且 Get-Item 更可靠；Node 上用 readlink 可能失败，改用 powershell 轻量探测太慢
      // 启发式：若是目录且打开失败/与源同 inode 少见——用 cmd dir /AL 太重
      // 使用 fs.readlink 对 junction 在 win 上有时可用
      if (ent.isDirectory()) {
        try {
          const t = fs.readlinkSync(full);
          if (t) out.push({ name: ent.name, kind: 'junction', target: String(t) });
        } catch (e3) { /* 普通目录 */ }
      }
    } catch (e) { }
  }
  return out;
}

function countFffd(buf) {
  let n = 0;
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) n++;
  }
  return n;
}

function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch (e) {
    return false;
  }
}

function looksLikeGbk(buf) {
  if (!buf || !buf.length) return false;
  if (isValidUtf8(buf)) return false;
  // 含高位字节且非 UTF-8 → 倾向 GBK（本源常见）
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0x80) return true;
  }
  return false;
}

function sleep0() {
  return new Promise((r) => setImmediate(r));
}

async function walkScanAsync(root, tops, maxFiles) {
  const files = [];
  const skip = new Set(['.git', '.cache', 'node_modules', 'Libraries', 'FreeRTOS', 'Flash', 'Obj']);
  let steps = 0;
  for (const top of tops) {
    const d = path.join(root, top);
    if (!fs.existsSync(d)) continue;
    const stack = [d];
    while (stack.length && files.length < maxFiles) {
      const dir = stack.pop();
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of ents) {
        if (files.length >= maxFiles) break;
        if (skip.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else if (ent.isFile() && scanExtSet().has(path.extname(ent.name).toLowerCase())) {
          try {
            if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
          } catch (e) { continue; }
          files.push(full);
        }
      }
      steps++;
      if ((steps % 40) === 0) await sleep0();
    }
  }
  return files;
}

async function scanEncoding(sandbox) {
  const files = await walkScanAsync(sandbox, scanTops(), MAX_SCAN_FILES);
  let utf8 = 0;
  let ascii = 0;
  let gbk = 0;
  let fffd = 0;
  const fffdFiles = [];
  const gbkSamples = [];
  for (let i = 0; i < files.length; i++) {
    if ((i % 30) === 0) await sleep0();
    const fp = files[i];
    let buf;
    try { buf = fs.readFileSync(fp); } catch (e) { continue; }
    const n = countFffd(buf);
    if (n > 0) {
      fffd += n;
      if (fffdFiles.length < 8) fffdFiles.push(path.relative(sandbox, fp));
    }
    let high = false;
    for (let j = 0; j < buf.length; j++) {
      if (buf[j] >= 0x80) { high = true; break; }
    }
    if (!high) { ascii++; continue; }
    if (isValidUtf8(buf)) utf8++;
    else if (looksLikeGbk(buf)) {
      gbk++;
      if (gbkSamples.length < 8) gbkSamples.push(path.relative(sandbox, fp));
    } else utf8++;
  }
  return {
    scanned: files.length,
    utf8,
    ascii,
    gbk,
    fffdBytes: fffd,
    fffdFiles,
    gbkSamples
  };
}

function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

function fmtTime(s) {
  if (!s) return '-';
  return String(s).replace('T', ' ').slice(0, 19);
}

function ageText(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return sec + ' 秒前';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  return Math.floor(sec / 86400) + ' 天前';
}

async function collectReport(api) {
  const pair = api.resolvePair();
  const meta = readMeta(pair.sandbox) || {};
  const w1Head = await runGitShort(pair.w1, ['rev-parse', '--short', 'HEAD']);
  const w1Branch = await runGitShort(pair.w1, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const w1Dirty = Boolean(await runGitShort(pair.w1, ['status', '--porcelain']));
  const metaCommit = meta.sourceCommit ? String(meta.sourceCommit).slice(0, 9) : '';
  const commitMatch = !metaCommit || !w1Head || w1Head.indexOf(metaCommit) === 0 || metaCommit.indexOf(w1Head) === 0;

  const syncedAt = parseTime(meta.syncedAt);
  const fromUtfAt = parseTime(meta.lastFromUtf8At);
  const libsAt = parseTime(meta.libsSyncedAt);
  const now = Date.now();

  // 本源核心目录最近写入（粗判 W1 是否比上次 ToUtf 更新）
  let w1CoreMtime = null;
  const coreW1 = path.join(pair.w1, 'core');
  if (fs.existsSync(coreW1)) {
    try { w1CoreMtime = fs.statSync(coreW1).mtimeMs; } catch (e) { }
  }
  const w1NewerThanSync = syncedAt && w1CoreMtime && w1CoreMtime > syncedAt + 5000;

  const junctions = listJunctions(pair.sandbox);
  const enc = await scanEncoding(pair.sandbox);

  const warnings = [];
  if (!meta.syncedAt) warnings.push('缺少同步元数据（.zkz/.workspace_sync_meta.json），建议先 ToUtf');
  if (w1NewerThanSync) warnings.push('本源 core 目录时间晚于上次 ToUtf，沙箱可能偏旧 → 建议 ToUtf');
  if (fromUtfAt && syncedAt && fromUtfAt > syncedAt) warnings.push('上次 ToGb 晚于 ToUtf：本源已回写，注意勿用旧沙箱覆盖');
  if (!commitMatch && metaCommit && w1Head) {
    warnings.push('元数据 sourceCommit(' + metaCommit + ') 与当前 HEAD(' + w1Head + ') 不一致 → 可能已切分支未拉沙箱');
  }
  if (enc.gbk > 0) warnings.push('\u6c99\u7bb1\u4e1a\u52a1\u6e90\u4e2d\u53d1\u73b0 ' + enc.gbk + ' \u4e2a\u7591\u4f3c GBK \u6587\u4ef6\uff08\u5e94\u4e3a UTF-8\uff09\u2192 \u5efa\u8bae ToUtf \u5f3a\u5236\u5237\u65b0');
  if (enc.fffdBytes > 0) warnings.push('\u68c0\u6d4b\u5230 FFFD\uff08\u4e71\u7801\u66ff\u6362\u5b57\u7b26\uff09\u5171 ' + enc.fffdBytes + ' \u5904\uff0c\u8bf7\u6309 sandbox.mdc \u6062\u590d');

  const hints = collectSyncHints(pair);
  for (const h of hints.hints) {
    if (!warnings.includes(h)) warnings.push(h);
  }

  return {
    w1: pair.w1,
    sandbox: pair.sandbox,
    w1Branch,
    w1Head,
    w1Dirty,
    meta,
    metaCommit,
    commitMatch,
    syncedAtText: fmtTime(meta.syncedAt),
    fromUtfAtText: fmtTime(meta.lastFromUtf8At),
    libsAtText: fmtTime(meta.libsSyncedAt),
    syncedAge: ageText(syncedAt ? now - syncedAt : null),
    fromUtfAge: ageText(fromUtfAt ? now - fromUtfAt : null),
    libsAge: ageText(libsAt ? now - libsAt : null),
    lastFromUtf8Files: Array.isArray(meta.lastFromUtf8Files) ? meta.lastFromUtf8Files.slice(0, 12) : [],
    junctions,
    enc,
    warnings,
    canSync: isSandboxWorkspace(),
    needToGb: hints.needToGb,
    needToUtf: hints.needToUtf
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(report) {
  const syncDis = report.canSync
    ? ''
    : ' disabled title="\u8bf7\u5728 *U \u6c99\u7bb1\u6267\u884c\u540c\u6b65/\u5bf9\u6bd4"';
  const warnHtml = report.warnings.length
    ? '<ul class="warn">' + report.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>'
    : '<p class="ok">未发现明显冲突/编码风险</p>';
  const juncHtml = report.junctions.length
    ? '<ul>' + report.junctions.map((j) => '<li><code>' + esc(j.name) + '</code> <span class="muted">' + esc(j.kind) + '</span> → ' + esc(j.target) + '</li>').join('') + '</ul>'
    : '<p class="muted">根目录下未检测到 symlink/junction（或需管理员权限枚举）</p>';
  const filesHtml = report.lastFromUtf8Files.length
    ? '<ul>' + report.lastFromUtf8Files.map((f) => '<li><code>' + esc(f) + '</code></li>').join('') + '</ul>'
    : '<p class="muted">无</p>';
  const fffdHtml = report.enc.fffdFiles.length
    ? '<ul>' + report.enc.fffdFiles.map((f) => '<li><code>' + esc(f) + '</code></li>').join('') + '</ul>'
    : '';
  const gbkHtml = report.enc.gbkSamples.length
    ? '<ul>' + report.enc.gbkSamples.map((f) => '<li><code>' + esc(f) + '</code></li>').join('') + '</ul>'
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 20px; line-height: 1.45; }
  h1 { font-size: 1.25rem; margin: 0 0 12px; }
  h2 { font-size: 1rem; margin: 20px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  table { border-collapse: collapse; width: 100%; max-width: 920px; }
  td { padding: 4px 8px; vertical-align: top; }
  td.k { width: 160px; color: var(--vscode-descriptionForeground); }
  code { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  .muted { color: var(--vscode-descriptionForeground); }
  .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .warn { color: var(--vscode-errorForeground); padding-left: 18px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.85em; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; min-width: 140px; }
  .card .n { font-size: 1.4rem; font-weight: 600; }
</style>
</head>
<body>
  <h1>zkz 同步 / 编码仪表盘</h1>
  <div class="row">
    <button data-cmd="refresh">\u5237\u65b0</button>
    <button data-cmd="toUtf"${syncDis}>ToUtf</button>
    <button data-cmd="toGb"${syncDis}>ToGb</button>
    <button class="secondary" data-cmd="pairDiff"${syncDis}>\u672c\u6e90 \u2194 \u6c99\u7bb1</button>
    <button class="secondary" data-cmd="pairDiffBatch"${syncDis}>\u6279\u91cf\u5dee\u5f02</button>
  </div>

  <h2>告警</h2>
  ${warnHtml}

  <h2>路径与 Git</h2>
  <table>
    <tr><td class="k">真源</td><td><code>${esc(report.w1)}</code></td></tr>
    <tr><td class="k">沙箱</td><td><code>${esc(report.sandbox)}</code></td></tr>
    <tr><td class="k">分支 / HEAD</td><td>${esc(report.w1Branch)} <span class="badge">${esc(report.w1Head || '?')}</span> ${report.w1Dirty ? '<span class="badge">脏</span>' : ''}</td></tr>
    <tr><td class="k">元数据 commit</td><td>${esc(report.metaCommit || '-')} ${report.commitMatch ? '<span class="ok">一致</span>' : '<span class="warn">不一致</span>'}</td></tr>
  </table>

  <h2>同步时间</h2>
  <table>
    <tr><td class="k">上次 ToUtf</td><td>${esc(report.syncedAtText)} <span class="muted">(${esc(report.syncedAge)})</span></td></tr>
    <tr><td class="k">上次 ToGb</td><td>${esc(report.fromUtfAtText)} <span class="muted">(${esc(report.fromUtfAge)})</span></td></tr>
    <tr><td class="k">库同步</td><td>${esc(report.libsAtText)} <span class="muted">(${esc(report.libsAge)})</span></td></tr>
  </table>

  <h2>最近 ToGb 文件</h2>
  ${filesHtml}

  <h2>编码抽样（core/application/driver/User，最多 ${MAX_SCAN_FILES}）</h2>
  <div class="cards">
    <div class="card"><div class="muted">已扫</div><div class="n">${report.enc.scanned}</div></div>
    <div class="card"><div class="muted">UTF-8</div><div class="n">${report.enc.utf8}</div></div>
    <div class="card"><div class="muted">ASCII</div><div class="n">${report.enc.ascii}</div></div>
    <div class="card"><div class="muted">疑似 GBK</div><div class="n">${report.enc.gbk}</div></div>
    <div class="card"><div class="muted">FFFD 字节</div><div class="n">${report.enc.fffdBytes}</div></div>
  </div>
  ${gbkHtml ? '<p class="muted">GBK 样例</p>' + gbkHtml : ''}
  ${fffdHtml ? '<p class="muted">FFFD 样例</p>' + fffdHtml : ''}

  <h2>沙箱根链接（Junction / Symlink）</h2>
  ${juncHtml}

  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => vscode.postMessage({ cmd: btn.getAttribute('data-cmd') }));
    });
  </script>
</body>
</html>`;
}

async function showDashboard(api) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
  } else {
    panel = vscode.window.createWebviewPanel(
      'zkzDashboard',
      'zkz 同步/编码',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => { panel = null; });
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (!msg || !msg.cmd) return;
        if (msg.cmd === 'refresh') {
          await refreshPanel(api);
          return;
        }
        if (msg.cmd === 'toUtf') {
          await vscode.commands.executeCommand('zkz-sandbox.toUtf');
          await refreshPanel(api);
          return;
        }
        if (msg.cmd === 'toGb') {
          await vscode.commands.executeCommand('zkz-sandbox.toGb');
          await refreshPanel(api);
          return;
        }
        if (msg.cmd === 'pairDiff') {
          await vscode.commands.executeCommand('zkz-sandbox.diffSandboxW1');
          return;
        }
        if (msg.cmd === 'pairDiffBatch') {
          await vscode.commands.executeCommand('zkz-sandbox.diffSandboxW1Batch');
          return;
        }
      } catch (e) {
        vscode.window.showErrorMessage(String(e.message || e));
      }
    });
  }
  await refreshPanel(api);
}

async function refreshPanel(api) {
  if (!panel) return;
  panel.webview.html = '<html><body style="padding:16px;font-family:sans-serif">正在扫描…</body></html>';
  const report = await collectReport(api);
  panel.webview.html = renderHtml(report);
}

module.exports = {
  showDashboard
};
