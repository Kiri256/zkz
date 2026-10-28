'use strict';

// 本地配置。已跟踪路径打 skip-worktree，更改里不出现工作区修改。
// 替身在一次切换开始时把清单路径改名挪进 .zkz/local，结束后删掉 Git 写出来的再挪回来。改名失败才逐个复制。
// 提交前把索引收回 HEAD 的 blob，不改工作区。

const fs = require('fs');
const path = require('path');
const { slashRel, localKeepRoot, runDir, atomicWriteFile } = require('./paths');
const { git, gitConfigGet } = require('./git_exec');

// 源码树里在 extensions/shared，装进扩展后在 src/shared。记不上不影响切换。
function recordPerf(root, phase, fields) {
  try {
    let perf = null;
    try { perf = require('../../shared/perf'); }
    catch (_) { perf = require('./shared/perf'); }
    perf.record(root, phase, fields);
  } catch (_) { /* 性能日志失败不挡切换 */ }
}

function shimCommand(argv) {
  try {
    const { parseGitInvocation } = require('./git_shim');
    return parseGitInvocation(argv || []).command || '';
  } catch (_) { return ''; }
}

const LOCAL_FLAG = 'zkz.localconfig';

function worktreeFile(repoRoot, rel) {
  return path.join(repoRoot, ...slashRel(rel).split('/'));
}

function keepFile(repoRoot, rel) {
  return path.join(localKeepRoot(repoRoot), ...slashRel(rel).split('/'));
}

function localList(repoRoot) {
  const { loadConfigPaths } = require('./config_paths');
  return loadConfigPaths(repoRoot).overlay || [];
}

function onLocalList(rel, list) {
  const { matchesPrefix } = require('./config_paths');
  return matchesPrefix(rel, list || []);
}

// 这次切换的临时副本。命令结束就删。
function saveLocalKeep(repoRoot, rel, bytes) {
  const relPath = slashRel(rel);
  if (!repoRoot || !relPath || relPath.indexOf('..') >= 0) return;
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  atomicWriteFile(keepFile(repoRoot, relPath), data);
}

