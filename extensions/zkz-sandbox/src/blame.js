'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { runGit } = require('./git');
const { formatRelativeZh } = require('./time_fmt');
const { bufferToText } = require('./encoding');
const { W1_EDIT_SCHEME, GIT_SCHEME, log } = require('./shared');
const { resolvePair, assertW1Git } = require('./pair');

const gBlameCache = new Map();
const BLAME_CACHE_MAX = 24;
/** @type {vscode.TextEditorDecorationType | null} */
let gBlameDeco = null;
/** @type {{ w1: string, file: string } | null} */
let gBlameTarget = null;
let gBlameTimer = null;

function blameCacheSet(key, value) {
  if (gBlameCache.has(key)) gBlameCache.delete(key);
  gBlameCache.set(key, value);
  while (gBlameCache.size > BLAME_CACHE_MAX) {
    const oldest = gBlameCache.keys().next().value;
    gBlameCache.delete(oldest);
  }
}

function ensureBlameDecoration() {
  if (gBlameDeco) return gBlameDeco;
  gBlameDeco = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic'
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
  });
  return gBlameDeco;
}

function languageFromPath(filePosix) {
  const ext = path.posix.extname(filePosix).toLowerCase();
  const map = {
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
    '.js': 'javascript', '.ts': 'typescript', '.json': 'json',
    '.md': 'markdown', '.py': 'python', '.ps1': 'powershell',
    '.xml': 'xml', '.html': 'html', '.css': 'css',
    '.txt': 'plaintext', '.s': 'arm', '.asm': 'asm',
    '.ld': 'plaintext', '.cmake': 'cmake', '.ini': 'ini'
  };
  return map[ext] || '';
}

function isW1TextLikeFile(filePosix) {
  return /\.(c|h|cpp|hpp|cc|hh|s|asm|inc|ld|txt|md|json|xml|cmake|ini|py|ps1|js|ts|css|html|bat|cmd|uvproj|uvprojx|uvopt|uvoptx)$/i.test(
    String(filePosix || '')
  );
}

function parseBlamePorcelain(out) {
  const lines = [];
  let cur = null;
  let lastMeta = { hash: '', author: '', time: 0, summary: '' };
  for (const raw of String(out || '').split(/\r?\n/)) {
    if (/^[0-9a-f]{40}\b/.test(raw)) {
      cur = {
        hash: raw.slice(0, 40),
        author: lastMeta.author,
        time: lastMeta.time,
        summary: lastMeta.summary
      };
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('author ')) {
      cur.author = raw.slice(7);
    } else if (raw.startsWith('author-time ')) {
      cur.time = Number(raw.slice(12)) || 0;
    } else if (raw.startsWith('summary ')) {
      cur.summary = raw.slice(8);
    } else if (raw.startsWith('\t')) {
      lastMeta = {
        hash: cur.hash,
        author: cur.author,
        time: cur.time,
        summary: cur.summary
      };
      lines.push(lastMeta);
      cur = null;
    }
  }
  return lines;
}

async function loadBlameLines(w1, filePosix) {
  const full = path.join(w1, filePosix);
  let mtime = 0;
  try { mtime = fs.statSync(full).mtimeMs; } catch (_) { mtime = 0; }
  const key = w1 + '|' + filePosix;
  const hit = gBlameCache.get(key);
  if (hit && hit.mtime === mtime && hit.lines) return hit.lines;
  let lines = [];
  try {
    const out = await runGit(w1, [
      '-c', 'core.quotepath=false',
      'blame', '--line-porcelain', '--', filePosix
    ]);
    lines = parseBlamePorcelain(out);
  } catch (_) {
    let n = 0;
    try {
      const txt = bufferToText(fs.readFileSync(full));
      n = txt ? txt.split(/\r?\n/).length : 0;
    } catch (_e) { n = 0; }
    lines = Array.from({ length: n }, () => ({
      hash: '0', author: '', time: 0, summary: '\u672a\u63d0\u4ea4'
    }));
  }
  blameCacheSet(key, { mtime, lines });
  return lines;
}

function formatBlameAnnotation(b) {
  if (!b || !b.hash) return '\u672a\u8ddf\u8e2a';
  if (/^0+$/.test(b.hash)) return '\u672a\u63d0\u4ea4';
  const short = b.hash.slice(0, 7);
  const rel = formatRelativeZh(b.time) || '';
  const author = b.author || '';
  let sum = b.summary || '';
  if (sum.length > 40) sum = sum.slice(0, 40) + '...';
  return short + '  ' + author + (rel ? ('  ' + rel) : '') + (sum ? ('  ' + sum) : '');
}

