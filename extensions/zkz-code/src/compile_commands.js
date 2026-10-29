'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { writeCompileCommandsStamp } = require('./cc_stamp');
const loadShared = require('./load_shared');
const { resolveKeilLayout: resolveShared, layoutOptionsFromGet } = loadShared('keil_layout');
const { get } = loadShared('zkz_settings');
const { record: recordPerf } = loadShared('perf');

function readKeilSetting(root) {
  return function (key, fallback) {
    return get(root, 'keil', key, fallback);
  };
}

function resolveKeilLayout(root) {
  return resolveShared(root, layoutOptionsFromGet(readKeilSetting(root)));
}

function list(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function tagText(node, tag) {
  const value = node && node[tag];
  return value == null || typeof value === 'object' ? '' : String(value).trim();
}

function splitList(text, sep) {
  return String(text || '').split(sep).map((s) => s.trim()).filter(Boolean);
}

function normPath(p) {
  return path.normalize(p).replace(/\//g, '\\');
}

function absFromMdk(mdk, rel) {
  const raw = String(rel || '').trim().replace(/^"|"$/g, '');
  if (!raw) return '';
  const abs = path.isAbsolute(raw) ? raw : path.join(mdk, raw);
  return normPath(abs);
}

function pickTarget(targets, name) {
  if (!targets.length) {
    const err = new Error('Keil 工程里没有 Target');
    err.code = 'ZKZ_NO_TARGET';
    throw err;
  }
  if (!name) return targets[0];
  for (let i = 0; i < targets.length; i++) {
    if (tagText(targets[i], 'TargetName') === name) return targets[i];
  }
  const err = new Error('Keil 目标不存在: ' + name);
  err.code = 'ZKZ_NO_TARGET';
  throw err;
}

function flagsFromControls(vc) {
  return {
    defines: splitList(tagText(vc, 'Define'), ','),
    undefines: splitList(tagText(vc, 'Undefine'), ','),
    includes: splitList(tagText(vc, 'IncludePath'), ';')
  };
}

function variousControls(node) {
  if (!node) return {};
  const cads = (node.FileArmAds || node.TargetArmAds || node).Cads || {};
  return cads.VariousControls || {};
}

/** 目标级宏、取消定义和头文件路径。 */
function compilerFlags(targetXml) {
  const opt = targetXml.TargetOption || {};
  return flagsFromControls(variousControls(opt));
}

/** 文件自己的宏和头文件路径。追加在目标级后面，空字段不产生参数。 */
function fileLevelFlags(fileXml) {
  const opt = fileXml && fileXml.FileOption;
  if (!opt) return { defines: [], undefines: [], includes: [] };
  return flagsFromControls(variousControls(opt));
}

/** 这一层的源文件，加上子组里的源文件。 */
function filesInGroup(group) {
  const files = list(group && group.Files && group.Files.File);
  const nested = list(group && group.Groups && group.Groups.Group);
  for (let i = 0; i < nested.length; i++) {
    const inner = filesInGroup(nested[i]);
    for (let j = 0; j < inner.length; j++) files.push(inner[j]);
  }
  return files;
}

function appendFlags(args, mdk, flags) {
  for (let i = 0; i < flags.includes.length; i++) {
    const abs = absFromMdk(mdk, flags.includes[i]);
    if (abs) args.push('-I' + abs);
  }
  for (let i = 0; i < flags.undefines.length; i++) args.push('-U' + flags.undefines[i]);
  for (let i = 0; i < flags.defines.length; i++) args.push('-D' + flags.defines[i]);
  return args;
}

function isCSource(rel) {
  return /\.(c|cc|cpp|cxx)$/i.test(String(rel || ''));
}

function buildCompileCommands(xml, mdk, targetName) {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    const err = new Error('Invalid Keil XML: ' + valid.err.msg + ' (line ' + valid.err.line + ')');
    err.code = 'ZKZ_INVALID_XML';
    throw err;
  }
  const project = new XMLParser({ parseTagValue: false, processEntities: true, htmlEntities: true }).parse(xml).Project || {};
  const target = pickTarget(list(project.Targets && project.Targets.Target), targetName);
  const flags = compilerFlags(target);
  const baseArgs = appendFlags(['clang'], mdk, flags);
  const dir = normPath(mdk);
  const entries = [];
  const groups = list(target.Groups && target.Groups.Group);
  const files = [];
  for (let g = 0; g < groups.length; g++) {
    const inner = filesInGroup(groups[g]);
    for (let j = 0; j < inner.length; j++) files.push(inner[j]);
  }
  for (let i = 0; i < files.length; i++) {
    const fileXml = files[i];
    const type = tagText(fileXml, 'FileType');
    if (type !== '1' && type !== '8') continue;
    const common = fileXml.FileOption && fileXml.FileOption.CommonProperty;
    if (tagText(common, 'IncludeInBuild') === '0') continue;
    const rel = tagText(fileXml, 'FilePath');
    if (!isCSource(rel)) continue;
    const file = absFromMdk(mdk, rel);
    if (!file) continue;
    entries.push({
      arguments: appendFlags(baseArgs.slice(), mdk, fileLevelFlags(fileXml)),
      directory: dir,
      file: file
    });
  }
  return { target: tagText(target, 'TargetName'), entries: entries };
}

function projectFileOf(layout) {
  if (layout && layout.projectFile && fs.existsSync(layout.projectFile)) return layout.projectFile;
  const mdk = layout && (layout.mdk || layout.projectDir);
  const name = layout && layout.uvproj;
  if (mdk && name) {
    const p = path.join(mdk, name);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, text, 'utf8');
}

let compileCache = null;

function compileCommandsCachePath(root) {
  return path.join(root, '.zkz', 'run', 'compile-commands-cache.json');
}

/** 这次工程内容的摘要。生成规则变了就换版本前缀，避免用上旧结果。扩展宿主线程调用。 */
function compileCommandsCacheKey(mdk, xml, flavor, targetName) {
  return crypto.createHash('sha1')
    .update('v4\0' + path.resolve(mdk))
    .update('\0' + xml)
    .update('\0' + (flavor || ''))
    .update('\0' + targetName)
    .digest('hex');
}

/** 磁盘缓存能否当这次的编译数据库。摘要不一致或内容坏了返回 null。扩展宿主线程调用。 */
function readPersistedCompileCommands(file, key) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (!obj || obj.key !== key || typeof obj.text !== 'string') return null;
  let entries;
  try { entries = JSON.parse(obj.text); } catch (_) { return null; }
  if (!Array.isArray(entries) || !entries.length) return null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry.file !== 'string' || typeof entry.directory !== 'string' || !Array.isArray(entry.arguments)) {
      return null;
    }
  }
  return { key: key, text: obj.text, entries: entries, target: obj.target || '' };
}

