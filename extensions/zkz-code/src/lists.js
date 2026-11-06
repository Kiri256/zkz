'use strict';

const fs = require('fs');
const path = require('path');
const loadShared = require('./load_shared');

const BUNDLED_PATH = path.join(__dirname, 'workspace_lists.json');

const FALLBACK = {
  syncAll: false,
  verifyAll: false,
  libraryDirNames: ['Libraries', 'FreeRTOS', 'Modbus_zlg', 'FPU_DSP', 'RL-ARM', 'emWin', 'fatfs', 'USB'],
  skipTopDirNames: ['.git', '.svn', '.hg', 'Project', '.vscode', '.cursor', '.codex', '.claude', '.continue', '.windsurf', '.idea', '.vs', '.cache', '.clangd', '.clangd-index', '.clangd-cache', 'ai_dialog', 'tools', 'zkz', 'pc_other', 'node_modules', '__pycache__'],
  skipTopFileNames: ['compile_commands.json', '.clangd', '.clang-format', '.clang-tidy', '.gitignore', '.gitattributes', '.editorconfig', 'AGENTS.md', 'CLAUDE.md', 'encoding-table.json', 'output.hex'],
  textExtensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx'],
  excludeDirNames: ['.git', '.svn', '.hg', '.vscode', '.cursor', '.codex', '.claude', '.continue', '.windsurf', '.idea', '.vs', '.cache', '.clangd', '.clangd-index', '.clangd-cache', 'Flash', 'Obj', 'Listings', 'DebugConfig', 'node_modules', '__pycache__', 'ai_dialog', 'tools', '.zkz'],
  excludeFileNames: ['JLinkLog.txt', 'JLinkSettings.ini', 'build_output.txt', 'flash_output.txt'],
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

function workspaceListsRoot() {
  try {
    const pair = loadShared('pair').resolvePair();
    return pair.root || null;
  } catch (_) {
    return null;
  }
}

/** 读 settings.json 的 lists。没有这项返回 null。扩展宿主调用。 */
function settingsLists(root) {
  if (!root) return null;
  try {
    const cur = loadShared('zkz_settings').load(root);
    const lists = cur && cur.lists;
    if (!lists || typeof lists !== 'object' || Array.isArray(lists)) return null;
    return lists;
  } catch (_) {
    return null;
  }
}

/** 合并内置名单和 settings.json 的 lists。返回合并后的对象。扩展宿主调用。 */
function loadWorkspaceLists() {
  const root = workspaceListsRoot();
  const settingsPath = root ? path.join(root, '.zkz', 'settings.json') : '';
  const key = fileStamp(settingsPath) + '|' + fileStamp(BUNDLED_PATH);
  if (cached.data && cached.key === key) return cached.data;
  const overlay = settingsLists(root) || {};
  let bundled = {};
  try {
    if (fs.existsSync(BUNDLED_PATH)) bundled = readListsFile(BUNDLED_PATH) || {};
  } catch (_) { bundled = {}; }
  const data = Object.assign({}, FALLBACK, bundled, overlay);
  cached = { key: key, data: data };
  return data;
}

module.exports = {
  loadWorkspaceLists
};
