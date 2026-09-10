'use strict';
/**
 * yt_version.h 鏈夋晥瀹忚В鏋愶紙绾? JS锛岄€昏緫瀵归綈 scripts/yt_version_macros.py锛夈€?
 * 鎵╁睍鍐呬笉鍐? spawn python銆?
 */
const fs = require('fs');
const path = require('path');

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

function getClangdText(filePath) {
  try {
    const vscode = vscodeApi();
    if (vscode && vscode.workspace) {
      const want = path.resolve(filePath);
      for (const d of vscode.workspace.textDocuments) {
        if (d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === want) return d.getText();
      }
    }
  } catch (_) { /* ignore */ }
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

function parseMacroEnvFromText(text, initialMacros) {
  return parseFullMacroTable(text, initialMacros).macros;
}

function parseMacrosFromText(text, initialMacros) {
  return parseFullMacroTable(text, initialMacros);
}

/**
 * Evaluate preprocessor condition with given macro env.
 * @param {string} expr
 * @param {Object<string,string>} macros
 * @returns {boolean}
 */
function evalPpExpr(expr, macros) {
  const env = macros || {};
  const evalExpr = (e0, depth) => {
    if (depth > 32) return 0;
    let e = String(e0 || '');
    e = e.replace(/\/\*.*?\*\//g, ' ');
    e = e.replace(/\/\/.*$/, '').trim();
    if (!e) return 0;
    e = e.replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, n) => ((n in env) ? '1' : '0'));
    e = e.replace(/defined\s+([A-Za-z_]\w*)/g, (_, n) => ((n in env) ? '1' : '0'));
    /** @type {{ t: string, v: string }[]} */
    const tokens = [];
    const re = /\s+|([A-Za-z_]\w*)|(-?\d+)|(==|!=|<=|>=|&&|\|\||!|[()+\-*/%<>])/g;
    let m;
    while ((m = re.exec(e)) !== null) {
      if (m[1] != null) tokens.push({ t: 'id', v: m[1] });
      else if (m[2] != null) tokens.push({ t: 'num', v: m[2] });
      else if (m[3] != null) tokens.push({ t: 'op', v: m[3] });
    }
    let i = 0;
    const peek = () => (i < tokens.length ? tokens[i] : null);
    const take = () => tokens[i++];
    const expandId = (name) => {
      if (!(name in env)) return 0;
      const v = env[name];
      if (v === '' || v == null) return 1;
      const s = String(v).trim();
      if (/^-?\d+$/.test(s)) return parseInt(s, 10);
      if (/^\(\s*-?\d+\s*\)$/.test(s)) return parseInt(s.replace(/[()]/g, '').trim(), 10);
      return evalExpr(s, depth + 1);
    };
    const parsePrimary = () => {
      const p = peek();
      if (!p) return 0;
      if (p.t === 'num') { take(); return parseInt(p.v, 10); }
      if (p.t === 'id') { take(); return expandId(p.v); }
      if (p.t === 'op' && p.v === '(') {
        take();
        const v = parseOr();
        if (peek() && peek().t === 'op' && peek().v === ')') take();
        return v;
      }
      if (p.t === 'op' && p.v === '!') { take(); return parsePrimary() ? 0 : 1; }
      if (p.t === 'op' && p.v === '-') { take(); return -parsePrimary(); }
      take();
      return 0;
    };
    const parseRel = () => {
      let left = parsePrimary();
      while (peek() && peek().t === 'op' && ['==', '!=', '<=', '>=', '<', '>'].includes(peek().v)) {
        const op = take().v;
        const right = parsePrimary();
        if (op === '==') left = left === right ? 1 : 0;
        else if (op === '!=') left = left !== right ? 1 : 0;
        else if (op === '<=') left = left <= right ? 1 : 0;
        else if (op === '>=') left = left >= right ? 1 : 0;
        else if (op === '<') left = left < right ? 1 : 0;
        else if (op === '>') left = left > right ? 1 : 0;
      }
      return left;
    };
    const parseAnd = () => {
      let left = parseRel();
      while (peek() && peek().t === 'op' && peek().v === '&&') {
        take();
        left = (left && parseRel()) ? 1 : 0;
      }
      return left;
    };
    const parseOr = () => {
      let left = parseAnd();
      while (peek() && peek().t === 'op' && peek().v === '||') {
        take();
        left = (left || parseAnd()) ? 1 : 0;
      }
      return left;
    };
    // 必须返回数值本身。别名宏（GROUP_MACHINE -> GROUP_MACHINE_COMSTOM_9001 -> 9001）
    // 若收成 0/1，则 GROUP_MACHINE == GROUP_MACHINE_COMSTOM_9001 会变成 1 == 9001。
    try { return parseOr(); } catch (_) { return 0; }
  };
  return !!evalExpr(expr, 0);
}

function macroTextHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return 'h:' + (h >>> 0) + ':' + text.length;
}

/** 鍚屾?ヨВ鏋愶紙绾? JS锛屾??绉掔骇锛夛紱淇濈暀 Async 鍚嶄互鍏煎?规棫璋冪敤 */
function getYtVersionText(filePath) {
  try {
    const vscode = vscodeApi();
    if (vscode && vscode.workspace) {
      const want = path.resolve(filePath);
      for (const d of vscode.workspace.textDocuments) {
        if (d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === want) return d.getText();
      }
    }
  } catch (_) { /* ignore */ }
  // W1 澶氫负 GBK锛氭寜鍐呭?规帰娴嬬紪鐮侊紝閬垮厤褰? UTF-8 璇诲潖
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

function loadClangdLayer(workspaceRoot) {
  const cfg = findClangdConfig(workspaceRoot);
  if (!cfg) return { macros: {}, stamp: '' };
  const text = getClangdText(cfg);
  return {
    macros: parseClangdCompileDefines(text),
    stamp: cfg + '|' + macroTextHash(text)
  };
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
  const text = opts.text != null ? String(opts.text) : getYtVersionText(ver);
  const clangd = loadClangdLayer(root);
  const key = (ver || '') + '|' + macroTextHash(text) + '|' + clangd.stamp;
  if (gTableCache.key === key && gTableCache.ready) return gTableCache;
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

function parseMacrosFromTextAsync(text, opts) {
  const table = loadMacroTable({
    text: String(text || ''),
    workspaceRoot: opts && opts.workspaceRoot,
    filePath: opts && opts.filePath
  });
  return Promise.resolve({ macros: table.macros, locs: table.locs });
}

async function parseMacrosDetailed(filePath) {
  const table = loadMacroTable({
    filePath,
    workspaceRoot: inferWorkspaceRoot(filePath)
  });
  return { macros: table.macros, locs: table.locs };
}

async function parseMacros(filePath) {
  return (await parseMacrosDetailed(filePath)).macros;
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

function formatMacroLines(macros) {
  return Object.keys(macros).sort().filter((k) => isTrackedMacro(k) && isMacroKeyShown(k, macros[k])).map((k) => {
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
  parseMacrosFromText,
  parseMacrosFromTextAsync,
  parseMacrosDetailed,
  parseMacros,
  parseMacroEnvFromText,
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
  formatMacroBadge
};