/** 把这次解析结果写到磁盘。写失败不影响编译数据库。扩展宿主线程调用。 */
function writePersistedCompileCommands(file, cached) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      key: cached.key,
      text: cached.text,
      target: cached.target
    }, null, 2) + '\n', 'utf8');
  } catch (_) { /* 持久化失败仍继续写出 compile_commands */ }
}

/** 生成 compile_commands。先用内存，没有再读磁盘缓存，都没有才解析工程。扩展宿主线程调用。 */
async function generateOnRoot(root, log) {
  const perfStart = process.hrtime.bigint();
  const layout = resolveKeilLayout(root);
  const proj = projectFileOf(layout);
  if (!proj) {
    if (log) log('Keil project missing, skip compile_commands');
    return 'skip';
  }
  const mdk = (layout && (layout.mdk || layout.projectDir)) || path.dirname(proj);
  const targetName = (layout && layout.defaultTarget) || '';
  const flavor = layout.flavor || '';
  if (log) log('generate compile_commands flavor=' + flavor + ' uvproj=' + path.basename(proj) + ' target=' + targetName);
  const xml = fs.readFileSync(proj, 'utf8').replace(/^\uFEFF/, '');
  const cacheKey = compileCommandsCacheKey(mdk, xml, flavor, targetName);
  const cacheFile = compileCommandsCachePath(root);
  let memoryHit = false;
  let cacheHit = false;
  let cached = null;
  if (compileCache && compileCache.key === cacheKey) {
    cached = compileCache;
    memoryHit = true;
    cacheHit = true;
  } else {
    cached = readPersistedCompileCommands(cacheFile, cacheKey);
    if (cached) {
      compileCache = cached;
      cacheHit = true;
    }
  }
  if (!cached) {
    const built = buildCompileCommands(xml, mdk, targetName);
    if (!built.entries.length) throw new Error('目标 ' + built.target + ' 里没有 C 源文件');
    cached = {
      key: cacheKey,
      text: JSON.stringify(built.entries, null, 4) + '\n',
      entries: built.entries,
      target: built.target
    };
    compileCache = cached;
    writePersistedCompileCommands(cacheFile, cached);
  }
  const text = cached.text;
  const src = path.join(mdk, 'compile_commands.json');
  const dst = path.join(root, 'compile_commands.json');
  writeIfChanged(src, text);
  if (path.resolve(src) !== path.resolve(dst)) writeIfChanged(dst, text);
  try { writeCompileCommandsStamp(root); } catch (_) { /* ignore */ }
  if (log) log('compile_commands.json ready: ' + dst + ' (' + cached.entries.length + ')');
  recordPerf(root, 'zkz-code.generateCompileCommands', {
    ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
    entries: cached.entries.length,
    flavor: flavor,
    target: targetName,
    cacheHit: cacheHit,
    memoryHit: memoryHit
  });
  return 'generated';
}

async function refreshCompileCommands(root, opts) {
  const log = opts && opts.log;
  const force = !!(opts && opts.force);
  const cc = path.join(root, 'compile_commands.json');
  if (force || !fs.existsSync(cc)) {
    return generateOnRoot(root, log);
  }
  return 'exists';
}

module.exports = { resolveKeilLayout, refreshCompileCommands, buildCompileCommands };
