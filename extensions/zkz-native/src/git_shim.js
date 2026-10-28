'use strict';

// 编译并配置 git.exe 替身。替身放在扩展目录，不放进仓库。
// 切分支、拉取、合并、变基、拣选、还原，以及 reset 的 --hard、--merge、--keep 时，
// 它先让 Git 看到没改过，跑完再把副本写回。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WRAP = { checkout: 1, switch: 1, merge: 1, pull: 1, rebase: 1, 'cherry-pick': 1, revert: 1 };

function parseGitInvocation(argv) {
  const args = argv || [];
  let cdir = '';
  let command = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      if (!command && args[i + 1]) return { cdir: cdir, command: args[i + 1], index: i + 1 };
      break;
    }
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace' || a === '--super-prefix' || a === '--config-env') {
      if (a === '-C') cdir = args[i + 1] || '';
      i++;
      continue;
    }
    if (a.indexOf('--git-dir=') === 0 || a.indexOf('--work-tree=') === 0 || a.indexOf('--namespace=') === 0 || a.indexOf('--config-env=') === 0 || a.indexOf('--exec-path=') === 0) {
      continue;
    }
    if (a.indexOf('-C') === 0 && a.length > 2) {
      cdir = a.slice(2);
      continue;
    }
    if (a === '--exec-path') {
      if (args[i + 1] && args[i + 1].charAt(0) !== '-') i++;
      continue;
    }
    if (a.charAt(0) === '-') continue;
    command = a;
    return { cdir: cdir, command: command, index: i };
  }
  return { cdir: cdir, command: command, index: -1 };
}

function wrapsCommand(command) {
  return !!WRAP[command];
}

// 和替身里的判断一致。reset 只在会改工作区的三档上拦截。
function wrapsInvocation(argv) {
  const parsed = parseGitInvocation(argv);
  if (WRAP[parsed.command]) return true;
  if (parsed.command !== 'reset' || parsed.index < 0) return false;
  const args = argv || [];
  for (let i = parsed.index + 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a === '--hard' || a === '--merge' || a === '--keep') return true;
  }
  return false;
}

function slashPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

// 已安装扩展目录里的替身。升级后版本号会变，旧路径也算。
function isShimGitExe(p) {
  return /\/zkz\.zkz-native-[^/]+\/bin\/git\.exe$/i.test(slashPath(p));
}

function isShimBin(p) {
  return /\/zkz\.zkz-native-[^/]+\/bin$/i.test(slashPath(p));
}

function shimExePath(extensionRoot) {
  return path.join(extensionRoot, 'bin', 'git.exe');
}

function cscPath() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  throw new Error('找不到 csc.exe，无法编译 git 替身');
}

function findRealGit(shimExe) {
  const env = process.env.ZKZ_REAL_GIT;
  if (env && fs.existsSync(env)) {
    if (!shimExe || path.resolve(env).toLowerCase() !== path.resolve(shimExe).toLowerCase()) {
      return path.resolve(env);
    }
  }
  const r = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (!fs.existsSync(lines[i])) continue;
    if (shimExe && path.resolve(lines[i]).toLowerCase() === path.resolve(shimExe).toLowerCase()) continue;
    return path.resolve(lines[i]);
  }
  throw new Error('找不到真正的 git.exe');
}

function ensureGitShim(extensionRoot) {
  const cs = path.join(extensionRoot, 'src', 'git_shim.cs');
  const exe = shimExePath(extensionRoot);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  let stale = !fs.existsSync(exe);
  if (!stale) stale = fs.statSync(cs).mtimeMs > fs.statSync(exe).mtimeMs;
  if (stale) {
    const r = spawnSync(cscPath(), ['/nologo', '/optimize+', '/codepage:65001', '/out:' + exe, cs], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (!r || r.status !== 0) {
      throw new Error('编译 git 替身失败 ' + String((r && (r.stderr || r.stdout)) || ''));
    }
  }
  const spec = {
    node: require('./git_config').nodeBin(),
    script: path.join(extensionRoot, 'src', 'local_filter.js').replace(/\\/g, '/'),
    realGit: findRealGit(exe).replace(/\\/g, '/')
  };
  const body = JSON.stringify(spec);
  const jsonPath = path.join(extensionRoot, 'bin', 'git-shim.json');
  let prev = '';
  try { prev = fs.readFileSync(jsonPath, 'utf8'); } catch (_) { prev = ''; }
  if (prev.replace(/\s+/g, '') !== body) fs.writeFileSync(jsonPath, body, 'utf8');
  return exe;
}

module.exports = {
  parseGitInvocation,
  wrapsCommand,
  wrapsInvocation,
  isShimGitExe,
  isShimBin,
  shimExePath,
  ensureGitShim,
  findRealGit
};
