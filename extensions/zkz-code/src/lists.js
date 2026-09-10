'use strict';

const fs = require('fs');
const path = require('path');

const BUNDLED_PATH = path.join(__dirname, 'workspace_lists.json');
const REL_JSON = path.join('.zkz', 'workspace_lists.json');
const REL_JSONC = path.join('.zkz', 'workspace_lists.jsonc');

const FALLBACK = {
  libraryDirNames: ['Libraries', 'FreeRTOS', 'Modbus_zlg', 'FPU_DSP', 'RL-ARM', 'emWin'],
  skipTopDirNames: ['.git', '.svn', '.hg', 'Project', '.vscode', '.cursor', '.codex', '.claude', '.continue', '.windsurf', '.idea', '.vs', '.cache', '.clangd', '.clangd-index', '.clangd-cache', 'ai_dialog', 'tools', 'zkz', 'pc_other', 'node_modules', '__pycache__'],
  skipTopFileNames: ['compile_commands.json', '.clangd', '.clang-format', '.clang-tidy', '.gitignore', '.gitattributes', '.editorconfig', 'AGENTS.md', 'CLAUDE.md', '.workspace_sync_meta.json', '.workspace_source_stamps.json', '.workspace_dest_stamps.json', '.workspace_source_encodings.json', 'output.hex'],
  textExtensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx'],
  excludeDirNames: ['.git', '.svn', '.hg', '.vscode', '.cursor', '.codex', '.claude', '.continue', '.windsurf', '.idea', '.vs', '.cache', '.clangd', '.clangd-index', '.clangd-cache', 'Flash', 'Obj', 'Listings', 'DebugConfig', 'node_modules', '__pycache__', 'ai_dialog', 'tools', '.zkz'],
  excludeFileNames: ['JLinkLog.txt', 'JLinkSettings.ini', 'build_output.txt', 'flash_output.txt'],
  fffdSkipTop: ['libraries', 'freertos', 'emwin', 'modbus_zlg', 'fpu_dsp', 'rl-arm', 'fpga_motion', 'project', '.git', 'node_modules'],
  fffdTextExtensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx', '.md', '.json', '.txt'],
  scanTops: ['core', 'application', 'driver', 'User', 'emWin'],
  macroKeys: ['MACHINE_VALUE', 'SCREEN_800_480', 'MALL_DOUBLE', 'MALL_MULTI', 'MALL_EXPAND_AXIS', 'MALL_EXPAND_IO', 'CUSTOMER_SET', 'GROUP_MACHINE', 'MLS_BLOW_SUCTION', 'MLS_610']
};

let cached = { key: '', data: null };

function stripJsonc(text) {
  let t = String(text || '');
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  t = t.replace(/^\s*\/\/.*$/gm, '');
  t = t.replace(/\s+\/\/.*$/gm, '');
  t = t.replace(/,(\s*[}\]])/g, '$1');
  return t.trim();
}

function fileStamp(p) {
  try {
    const st = fs.statSync(p);
    return p + '|' + st.mtimeMs + '|' + st.size;
  } catch (_) {
    return p + '|missing';
  }
}

function readListsFile(p) {
  return JSON.parse(stripJsonc(fs.readFileSync(p, 'utf8')));
}

function sandboxRoot() {
  try {
    const pair = require('./pair').resolvePair();
    return pair.sandbox || null;
  } catch (_) {
    return null;
  }
}

function findWorkspaceListsFile() {
  const root = sandboxRoot();
  if (!root) return null;
  const json = path.join(root, REL_JSON);
  const jsonc = path.join(root, REL_JSONC);
  if (fs.existsSync(json) && fs.statSync(json).isFile()) return json;
  if (fs.existsSync(jsonc) && fs.statSync(jsonc).isFile()) return jsonc;
  return null;
}

function seedWorkspaceLists() {
  const existing = findWorkspaceListsFile();
  if (existing) return existing;
  const destRoot = sandboxRoot();
  if (!destRoot) return null;
  const zkzDir = path.join(destRoot, '.zkz');
  if (!fs.existsSync(zkzDir) || !fs.statSync(zkzDir).isDirectory()) return null;
  const dest = path.join(zkzDir, 'workspace_lists.json');
  if (fs.existsSync(dest)) return dest;
  try {
    if (fs.existsSync(BUNDLED_PATH)) fs.copyFileSync(BUNDLED_PATH, dest);
    else fs.writeFileSync(dest, JSON.stringify(FALLBACK, null, 2), 'utf8');
    return dest;
  } catch (_) {
    return null;
  }
}

function listsFilePath() {
  return findWorkspaceListsFile() || BUNDLED_PATH;
}

function loadWorkspaceLists() {
  const used = findWorkspaceListsFile() || seedWorkspaceLists() || BUNDLED_PATH;
  const key = fileStamp(used) + '|' + fileStamp(BUNDLED_PATH);
  if (cached.data && cached.key === key) return cached.data;
  let overlay = {};
  try {
    if (used && fs.existsSync(used)) overlay = readListsFile(used) || {};
  } catch (_) { overlay = {}; }
  let bundled = {};
  try {
    if (fs.existsSync(BUNDLED_PATH)) bundled = readListsFile(BUNDLED_PATH) || {};
  } catch (_) { bundled = {}; }
  const data = Object.assign({}, FALLBACK, bundled, overlay);
  cached = { key: key, data: data };
  return data;
}

module.exports = {
  LISTS_PATH: BUNDLED_PATH,
  loadWorkspaceLists,
  listsFilePath,
  findWorkspaceListsFile
};