function readLocalKeep(repoRoot, rel) {
  try { return fs.readFileSync(keepFile(repoRoot, rel)); }
  catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

function trackedLocalFiles(repoRoot) {
  const list = localList(repoRoot);
  if (!list.length) return [];
  const r = git(repoRoot, ['ls-files', '-z', '--'].concat(list), { allowFail: true });
  if (!r || r.status !== 0 || !r.stdout) return [];
  return String(r.stdout).split('\0').filter(Boolean).map(slashRel);
}

// 名单里已跟踪的路径不再拿工作区去比。未跟踪文件没有这个位。
function applySkipWorktree(repoRoot) {
  const files = trackedLocalFiles(repoRoot);
  if (!files.length) return;
  git(repoRoot, ['update-index', '--skip-worktree', '--'].concat(files), { allowFail: true });
}

function clearSkipWorktree(repoRoot) {
  const files = trackedLocalFiles(repoRoot);
  if (!files.length) return;
  git(repoRoot, ['update-index', '--no-skip-worktree', '--'].concat(files), { allowFail: true });
}

function headHas(repoRoot, rel) {
  const r = git(repoRoot, ['cat-file', '-e', 'HEAD:' + rel], { allowFail: true });
  return !!(r && r.status === 0);
}

// 提交前把名单路径的索引收回 HEAD blob。不改工作区。新文件则取消暂存。
function keepCommitBlob(repoRoot) {
  if (gitConfigGet(repoRoot, LOCAL_FLAG) !== 'true') return [];
  const { gitText } = require('./git_exec');
  const staged = String(gitText(repoRoot, ['diff', '--cached', '--name-only', '-z'], { allowFail: true }) || '')
    .split('\0').filter(Boolean).map(slashRel);
  const list = localList(repoRoot);
  const hit = [];
  const inHead = [];
  const added = [];
  for (let i = 0; i < staged.length; i++) {
    if (!onLocalList(staged[i], list)) continue;
    hit.push(staged[i]);
    if (headHas(repoRoot, staged[i])) inHead.push(staged[i]);
    else added.push(staged[i]);
  }
  if (!hit.length) return [];
  if (inHead.length) {
    const r = git(repoRoot, ['restore', '--source=HEAD', '--staged', '--'].concat(inHead), { allowFail: true });
    if (!r || r.status !== 0) throw new Error('收回本地配置的索引 blob 失败');
  }
  if (added.length) {
    const r = git(repoRoot, ['restore', '--staged', '--'].concat(added), { allowFail: true });
    if (!r || r.status !== 0) throw new Error('取消暂存本地配置的新文件失败');
  }
  applySkipWorktree(repoRoot);
  return hit;
}

function shimRepo(argv) {
  const { parseGitInvocation } = require('./git_shim');
  const parsed = parseGitInvocation(argv || []);
  const args = ['rev-parse', '--show-toplevel'];
  if (parsed.cdir) args.unshift('-C', parsed.cdir);
  const r = git(process.cwd(), args, { allowFail: true });
  if (!r || r.status !== 0) return '';
  return String(r.stdout || '').replace(/\r?\n/g, '').trim();
}

// 这次切换挪走了哪些路径。prepare 和 restore 是两个进程，靠这份清单交接。
function snapListPath(repoRoot, token) {
  const safe = String(token || 'direct').replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(runDir(repoRoot), 'shim-snap-' + (safe || 'direct'));
}

function removeLocalKeep(repoRoot, rel) {
  const file = keepFile(repoRoot, rel);
  try { fs.unlinkSync(file); } catch (_) { return; }
  let dir = path.dirname(file);
  const root = path.resolve(localKeepRoot(repoRoot));
  while (dir && path.resolve(dir).toLowerCase() !== root.toLowerCase()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { break; }
    if (names.length) break;
    try { fs.rmdirSync(dir); } catch (_) { break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

// 清单一行：M 是整段改名，F 是改名失败后逐个复制的文件。没有前缀的旧行按复制文件处理。
function parseSnap(text) {
  const moved = [];
  const copied = [];
  const lines = String(text || '').split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.indexOf('M ') === 0) moved.push(slashRel(line.slice(2)));
    else if (line.indexOf('F ') === 0) copied.push(slashRel(line.slice(2)));
    else copied.push(slashRel(line));
  }
  return { moved: moved, copied: copied };
}

function pathExists(abs) {
  try {
    fs.lstatSync(abs);
    return true;
  } catch (_) {
    return false;
  }
}

function forgetSnapList(repoRoot, listFile) {
  let text = '';
  try { text = fs.readFileSync(listFile, 'utf8'); }
  catch (err) {
    if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) {
      try { fs.unlinkSync(listFile); } catch (_) { /* ignore */ }
    }
    return;
  }
  const parsed = parseSnap(text);
  for (let i = 0; i < parsed.copied.length; i++) removeLocalKeep(repoRoot, parsed.copied[i]);
  let pending = false;
  for (let i = 0; i < parsed.moved.length; i++) {
    const rel = parsed.moved[i];
    const dest = keepFile(repoRoot, rel);
    if (!pathExists(dest)) continue;
    const abs = worktreeFile(repoRoot, rel);
    if (!pathExists(abs)) {
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.renameSync(dest, abs);
      } catch (_) { pending = true; }
    } else {
      pending = true;
    }
  }
  if (pending) return;
  try { fs.unlinkSync(listFile); } catch (_) { /* 清单已经没了 */ }
}

// 上次切换没走完时留下的副本，过十分钟清掉。
function sweepOldSnaps(repoRoot) {
  let names = [];
  try { names = fs.readdirSync(runDir(repoRoot)); }
  catch (_) { return; }
  const now = Date.now();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name.indexOf('shim-snap-') !== 0 && name.indexOf('shim-hold-') !== 0) continue;
    const abs = path.join(runDir(repoRoot), name);
    let age = 0;
    try { age = now - fs.statSync(abs).mtimeMs; }
    catch (_) { continue; }
    if (age > 10 * 60 * 1000) forgetSnapList(repoRoot, abs);
  }
}

// commands、hooks 这类目录里的 gitkeep 用来占住目录。删掉后目录变空，Cursor 会占住句柄，再 scandir 就是 EPERM，只能重启。
function isGitkeep(rel) {
  const name = slashRel(rel).split('/').pop().toLowerCase();
  return name === 'gitkeep' || name === '.gitkeep';
}

function dirBusy(err) {
  return !!(err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY' || err.code === 'ENOENT' || err.code === 'ENOTDIR'));
}

// 从任意目录列出普通文件。符号链接不跟着走。目录被 Cursor 占住时跳过，不让这次切换失败。
function listTreeFiles(abs, rel) {
  let st;
  try { st = fs.lstatSync(abs); }
  catch (err) {
    if (dirBusy(err)) return [];
    throw err;
  }
  if (st.isDirectory()) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(abs); }
    catch (err) {
      if (dirBusy(err)) return [];
      throw err;
    }
    for (let i = 0; i < names.length; i++) {
      const child = slashRel(rel) + '/' + names[i];
      const nested = listTreeFiles(path.join(abs, names[i]), child);
      for (let j = 0; j < nested.length; j++) out.push(nested[j]);
    }
    return out;
  }
  if (st.isFile()) return [slashRel(rel)];
  return [];
}

