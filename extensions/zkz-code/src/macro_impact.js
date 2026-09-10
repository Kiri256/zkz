'use strict';
/**
 * 宏变更影响面：记录变化宏 → 展开派生宏 → 检索引用文件 → 按 basename 删除 clangd *.idx。
 * MACHINE_VALUE 等会派生 Machine_DJ/LS/HX；业务代码多判 Machine_*，不能只搜叶子宏名。
 * 说明：按叶子名匹配分片（foo.c.*.idx），同名文件可能多删；仍不能覆盖「仅 include 却未写宏名」的 TU。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const vscode = require('vscode');
const { log } = require('./util');
const { loadWorkspaceLists } = require('./lists');

function scanTops() {
  const tops = loadWorkspaceLists().scanTops;
  return (tops && tops.length) ? tops : ['core', 'application', 'driver'];
}

/** 这些种子变化时，Machine_* 有效值几乎必变 */
const MACHINE_SEED_MACROS = new Set([
  'MACHINE_VALUE',
  'SCREEN_800_480',
  'MALL_MULTI',
  'MALL_DOUBLE'
]);

/** yt_version.h 第 7 部分常见机型判断宏（业务侧大量 #if） */
const MACHINE_DERIVED = [
  'Machine_DJ',
  'Machine_LS',
  'Machine_HX',
  'Machine_M_DJ',
  'Machine_M_HX',
  'Machine_N_DJ',
  'Machine_N_HX',
  'Machine_LS_NOT_MULTI',
  'Machine_HX_NOT_MULTI'
];

function diffMacroValues(prev, next) {
  const a = prev || {};
  const b = next || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const k of keys) {
    const av = a[k] == null ? '' : String(a[k]);
    const bv = b[k] == null ? '' : String(b[k]);
    if (av !== bv) changed.push(k);
  }
  changed.sort();
  return changed;
}

function clangdIndexDir(workspaceRoot) {
  return path.join(workspaceRoot, '.cache', 'clangd', 'index');
}

/** idx 名: leaf.ext.HEX.idx → leaf.ext */
function shardSourceBaseName(fileName) {
  if (!fileName || !fileName.endsWith('.idx')) return null;
  const noIdx = fileName.slice(0, -4);
  const dot = noIdx.lastIndexOf('.');
  if (dot <= 0) return null;
  const hex = noIdx.slice(dot + 1);
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return null;
  return noIdx.slice(0, dot);
}

function addYtVersionPaths(workspaceRoot, found) {
  for (const rel of [
    path.join('core', 'core_common', 'yt_version.h'),
    path.join('User', 'common', 'yt_version.h'),
    path.join('core', 'yt_version.h')
  ]) {
    const abs = path.join(workspaceRoot, rel);
    if (fs.existsSync(abs)) found.add(path.resolve(abs));
  }
}

function readYtVersionText(workspaceRoot) {
  for (const rel of [
    path.join('core', 'core_common', 'yt_version.h'),
    path.join('User', 'common', 'yt_version.h'),
    path.join('core', 'yt_version.h')
  ]) {
    const abs = path.join(workspaceRoot, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      if (vscode.workspace) {
        const want = path.resolve(abs);
        for (const d of vscode.workspace.textDocuments) {
          if (d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === want) {
            return d.getText();
          }
        }
      }
    } catch (_) { /* ignore */ }
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch (_) { /* ignore */ }
  }
  return '';
}

/**
 * 把「变化宏」扩成「业务侧实际会写的宏名」。
 * - MACHINE_VALUE 等 → Machine_DJ / Machine_LS / ...
 * - 再扫 yt_version.h：RHS 引用了已有种子的 #define 一并纳入（多轮）
 */
