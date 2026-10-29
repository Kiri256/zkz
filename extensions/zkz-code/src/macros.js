'use strict';
/**
 * yt_version.h 有效宏解析（纯 JS）。扩展内不再 spawn python。
 */
const fs = require('fs');
const path = require('path');
const loadShared = require('./load_shared');
const { evalPpExpr, evalPpExprResult } = require('./pp_expr');

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

function isTrackedMacro(name) {
  return loadMacroKeys().includes(name)
    || name.startsWith('MALL_')
    || name.startsWith('MLS_')
    || name.startsWith('MDJ_')
    || name.startsWith('MHX_');
}

const YT_VERSION_RELS = [
  path.join('core', 'core_common', 'yt_version.h'),
  path.join('User', 'common', 'yt_version.h'),
  path.join('core', 'yt_version.h')
];

function ytVersionCandidates(root) {
  if (!root) return [];
  const out = [];
  for (let i = 0; i < YT_VERSION_RELS.length; i++) {
    const p = path.join(root, YT_VERSION_RELS[i]);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

function findYtVersion(root) {
  const all = ytVersionCandidates(root);
  return all.length ? all[0] : null;
}

function isYtVersionPath(root, fsPath) {
  if (!root || !fsPath) return false;
  const rel = path.relative(root, fsPath);
  if (!rel || rel.startsWith('..')) return false;
  const norm = path.normalize(rel).toLowerCase();
  for (let i = 0; i < YT_VERSION_RELS.length; i++) {
    if (path.normalize(YT_VERSION_RELS[i]).toLowerCase() === norm) return true;
  }
  return false;
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
    if (/^\S/.test(raw)) {
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
    const flag = stripYamlFlag(m[1].trim());
    if (!flag) continue;
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

/** 去掉 YAML 行尾注释和一层引号。`#` 只有在引号外且前面是空白时才算注释。 */
function stripYamlFlag(flag) {
  let out = '';
  let q = '';
  for (let i = 0; i < flag.length; i++) {
    const c = flag[i];
    if (q) {
      out += c;
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      out += c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(flag[i - 1]))) break;
    out += c;
  }
  out = out.trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  return out;
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
    const startLi = li;
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
      if (!parent) {
        stack.push({ active: false, seenTrue: false, bad: false });
      } else {
        const r = evalPpExprResult(expr, macros);
        // 解析失败不能当成假，否则 #else 会吃进不该生效的宏
        stack.push(r.ok
          ? { active: r.value, seenTrue: r.value, bad: false }
          : { active: false, seenTrue: false, bad: true });
      }
      li += 1;
      continue;
    }
    if (/^ifdef\b/.test(body)) {
      const name = body.replace(/^ifdef\b/, '').trim().split(/\s+/)[0];
      const parent = effectiveActive();
      const val = parent && (name in macros);
      stack.push({ active: !!val, seenTrue: !!val, bad: false });
      li += 1;
      continue;
    }
    if (/^ifndef\b/.test(body)) {
      const name = body.replace(/^ifndef\b/, '').trim().split(/\s+/)[0];
      const parent = effectiveActive();
      const val = parent && !(name in macros);
      stack.push({ active: !!val, seenTrue: !!val, bad: false });
      li += 1;
      continue;
    }
    if (/^elif\b/.test(body)) {
      if (stack.length) {
        const top = stack[stack.length - 1];
        const parent = stack.slice(0, -1).every((f) => f.active);
        if (!parent || top.seenTrue || top.bad) {
          top.active = false;
        } else {
          const expr = body.replace(/^elif\b/, '').trim();
          const r = evalPpExprResult(expr, macros);
          if (!r.ok) {
            top.active = false;
            top.bad = true;
          } else {
            top.active = r.value;
            if (r.value) top.seenTrue = true;
          }
        }
      }
      li += 1;
      continue;
    }
    if (/^else\b/.test(body)) {
      if (stack.length) {
        const top = stack[stack.length - 1];
        const parent = stack.slice(0, -1).every((f) => f.active);
        top.active = parent && !top.seenTrue && !top.bad;
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
    locs[name] = startLi + 1;
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
  const { bufferToText } = require('./encoding');
  return bufferToText(fs.readFileSync(filePath));
}

function inferWorkspaceRoot(filePath) {
  const { findProjectRoot } = loadShared('project_root');
  try {
    const vscode = vscodeApi();
    const folders = (vscode && vscode.workspace && vscode.workspace.workspaceFolders) || [];
    if (folders.length) {
      const found = findProjectRoot(folders.map(function (f) { return f.uri.fsPath; }), filePath || '');
      if (found) return found;
    }
  } catch (_) { /* ignore */ }
  if (!filePath) return '';
  return findProjectRoot([filePath], filePath);
}

/**
 * 宏表唯一 root：与 native、keil 同一套认根。单槽缓存只在换根时换表。
 */
function resolveMacroRoot(filePath) {
  try {
    const pair = loadShared('pair').resolvePair(filePath || '');
    if (pair && pair.root) return pair.root;
  } catch (_) { /* 未打开工作区时再按文件向上找 */ }
  return inferWorkspaceRoot(filePath || '');
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

/** 单槽缓存。调用方共用 resolveMacroRoot 后，root 不再来回变、缓存不再抖动。
 * @type {{ key: string, macros: Object<string,string>, locs: Object<string,number>, ready: boolean, filePath: string }}
 */
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
  const root = opts.workspaceRoot || resolveMacroRoot(opts.filePath || '');
  const ver = opts.filePath || (root ? findYtVersion(root) : null);
  if (!ver && opts.text == null) {
    gTableCache = emptyMacroTable();
    return gTableCache;
  }
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
  const keys = loadMacroKeys();
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
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
  const listed = {};
  const names = listedMacroNames(macros);
  for (let i = 0; i < names.length; i++) listed[names[i]] = true;
  if (listed.SCREEN_800_480) parts.push('SCR=' + macros.SCREEN_800_480);
  if (listed.MALL_DOUBLE) parts.push('DBL=' + macros.MALL_DOUBLE);
  if (listed.MLS_BLOW_SUCTION) parts.push('BLOW=' + macros.MLS_BLOW_SUCTION);
  if (listed.CUSTOMER_SET) parts.push('CUST=' + shortCustomerLabel(macros.CUSTOMER_SET));
  if (listed.GROUP_MACHINE) parts.push('GRP=' + shortGroupMachineLabel(macros.GROUP_MACHINE));
  return parts.join(' | ');
}

module.exports = {
  findYtVersion,
  ytVersionCandidates,
  isYtVersionPath,
  findClangdConfig,
  resolveMacroRoot,
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
  formatMacroLines,
  listedMacroNames,
  formatMacroBadge
};