function listDiskFiles(repoRoot, rel) {
  return listTreeFiles(worktreeFile(repoRoot, rel), rel);
}

// .zkz 自己不能挪，挪进去会把副本目录一起带走。
function canPark(rel) {
  const name = slashRel(rel);
  if (!name || name === '.' || name === '.zkz' || name.indexOf('.zkz/') === 0) return false;
  return true;
}

function underPrefix(rel, prefixes) {
  for (let i = 0; i < prefixes.length; i++) {
    const pre = prefixes[i];
    if (rel === pre || rel.indexOf(pre + '/') === 0) return true;
  }
  return false;
}

// 先把快照里的 gitkeep 放回，再删 Git 写出的其他文件。目录里一直有 gitkeep，不会变空。
function moveSnapshotFile(repoRoot, rel) {
  const from = keepFile(repoRoot, rel);
  const to = worktreeFile(repoRoot, rel);
  if (!pathExists(from)) return;
  try { fs.mkdirSync(path.dirname(to), { recursive: true }); }
  catch (err) { if (!dirBusy(err)) throw err; }
  try {
    fs.renameSync(from, to);
    return;
  } catch (_) { /* 目标还在，改成覆盖写 */ }
  try {
    atomicWriteFile(to, fs.readFileSync(from));
    try { fs.unlinkSync(from); } catch (__) { /* 快照留着，下次再放回 */ }
  } catch (err) { if (!dirBusy(err)) throw err; }
}

function removeTreeExceptGitkeep(abs) {
  let st;
  try { st = fs.lstatSync(abs); }
  catch (err) {
    if (dirBusy(err)) return;
    throw err;
  }
  if (!st.isDirectory()) {
    if (isGitkeep(abs)) return;
    try { fs.unlinkSync(abs); }
    catch (err) { if (!dirBusy(err)) throw err; }
    return;
  }
  let names = [];
  try { names = fs.readdirSync(abs); }
  catch (err) {
    if (dirBusy(err)) return;
    throw err;
  }
  for (let i = 0; i < names.length; i++) {
    if (isGitkeep(names[i])) continue;
    removeTreeExceptGitkeep(path.join(abs, names[i]));
  }
  let left = [];
  try { left = fs.readdirSync(abs); }
  catch (err) {
    if (dirBusy(err)) return;
    throw err;
  }
  if (left.length) return;
  try { fs.rmdirSync(abs); }
  catch (_) { /* 空目录仍被占用时留着 */ }
}

// 删掉 Git 在这个清单路径上写出的内容，再把快照放回来。gitkeep 不删。
function unparkPrefix(repoRoot, rel) {
  const abs = worktreeFile(repoRoot, rel);
  const dest = keepFile(repoRoot, rel);
  if (!pathExists(dest)) return false;
  let st;
  try { st = fs.lstatSync(dest); }
  catch (_) { return false; }
  if (!st.isDirectory()) {
    moveSnapshotFile(repoRoot, rel);
    return pathExists(abs);
  }
  if (!pathExists(abs)) {
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.renameSync(dest, abs);
      return true;
    } catch (_) { return false; }
  }
  const files = listTreeFiles(dest, rel);
  for (let i = 0; i < files.length; i++) {
    if (isGitkeep(files[i])) moveSnapshotFile(repoRoot, files[i]);
  }
  removeTreeExceptGitkeep(abs);
  for (let i = 0; i < files.length; i++) {
    if (!isGitkeep(files[i])) moveSnapshotFile(repoRoot, files[i]);
  }
  if (!listTreeFiles(dest, rel).length) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) { /* 快照还在，下次再放回 */ }
  }
  return true;
}

// 同一仓库里改名不搬内容。目标上若还留着上次的副本，先放回再重新挪走。
function parkPrefix(repoRoot, rel) {
  const abs = worktreeFile(repoRoot, rel);
  const dest = keepFile(repoRoot, rel);
  if (pathExists(dest)) {
    if (pathExists(abs)) {
      if (!unparkPrefix(repoRoot, rel)) return 'copy';
    } else {
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.renameSync(dest, abs);
      } catch (_) { return 'keep'; }
    }
  }
  if (!pathExists(abs)) return 'missing';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(abs, dest);
    return 'moved';
  } catch (_) {
    return 'copy';
  }
}