function expandSearchMacroNames(seedNames, ytText) {
  const out = new Set((seedNames || []).filter(Boolean));
  let needMachine = false;
  for (const n of out) {
    if (MACHINE_SEED_MACROS.has(n) || String(n).startsWith('Machine_')) {
      needMachine = true;
      break;
    }
  }
  if (needMachine) {
    for (const d of MACHINE_DERIVED) out.add(d);
  }

  if (!ytText) return [...out].sort();

  let grew = true;
  for (let round = 0; grew && round < 4; round++) {
    grew = false;
    const seeds = [...out];
    const lines = String(ytText).split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      let line = lines[li];
      while (/\\\s*$/.test(line) && li + 1 < lines.length) {
        li += 1;
        line = line.replace(/\\\s*$/, '') + lines[li];
      }
      const trim = line.trim();
      if (!trim.startsWith('#')) continue;
      const body = trim.replace(/^#\s*/, '');
      const m = body.match(/^define\s+([A-Za-z_]\w*)\s+(.+)$/);
      if (!m) continue;
      const name = m[1];
      if (out.has(name)) continue;
      let rhs = m[2];
      rhs = rhs.replace(/\/\*.*?\*\//g, ' ');
      rhs = rhs.replace(/\/\/.*$/, '');
      for (const s of seeds) {
        if (!s || s.length < 2) continue;
        const re = new RegExp('\\b' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        if (re.test(rhs)) {
          out.add(name);
          grew = true;
          break;
        }
      }
    }
  }
  return [...out].sort();
}

/** PATH 上常无 rg；优先用 Cursor/VS Code 自带的 @vscode/ripgrep */
function resolveRgExe() {
  const bin = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [];
  try {
    if (vscode.env && vscode.env.appRoot) {
      candidates.push(path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', bin));
    }
  } catch (_) { /* ignore */ }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'cursor', 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', bin));
    candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', bin));
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    const r = spawnSync('rg', ['--version'], { windowsHide: true, encoding: 'utf8' });
    if (r && r.status === 0) return 'rg';
  } catch (_) { /* ignore */ }
  return null;
}

/** 优先 rg；失败再用 workspace.findTextInFiles */
function findWithRg(workspaceRoot, pattern) {
  const found = new Set();
  const rgExe = resolveRgExe();
  if (!rgExe) return found;

  const args = [
    '-l', '--no-messages', '-0',
    '--glob', '*.{c,h,cpp,hpp,cc,hh}',
    '-e', pattern
  ];
  let hasRoot = false;
  for (const top of scanTops()) {
    const absTop = path.join(workspaceRoot, top);
    if (fs.existsSync(absTop)) {
      args.push(absTop);
      hasRoot = true;
    }
  }
  if (!hasRoot) return found;
  try {
    const r = spawnSync(rgExe, args, {
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 20 * 1024 * 1024
    });
    const out = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout || '');
    if (!out.length) return found;
    for (const chunk of out.toString('utf8').split('\0')) {
      const p = String(chunk || '').trim();
      if (p) found.add(path.resolve(p));
    }
  } catch (_) { /* rg 不可用 */ }
  return found;
}

/**
 * 在沙箱内检索引用了变化宏（含派生）的文件（限 core/application/driver）。
 * @returns {Promise<string[]>} 绝对路径
 */
async function findFilesReferencingMacros(workspaceRoot, macroNames) {
  const ytText = readYtVersionText(workspaceRoot);
  const names = expandSearchMacroNames(macroNames, ytText);
  const found = new Set();
  addYtVersionPaths(workspaceRoot, found);
  if (!names.length) return [...found].sort((a, b) => a.localeCompare(b));

  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = '\\b(' + escaped.join('|') + ')\\b';

  const rgHits = findWithRg(workspaceRoot, pattern);
  for (const p of rgHits) found.add(p);

  if (rgHits.size === 0 && typeof vscode.workspace.findTextInFiles === 'function') {
    await new Promise((resolve) => {
      try {
        const p = vscode.workspace.findTextInFiles(
          { pattern, isRegExp: true },
          {
            include: '{core,application,driver}/**/*.{c,h,cpp,hpp,cc,hh}',
            useIgnoreFiles: true,
            maxResults: 2000
          },
          (result) => {
            if (result && result.uri && result.uri.fsPath) found.add(path.resolve(result.uri.fsPath));
          }
        );
        Promise.resolve(p).then(() => resolve(), () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * 删除 index 目录中 basename 命中的 *.idx。
 * @returns {{ removed: number, bases: string[] }}
 */
function removeClangdIdxForFiles(workspaceRoot, absFiles) {
  const indexDir = clangdIndexDir(workspaceRoot);
  const bases = new Set();
  for (const f of absFiles || []) {
    if (f) bases.add(path.basename(f));
  }
  bases.add('yt_version.h');
  if (!fs.existsSync(indexDir)) {
    return { removed: 0, bases: [...bases], indexDir };
  }
  let removed = 0;
  for (const ent of fs.readdirSync(indexDir)) {
    const base = shardSourceBaseName(ent);
    if (!base || !bases.has(base)) continue;
    try {
      fs.unlinkSync(path.join(indexDir, ent));
      removed++;
    } catch (e) {
      log('remove idx fail: ' + ent + ' ' + (e && e.message ? e.message : e));
    }
  }
  return { removed, bases: [...bases].sort(), indexDir };
}

async function restartClangdSoft() {
  for (const cmd of ['clangd.restart', 'clangd.restartLanguageServer']) {
    try {
      await vscode.commands.executeCommand(cmd);
      return true;
    } catch (_) { /* try next */ }
  }
  return false;
}

/**
 * 完整流水线：变化宏 → 展开派生 → 检索 → 删 idx → 软重启 clangd。
 */
async function invalidateIndexForMacroChanges(workspaceRoot, changedMacros) {
  const seeds = (changedMacros || []).filter(Boolean);
  if (!seeds.length) {
    return { changedMacros: [], searchMacros: [], files: [], removed: 0, restarted: false };
  }
  const ytText = readYtVersionText(workspaceRoot);
  const searchMacros = expandSearchMacroNames(seeds, ytText);
  const files = await findFilesReferencingMacros(workspaceRoot, seeds);
  const { removed, bases, indexDir } = removeClangdIdxForFiles(workspaceRoot, files);
  const restarted = await restartClangdSoft();
  log(
    'macro impact: seeds=' + seeds.join(',') +
    ' search=' + searchMacros.join(',') +
    ' files=' + files.length +
    ' idxRemoved=' + removed +
    ' bases=' + bases.length +
    ' indexDir=' + indexDir
  );
  return {
    changedMacros: seeds,
    searchMacros,
    files,
    removed,
    restarted,
    bases,
    indexDir
  };
}

module.exports = {
  diffMacroValues,
  expandSearchMacroNames,
  findFilesReferencingMacros,
  removeClangdIdxForFiles,
  invalidateIndexForMacroChanges,
  clangdIndexDir,
  shardSourceBaseName,
  resolveRgExe
};
