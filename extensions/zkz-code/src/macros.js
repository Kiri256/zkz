'use strict';
/**
 * yt_version.h 有效宏解析（纯 JS）。扩展内不再 spawn python。
 */
const fs = require('fs');
const path = require('path');
const { evalPpExpr } = require('./pp_expr');

function vscodeApi() {
  try { return require('vscode'); } catch (_) { return null; }
}

function loadMacroKeys() {
  const fallback = [
    'MACHINE_VALUE', 'SCREEN_800_480', 'MALL_DOUBLE', 'MALL_MULTI',
    'MALL_EXPAND_AXIS', 'MALL_EXPAND_IO', 'CUSTOMER_SET', 'GROUP_MACHINE',
    'MLS_BLOW_SUCTION', 'MLS_610'
  ];
  try {
    const keys = require('./lists').loadWorkspaceLists().macroKeys;
    if (Array.isArray(keys) && keys.length) return keys.map(String);
  } catch (_) { /* ignore */ }
  return fallback;
}

const MACRO_KEYS = loadMacroKeys();

function isTrackedMacro(name) {
  return MACRO_KEYS.includes(name)
    || name.startsWith('MALL_')
    || name.startsWith('MLS_')
    || name.startsWith('MDJ_')
    || name.startsWith('MHX_');
}