function copyPrefix(repoRoot, rel) {
  const files = listDiskFiles(repoRoot, rel);
  const out = [];
  for (let i = 0; i < files.length; i++) {
    saveLocalKeep(repoRoot, files[i], fs.readFileSync(worktreeFile(repoRoot, files[i])));
    out.push(files[i]);
  }
  return out;
}

// 改名没成功时，把副本里的文件写回工作区。
function copyOutKeep(repoRoot, rel) {
  const files = listTreeFiles(keepFile(repoRoot, rel), rel);
  const out = [];
  for (let i = 0; i < files.length; i++) {
    atomicWriteFile(worktreeFile(repoRoot, files[i]), fs.readFileSync(keepFile(repoRoot, files[i])));
    out.push(files[i]);
  }
  return out;
}

// 未跟踪的名单文件先挪走，避免挡住这次切换。内容已经在快照里。
function hideUntrackedLocal(repoRoot, saved) {
  const tracked = {};
  const files = trackedLocalFiles(repoRoot);
  for (let i = 0; i < files.length; i++) tracked[files[i]] = true;
  for (let i = 0; i < saved.length; i++) {
    if (tracked[saved[i]]) continue;
    removeWorktreeExtra(repoRoot, saved[i]);
  }
}

// 切换前把清单路径改名挪进 .zkz/local，再把已跟踪的写成索引内容。Git 随后会当成没改过。
function shimPrepare(argv) {
  const repo = shimRepo(argv);
  if (!repo || gitConfigGet(repo, LOCAL_FLAG) !== 'true') return [];
  const perfStart = process.hrtime.bigint();
  const moved = [];
  const copied = [];
  let trackedCount = 0;
  try {
    return prepareLocal(repo, moved, copied, function (n) { trackedCount = n; });
  } finally {
    recordPerf(repo, 'zkz-native.localConfig', {
      ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
      step: 'prepare',
      command: shimCommand(argv),
      moved: moved.length,
      copied: copied.length,
      tracked: trackedCount
    });
  }
}

function prepareLocal(repo, moved, copied, setTracked) {
  sweepOldSnaps(repo);
  const list = localList(repo).map(slashRel).filter(Boolean).sort(function (a, b) {
    return a.length - b.length;
  });
  const parked = [];
  const snapFile = snapListPath(repo, process.env.ZKZ_SHIM_TOKEN);
  // 挪到一半失败时也要把已挪走的路径写进清单，恢复才能放回来。
  function writeSnap() {
    const lines = [];
    for (let i = 0; i < moved.length; i++) lines.push('M ' + moved[i]);
    for (let i = 0; i < copied.length; i++) lines.push('F ' + copied[i]);
    atomicWriteFile(snapFile, Buffer.from(lines.join('\n')));
  }
  let listed = false;
  try {
    for (let i = 0; i < list.length; i++) {
      const rel = list[i];
      if (underPrefix(rel, parked) || !canPark(rel)) continue;
      const how = parkPrefix(repo, rel);
      if (how === 'moved' || how === 'keep') {
        moved.push(rel);
        parked.push(rel);
      } else if (how === 'copy') {
        const files = copyPrefix(repo, rel);
        for (let j = 0; j < files.length; j++) copied.push(files[j]);
        parked.push(rel);
      }
    }
    writeSnap();
    listed = true;
    const tracked = trackedLocalFiles(repo);
    setTracked(tracked.length);
    if (tracked.length) {
      git(repo, ['update-index', '--no-skip-worktree', '--'].concat(tracked), { allowFail: true });
      const wrote = git(repo, ['checkout-index', '-f', '--ignore-skip-worktree-bits', '--'].concat(tracked), { allowFail: true });
      if (!wrote || wrote.status !== 0) throw new Error('把本地配置写成索引内容失败');
      // 内容已经和索引一致，但 Git 仍可能凭时间戳当成改过。刷新后这次切换才会继续。
      git(repo, ['update-index', '--refresh', '--'].concat(tracked), { allowFail: true });
    }
    hideUntrackedLocal(repo, copied);
  } catch (err) {
    if (!listed) {
      try { writeSnap(); } catch (_) { /* 清单写不进去，调用方仍会再尝试恢复 */ }
    }
    throw err;
  }
  return moved.concat(copied);
}

