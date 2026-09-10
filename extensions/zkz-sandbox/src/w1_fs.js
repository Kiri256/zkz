'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { W1_EDIT_SCHEME, log } = require('./shared');
const { detectBufferEncoding, bufferToText, encodeTextBuffer } = require('./encoding');

function w1EditUri(w1, filePosix) {
  const q = encodeURIComponent(JSON.stringify({ w1: w1, file: filePosix }));
  return vscode.Uri.parse(W1_EDIT_SCHEME + ':/' + filePosix + '?' + q);
}

function parseW1EditUri(uri) {
  try {
    return JSON.parse(decodeURIComponent(uri.query || '') || '{}');
  } catch (_) {
    return {};
  }
}

function languageFromPath(filePosix) {
  const ext = path.posix.extname(String(filePosix || '')).toLowerCase();
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

/**
 * Writable FS for W1 sources: editor sees UTF-8, disk stays GBK/UTF-8 as detected.
 */
function registerW1EditFs(context) {
  const emitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeFile: emitter.event,
    watch() { return { dispose() {} }; },
    stat(uri) {
      const q = parseW1EditUri(uri);
      const abs = path.join(q.w1 || '', ...(String(q.file || '').split('/').filter(Boolean)));
      const st = fs.statSync(abs);
      return {
        type: st.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
        ctime: st.ctimeMs,
        mtime: st.mtimeMs,
        size: st.size
      };
    },
    readDirectory() { return []; },
    createDirectory() { throw vscode.FileSystemError.NoPermissions(); },
    async readFile(uri) {
      const q = parseW1EditUri(uri);
      const abs = path.join(q.w1 || '', ...(String(q.file || '').split('/').filter(Boolean)));
      const text = bufferToText(fs.readFileSync(abs));
      return Buffer.from(text, 'utf8');
    },
    async writeFile(uri, content) {
      const q = parseW1EditUri(uri);
      const abs = path.join(q.w1 || '', ...(String(q.file || '').split('/').filter(Boolean)));
      const text = Buffer.from(content).toString('utf8');
      let enc = 'gbk';
      try {
        if (fs.existsSync(abs)) enc = detectBufferEncoding(fs.readFileSync(abs));
      } catch (_) { /* ignore */ }
      const buf = await encodeTextBuffer(text, enc);
      fs.writeFileSync(abs, buf);
      emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    },
    delete() { throw vscode.FileSystemError.NoPermissions(); },
    rename() { throw vscode.FileSystemError.NoPermissions(); }
  };
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(W1_EDIT_SCHEME, provider, { isCaseSensitive: false }));
  context.subscriptions.push(emitter);
}

/**
 * 统一本源打开路径：探测编码 → 原生 encoding 打开 → zkz-w1 → 普通 file://
 * 不依赖 blame/git，供 diff 与轻量路径复用。
 */
async function resolveW1Document(w1, filePosix) {
  const rel = String(filePosix || '').replace(/\\/g, '/');
  const abs = path.join(w1, ...rel.split('/').filter(Boolean));
  if (!fs.existsSync(abs)) {
    throw new Error('\u6587\u4ef6\u4e0d\u5b58\u5728: ' + abs);
  }
  let encoding = 'utf8';
  try { encoding = detectBufferEncoding(fs.readFileSync(abs)); } catch (_) { /* ignore */ }

  let doc = null;
  const fileUri = vscode.Uri.file(abs);

  if (encoding && encoding !== 'utf8') {
    const tries = encoding === 'gb18030'
      ? ['gb18030', 'gbk', 'gb2312']
      : ['gbk', 'gb2312', 'cp936'];
    for (const encTry of tries) {
      try {
        const encDoc = await vscode.workspace.openTextDocument({ uri: fileUri, encoding: encTry });
        if (
          encDoc && encDoc.uri && encDoc.uri.scheme === 'file' &&
          path.resolve(encDoc.uri.fsPath) === path.resolve(abs) &&
          encDoc.getText().length > 0
        ) {
          doc = encDoc;
          break;
        }
      } catch (_) { /* try next */ }
    }
  }

  if (!doc && encoding && encoding !== 'utf8') {
    try {
      const wuri = w1EditUri(w1, rel);
      doc = await vscode.workspace.openTextDocument(wuri);
    } catch (e) {
      log('w1-edit open fail: ' + (e && e.message ? e.message : e));
    }
  }

  if (!doc) {
    doc = await vscode.workspace.openTextDocument(fileUri);
  }

  return { doc, uri: doc.uri, encoding, abs, rel };
}

async function resolveW1OpenUri(w1, filePosix) {
  const { uri } = await resolveW1Document(w1, filePosix);
  return uri;
}

async function openW1WorktreeFile(w1, filePosix) {
  const { doc, rel } = await resolveW1Document(w1, filePosix);
  const lang = languageFromPath(rel);
  if (lang) {
    try { await vscode.languages.setTextDocumentLanguage(doc, lang); } catch (_) { /* ignore */ }
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  // blame 较重：仅打开本源文件时再加载
  try {
    const blame = require('./blame');
    blame.setBlameTarget({ w1: w1, file: rel });
    await blame.updateFileBlame(editor);
  } catch (e) {
    log('blame skip: ' + (e && e.message ? e.message : e));
  }
  return doc;
}

module.exports = {
  w1EditUri,
  parseW1EditUri,
  registerW1EditFs,
  resolveW1Document,
  resolveW1OpenUri,
  openW1WorktreeFile,
  languageFromPath
};