function findYtVersion(root) {
  const candidates = [
    path.join(root, 'core', 'core_common', 'yt_version.h'),
    path.join(root, 'User', 'common', 'yt_version.h'),
    path.join(root, 'core', 'yt_version.h')
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function findClangdConfig(root) {
  if (!root) return null;
  const p = path.join(root, '.clangd');
  return fs.existsSync(p) ? p : null;
}

/**
 * CompileFlags.Add 里的 -D/-U（与 clangd 命令行宏一致）。
 * 只解析第一个 CompileFlags 块（遇到 --- 结束），不依赖 YAML 库。
 * @param {string} text
 * @returns {Object<string,string>}
 */
function parseClangdCompileDefines(text) {
  /** @type {Object<string,string>} */
  const macros = {};
  let inCompile = false;
  let inAdd = false;
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    if (/^\s*---\s*$/.test(raw)) {
      inCompile = false;
      inAdd = false;
      continue;
    }
    if (/^CompileFlags\s*:/.test(raw)) {
      inCompile = true;
      inAdd = false;
      continue;
    }
    if (!inCompile) continue;
    if (/^\S/.test(raw) && !/^\s/.test(raw)) {
      inCompile = false;
      inAdd = false;
      continue;
    }
    if (/^\s+Add\s*:/.test(raw)) {
      inAdd = true;
      continue;
    }
    if (/^\s+\w[\w]*\s*:/.test(raw) && !/^\s+-\s/.test(raw)) {
      inAdd = false;
      continue;
    }
    if (!inAdd) continue;
    const m = raw.match(/^\s+-\s+(.+)$/);
    if (!m) continue;
    let flag = m[1].trim();
    if ((flag.startsWith('"') && flag.endsWith('"')) || (flag.startsWith("'") && flag.endsWith("'"))) {
      flag = flag.slice(1, -1);
    }
    if (flag.startsWith('-D')) {
      const body = flag.slice(2);
      if (!body) continue;
      const eq = body.indexOf('=');
      if (eq < 0) macros[body] = '';
      else macros[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (flag.startsWith('-U')) {
      const name = flag.slice(2).trim();
      if (name) delete macros[name];
    }
  }
  return macros;
}

function findOpenDoc(filePath) {
  try {
    const vscode = vscodeApi();
    if (!vscode || !vscode.workspace || !filePath) return null;
    const want = path.resolve(filePath);
    const active = vscode.window && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
    if (active && active.uri && active.uri.scheme === 'file' && path.resolve(active.uri.fsPath) === want) return active;
    const docs = vscode.workspace.textDocuments || [];
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      if (d.uri && d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === want) return d;
    }
  } catch (_) { /* ignore */ }
  return null;
}

function fileStatKey(filePath) {
  try {
    const st = fs.statSync(filePath);
    return filePath + '|' + st.mtimeMs + '|' + st.size;
  } catch (_) {
    return filePath + '|missing';
  }
}

function getClangdText(filePath) {
  const doc = findOpenDoc(filePath);
  if (doc) return doc.getText();
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

/**
 * 全量宏表：.clangd -D 先入，再走 yt_version.h。保留表达式宏，不过白名单。
 * @param {string} text
 * @param {Object<string,string>} [initialMacros]
 * @returns {{ macros: Object<string,string>, locs: Object<string,number> }}
 */
function parseFullMacroTable(text, initialMacros) {
  /** @type {Object<string,string>} */
  const macros = Object.assign({}, initialMacros || {});
  /** @type {Object<string,number>} */
  const locs = {};
  /** @type {{ active: boolean, seenTrue: boolean }[]} */
  const stack = [];
  const effectiveActive = () => stack.every((f) => f.active);

  const lines = String(text || '').split(/\r?\n/);
  let li = 0;
  while (li < lines.length) {
    let line = lines[li];
    while (/\\\s*$/.test(line) && li + 1 < lines.length) {
      li += 1;
      line = line.replace(/\\\s*$/, '') + lines[li];
    }
    const trim = line.trim();
    if (!trim.startsWith('#')) {
      li += 1;
      continue;
    }
    const body = trim.replace(/^#\s*/, '');

    if (/^if\b/.test(body) && !/^ifdef\b/.test(body) && !/^ifndef\b/.test(body)) {
      const expr = body.replace(/^if\b/, '').trim();
      const parent = effectiveActive();
      const val = parent ? evalPpExpr(expr, macros) : false;
      stack.push({ active: parent && val, seenTrue: parent && val });
      li += 1;
      continue;
    }
    if (/^ifdef\b/.test(body)) {
      const name = body.replace(/^ifdef\b/, '').trim().split(/\s+/)[0];
      const parent = effectiveActive();
      const val = parent && (name in macros);
      stack.push({ active: !!val, seenTrue: !!val });
      li += 1;
      continue;
    }
    if (/^ifndef\b/.test(body)) {
      const name = body.replace(/^ifndef\b/, '').trim().split(/\s+/)[0];
      const parent = effectiveActive();
      const val = parent && !(name in macros);
      stack.push({ active: !!val, seenTrue: !!val });
      li += 1;
      continue;
    }
    if (/^elif\b/.test(body)) {
      if (stack.length) {
        const top = stack[stack.length - 1];
        const parent = stack.slice(0, -1).every((f) => f.active);
        if (!parent || top.seenTrue) {
          top.active = false;
        } else {
          const expr = body.replace(/^elif\b/, '').trim();
          const val = evalPpExpr(expr, macros);
          top.active = val;
          if (val) top.seenTrue = true;
        }
      }
      li += 1;
      continue;
    }
    if (/^else\b/.test(body)) {
      if (stack.length) {
        const top = stack[stack.length - 1];
        const parent = stack.slice(0, -1).every((f) => f.active);
        top.active = parent && !top.seenTrue;
        if (top.active) top.seenTrue = true;
      }
      li += 1;
      continue;
    }
    if (/^endif\b/.test(body)) {
      if (stack.length) stack.pop();
      li += 1;
      continue;
    }
    if (!effectiveActive()) {
      li += 1;
      continue;
    }
    if (/^undef\b/.test(body)) {
      const name = body.replace(/^undef\b/, '').trim().split(/\s+/)[0];
      if (name) {
        delete macros[name];
        delete locs[name];
      }
      li += 1;
      continue;
    }
    // function-like: #define FOO(x) ...
    if (/^define\s+[A-Za-z_]\w*\(/.test(body)) {
      li += 1;
      continue;
    }
    const dm = body.match(/^define\s+([A-Za-z_]\w*)(?:\s+(.*))?$/);
    if (!dm) {
      li += 1;
      continue;
    }
    const name = dm[1];
    let val = (dm[2] || '').trim();
    val = val.replace(/\/\*.*?\*\//g, ' ');
    val = val.replace(/\/\/.*$/, '').trim();
    if (val.startsWith('//')) val = '';
    macros[name] = val;
    locs[name] = li + 1;
    li += 1;
  }
  return { macros, locs };
}

function macroTextHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return 'h:' + (h >>> 0) + ':' + text.length;
}

function getYtVersionText(filePath) {
  const doc = findOpenDoc(filePath);
  if (doc) return doc.getText();
  // 按内容探测编码，避免当 UTF-8 读坏 GBK 文件
  try {
    const { bufferToText } = require('./encoding');
    return bufferToText(fs.readFileSync(filePath));
  } catch (_) {
    return fs.readFileSync(filePath, 'utf8');
  }
}

function inferWorkspaceRoot(filePath) {
  try {
    const vscode = vscodeApi();
    const folders = (vscode && vscode.workspace && vscode.workspace.workspaceFolders) || [];
    if (filePath) {
      const want = path.resolve(filePath);
      const wantLow = want.toLowerCase();
      for (const f of folders) {
        const root = path.resolve(f.uri.fsPath);
        const prefix = root.toLowerCase() + path.sep;
        if (wantLow.startsWith(prefix) || wantLow === root.toLowerCase()) return root;
      }
    }
    if (folders.length) return folders[0].uri.fsPath;
  } catch (_) { /* ignore */ }
  if (!filePath) return '';
  let dir = path.dirname(filePath);
  for (let i = 0; i < 5; i++) {
    if (findClangdConfig(dir) || findYtVersion(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(filePath);
}

let gClangdCache = { key: '', macros: {} };

function clangdCacheKey(workspaceRoot) {
  const cfg = findClangdConfig(workspaceRoot);
  if (!cfg) return '';
  const doc = findOpenDoc(cfg);
  if (doc) return cfg + '|doc|' + doc.version;
  return fileStatKey(cfg);
}

function loadClangdLayer(workspaceRoot) {
  const key = clangdCacheKey(workspaceRoot);
  if (!key) return { macros: {}, stamp: '' };
  if (gClangdCache.key === key) return { macros: gClangdCache.macros, stamp: key };
  const cfg = findClangdConfig(workspaceRoot);
  const text = getClangdText(cfg);
  const macros = parseClangdCompileDefines(text);
  gClangdCache = { key: key, macros: macros };
  return { macros: macros, stamp: key };
}

function isMacroEnvReady(macros) {
  if (!macros || typeof macros !== 'object') return false;
  if (!('MACHINE_VALUE' in macros)) return false;
  return ('MLS' in macros) || ('MDJ' in macros) || ('MHX' in macros);
}

function emptyMacroTable() {
  return { key: '', macros: {}, locs: {}, ready: false, filePath: '' };
}

/** @type {{ key: string, macros: Object<string,string>, locs: Object<string,number>, ready: boolean, filePath: string }} */
let gTableCache = emptyMacroTable();

function invalidateMacroTable() {
  gTableCache = emptyMacroTable();
  gClangdCache = { key: '', macros: {} };
}

function getMacroTable() {
  return gTableCache;
}

/**
 * 唯一宏表：.clangd -D + yt_version.h 全量。徽章与折叠共用。
 * @param {{ workspaceRoot?: string, text?: string, filePath?: string }} [opts]
 */
function loadMacroTable(opts) {
  opts = opts || {};
  const root = opts.workspaceRoot || inferWorkspaceRoot(opts.filePath || '');
  const ver = opts.filePath || (root ? findYtVersion(root) : null);
  if (!ver && opts.text == null) return emptyMacroTable();
  const clangdKey = clangdCacheKey(root);
  let text = null;
  let textKey;
  if (opts.text != null) {
    text = String(opts.text);
    textKey = 'text:' + macroTextHash(text);
  } else if (ver) {
    const doc = findOpenDoc(ver);
    textKey = doc ? ('doc:' + doc.version) : ('disk:' + fileStatKey(ver));
  } else {
    textKey = 'none';
  }
  const key = (ver || '') + '|' + textKey + '|' + clangdKey;
  if (gTableCache.key === key && gTableCache.ready) return gTableCache;
  if (text == null) text = ver ? getYtVersionText(ver) : '';
  const clangd = loadClangdLayer(root);
  const parsed = parseFullMacroTable(text, clangd.macros);
  const ready = isMacroEnvReady(parsed.macros);
  gTableCache = {
    key,
    macros: parsed.macros,
    locs: parsed.locs,
    ready,
    filePath: ver || ''
  };
  return gTableCache;
}

async function revealMacroInYtVersion(filePath, line1) {
  const vscode = vscodeApi();
  if (!vscode) throw new Error('vscode unavailable');
  const doc = await vscode.workspace.openTextDocument(filePath);
  const ed = await vscode.window.showTextDocument(doc, { preview: false });
  const line = Math.max(0, Math.min(doc.lineCount - 1, (line1 || 1) - 1));
  const range = doc.lineAt(line).range;
  ed.selection = new vscode.Selection(range.start, range.start);
  ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

function macroIsShown(val) {
  if (val === '' || val == null) return true;
  const v = String(val).trim();
  if (v === '0' || v === '(0)') return false;
  return true;
}

function isCustomerShown(val) {
  if (val == null || val === '') return false;
  const v = String(val).trim();
  if (v === '0' || v === '(0)') return false;
  if (/^COMSTOM_0000$/i.test(v)) return false;
  return true;
}

function isGroupMachineShown(val) {
  if (val == null || val === '') return false;
  const v = String(val).trim();
  if (v === '0' || v === '(0)') return false;
  if (/^GROUP_MACHINE_0000$/i.test(v)) return false;
  return true;
}

function isMacroKeyShown(key, val) {
  if (key === 'CUSTOMER_SET') return isCustomerShown(val);
  if (key === 'GROUP_MACHINE') return isGroupMachineShown(val);
  return macroIsShown(val);
}

function machineLabel(macros) {
  const mv = macros.MACHINE_VALUE;
  if (mv === '0' || mv === 'MDJ') return 'MDJ';
  if (mv === '1' || mv === 'MLS') return 'MLS';
  if (mv === '2' || mv === 'MHX') return 'MHX';
  return mv != null ? String(mv) : '?';
}

function machineFingerprint(macros) {
  return [macros.MACHINE_VALUE || '', macros.MALL_MULTI || '', macros.CUSTOMER_SET || '', macros.GROUP_MACHINE || ''].join('|');
}

function shortCustomerLabel(val) {
  const v = String(val).trim();
  if (/^COMSTOM_/i.test(v)) return v.replace(/^COMSTOM_/i, '');
  return v;
}

function shortGroupMachineLabel(val) {
  const v = String(val).trim();
  if (/^GROUP_MACHINE_/i.test(v)) return v.replace(/^GROUP_MACHINE_/i, '');
  return v;
}

function listedMacroNames(macros) {
  const src = macros || {};
  const out = [];
  for (let i = 0; i < MACRO_KEYS.length; i++) {
    const k = MACRO_KEYS[i];
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    if (!isMacroKeyShown(k, src[k])) continue;
    out.push(k);
  }
  return out;
}

function formatMacroLines(macros) {
  return listedMacroNames(macros).map((k) => {
    const v = macros[k];
    return (v === '' || v == null) ? ('#define ' + k) : (k + '=' + v);
  });
}

function formatMacroBadge(macros) {
  const parts = [machineLabel(macros)];
  if (macroIsShown(macros.SCREEN_800_480) && macros.SCREEN_800_480 != null && macros.SCREEN_800_480 !== '') {
    parts.push('SCR=' + macros.SCREEN_800_480);
  }
  if (macroIsShown(macros.MALL_DOUBLE) && macros.MALL_DOUBLE != null && macros.MALL_DOUBLE !== '') {
    parts.push('DBL=' + macros.MALL_DOUBLE);
  }
  if (macroIsShown(macros.MLS_BLOW_SUCTION) && macros.MLS_BLOW_SUCTION != null && macros.MLS_BLOW_SUCTION !== '') {
    parts.push('BLOW=' + macros.MLS_BLOW_SUCTION);
  }
  if (isCustomerShown(macros.CUSTOMER_SET)) {
    parts.push('CUST=' + shortCustomerLabel(macros.CUSTOMER_SET));
  }
  if (isGroupMachineShown(macros.GROUP_MACHINE)) {
    parts.push('GRP=' + shortGroupMachineLabel(macros.GROUP_MACHINE));
  }
  return parts.join(' | ');
}

module.exports = {
  findYtVersion,
  findClangdConfig,
  parseClangdCompileDefines,
  getClangdText,
  parseFullMacroTable,
  loadMacroTable,
  invalidateMacroTable,
  getMacroTable,
  isMacroEnvReady,
  evalPpExpr,
  getYtVersionText,
  revealMacroInYtVersion,
  isTrackedMacro,
  isMacroKeyShown,
  machineLabel,
  machineFingerprint,
  formatMacroLines,
  listedMacroNames,
  formatMacroBadge
};