// 快照里没有的名单文件，从工作区删掉，并清掉因此空出来的目录。gitkeep 留着，避免目录变空后被 Cursor 占住。
function removeWorktreeExtra(repoRoot, rel) {
  if (isGitkeep(rel)) return;
  const file = worktreeFile(repoRoot, rel);
  try { fs.unlinkSync(file); }
  catch (err) {
    if (!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))) throw err;
  }
  let dir = path.dirname(file);
  const root = path.resolve(repoRoot);
  const list = localList(repoRoot);
  while (dir && path.resolve(dir).toLowerCase() !== root.toLowerCase()) {
    const relDir = slashRel(path.relative(repoRoot, dir));
    if (!onLocalList(relDir, list)) break;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { break; }
    if (names.length) break;
    try { fs.rmdirSync(dir); } catch (_) { break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function dropExtraUnder(repoRoot, prefix, have) {
  const now = listDiskFiles(repoRoot, prefix);
  for (let i = 0; i < now.length; i++) {
    if (have[now[i]]) continue;
    removeWorktreeExtra(repoRoot, now[i]);
  }
}

// 真正的 Git 跑完后，无论成败，都把快照挪回清单路径。Git 写出的那份删掉。
function shimRestore(argv) {
  const repo = shimRepo(argv);
  if (!repo) return [];
  const file = snapListPath(repo, process.env.ZKZ_SHIM_TOKEN);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
  const perfStart = process.hrtime.bigint();
  const parsed = parseSnap(text);
  let fallback = 0;
  try {
    return restoreLocal(repo, file, parsed, function () { fallback += 1; });
  } finally {
    recordPerf(repo, 'zkz-native.localConfig', {
      ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
      step: 'restore',
      command: shimCommand(argv),
      moved: parsed.moved.length,
      copied: parsed.copied.length,
      fallback: fallback
    });
  }
}

function restoreLocal(repo, file, parsed, noteFallback) {
  const restored = [];
  for (let i = 0; i < parsed.copied.length; i++) {
    const rel = parsed.copied[i];
    const data = readLocalKeep(repo, rel);
    if (!data) continue;
    atomicWriteFile(worktreeFile(repo, rel), data);
    restored.push(rel);
  }
  for (let i = 0; i < parsed.moved.length; i++) {
    const rel = parsed.moved[i];
    if (unparkPrefix(repo, rel)) {
      restored.push(rel);
      continue;
    }
    noteFallback();
    const files = copyOutKeep(repo, rel);
    const have = {};
    for (let j = 0; j < files.length; j++) {
      have[files[j]] = true;
      restored.push(files[j]);
    }
    dropExtraUnder(repo, rel, have);
    try { fs.rmSync(keepFile(repo, rel), { recursive: true, force: true }); } catch (_) { /* 副本还在，下次再放回 */ }
  }
  const have = {};
  for (let i = 0; i < parsed.copied.length; i++) have[parsed.copied[i]] = true;
  const list = localList(repo);
  for (let i = 0; i < list.length; i++) {
    const rel = slashRel(list[i]);
    if (!rel || !canPark(rel) || underPrefix(rel, parsed.moved)) continue;
    dropExtraUnder(repo, rel, have);
  }
  forgetSnapList(repo, file);
  try { applySkipWorktree(repo); } catch (_) { /* 位打不上不挡写回 */ }
  return restored;
}

function statPidFile(repoRoot) {
  return path.join(runDir(repoRoot), 'local-stat.pid');
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function readStatPid(repoRoot) {
  try { return String(fs.readFileSync(statPidFile(repoRoot), 'utf8')).trim(); }
  catch (_) { return ''; }
}

// 停掉旧版本留下的保存监视。现在不再启动。
function stopLocalWatch(repoRoot) {
  if (!repoRoot) return;
  const pid = readStatPid(repoRoot);
  if (pidAlive(pid)) {
    try { process.kill(Number(pid)); } catch (_) { /* 已经退出 */ }
  }
  try {
    if (String(readStatPid(repoRoot)) === String(pid)) fs.unlinkSync(statPidFile(repoRoot));
  } catch (_) { /* ignore */ }
}

if (require.main === module) {
  const shimCmd = process.argv[2];
  if (shimCmd === 'shim-prepare' || shimCmd === 'shim-restore') {
    try {
      if (shimCmd === 'shim-prepare') shimPrepare(process.argv.slice(3));
      else shimRestore(process.argv.slice(3));
    } catch (e) {
      try { process.stderr.write('zkz-local: ' + String(e && e.message ? e.message : e) + '\n'); } catch (_) { /* ignore */ }
      process.exit(1);
    }
  } else {
    try { process.stderr.write('zkz-local: 本地配置不再使用 clean/smudge\n'); } catch (_) { /* ignore */ }
    process.exit(1);
  }
}

module.exports = {
  saveLocalKeep,
  applySkipWorktree,
  clearSkipWorktree,
  keepCommitBlob,
  stopLocalWatch,
  shimPrepare,
  shimRestore,
  LOCAL_FLAG
};