function resolveBlameTargetFromDoc(doc) {
  if (!doc) return null;
  if (doc.uri.scheme === W1_EDIT_SCHEME) {
    let q = {};
    try { q = JSON.parse(decodeURIComponent(doc.uri.query || '') || '{}'); } catch (_) { q = {}; }
    if (q.w1 && q.file) {
      return { w1: q.w1, file: String(q.file).replace(/\\/g, '/') };
    }
    return null;
  }
  if (doc.uri.scheme === GIT_SCHEME) {
    let q = {};
    try { q = JSON.parse(doc.uri.query || '{}'); } catch (_) { q = {}; }
    if (q.rev === '__worktree__' && q.w1 && q.file) {
      return { w1: q.w1, file: String(q.file).replace(/\\/g, '/') };
    }
    return null;
  }
  if (doc.uri.scheme === 'file') {
    let pair;
    try { pair = resolvePair(); } catch (_) { return null; }
    if (!pair || !pair.w1) return null;
    const abs = path.resolve(doc.uri.fsPath);
    const root = path.resolve(pair.w1);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return { w1: pair.w1, file: rel.replace(/\\/g, '/') };
  }
  return null;
}

function paintBlameLine(editor, blameLines) {
  const deco = ensureBlameDecoration();
  if (!editor || !blameLines) {
    if (editor) editor.setDecorations(deco, []);
    return;
  }
  const line = editor.selection.active.line;
  const info = blameLines[line];
  if (!info) {
    editor.setDecorations(deco, []);
    return;
  }
  const range = new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER);
  editor.setDecorations(deco, [{
    range,
    renderOptions: {
      after: { contentText: formatBlameAnnotation(info) }
    }
  }]);
}

/** 仅缓存命中时重画当前行（跟选不跑 git blame） */
function updateBlameFromCache(editor) {
  if (!editor) return;
  const deco = ensureBlameDecoration();
  const target = resolveBlameTargetFromDoc(editor.document);
  if (!target || !isW1TextLikeFile(target.file)) {
    editor.setDecorations(deco, []);
    return;
  }
  const key = target.w1 + '|' + target.file;
  const hit = gBlameCache.get(key);
  if (!hit || !hit.lines) return;
  gBlameTarget = target;
  paintBlameLine(editor, hit.lines);
}

/** 仅在当前选中行行尾显示该行提交信息（可触发 git blame） */
async function updateFileBlame(editor) {
  if (!editor) return;
  const deco = ensureBlameDecoration();
  const doc = editor.document;
  const target = resolveBlameTargetFromDoc(doc);
  if (!doc || !target) {
    editor.setDecorations(deco, []);
    return;
  }
  if (!isW1TextLikeFile(target.file)) {
    editor.setDecorations(deco, []);
    return;
  }
  gBlameTarget = target;
  try {
    const blame = await loadBlameLines(target.w1, target.file);
    paintBlameLine(editor, blame);
  } catch (e) {
    log('blame: ' + (e && e.message ? e.message : e));
    editor.setDecorations(deco, []);
  }
}

let gBlameSelTimer = null;

function scheduleBlameUpdate(editor) {
  if (gBlameTimer) clearTimeout(gBlameTimer);
  gBlameTimer = setTimeout(() => {
    gBlameTimer = null;
    void updateFileBlame(editor);
  }, 400);
}

/** 跟选：只从缓存画装饰，debounce 稍短 */
function scheduleBlameSelectionUpdate(editor) {
  if (gBlameSelTimer) clearTimeout(gBlameSelTimer);
  gBlameSelTimer = setTimeout(() => {
    gBlameSelTimer = null;
    updateBlameFromCache(editor);
  }, 120);
}

async function openW1BrowseFile(item, provider) {
  const { openW1WorktreeFile } = require('./w1_fs');
  const pair = provider.pair || resolvePair();
  assertW1Git(pair.w1);
  const fileRaw = item && item.data && item.data.file;
  if (!fileRaw) return;
  const filePosix = String(fileRaw).replace(/\\/g, '/');
  await openW1WorktreeFile(pair.w1, filePosix);
}

function disposeBlameDecoration() {
  if (gBlameDeco) { gBlameDeco.dispose(); gBlameDeco = null; }
}

module.exports = {
  disposeBlameDecoration,
  isW1TextLikeFile,

  updateFileBlame,
  updateCurrentLineBlame: updateFileBlame,
  scheduleBlameUpdate,
  scheduleBlameSelectionUpdate,
  openW1BrowseFile,
  languageFromPath,
  parseBlamePorcelain,
  loadBlameLines,
  formatBlameAnnotation,
  ensureBlameDecoration,
  gBlameTarget: () => gBlameTarget,
  setBlameTarget: (t) => { gBlameTarget = t; }
};
