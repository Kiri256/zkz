'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { writeCompileCommandsStamp, gitHead } = require('./cc_stamp');
const { resolveKeilLayout: resolveShared, layoutOptionsFromGet } = require('../../shared/keil_layout');
const { get } = require('../../shared/zkz_settings');
const { record: recordPerf } = require('../../shared/perf');

let compileCache = null;

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

function compilerFlags(targetXml) {
  const opt = targetXml.TargetOption || {};
  const cads = (opt.TargetArmAds || opt).Cads || {};
  const vc = cads.VariousControls || {};
  return {
    defines: splitList(tagText(vc, 'Define'), ','),
    undefines: splitList(tagText(vc, 'Undefine'), ','),
    includes: splitList(tagText(vc, 'IncludePath'), ';')
  };
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
  const args = ['clang'];
  for (let i = 0; i < flags.includes.length; i++) {
    const abs = absFromMdk(mdk, flags.includes[i]);
    if (abs) args.push('-I' + abs);
  }
  for (let i = 0; i < flags.undefines.length; i++) args.push('-U' + flags.undefines[i]);
  for (let i = 0; i < flags.defines.length; i++) args.push('-D' + flags.defines[i]);
  const dir = normPath(mdk);
  const entries = [];
  const files = list(target.Groups && target.Groups.Group)
    .flatMap((group) => list(group.Files && group.Files.File));
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
      arguments: args.slice(),
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
  if (log) log('generate compile_commands flavor=' + (layout.flavor || '') + ' uvproj=' + path.basename(proj) + ' target=' + targetName);
  const xml = fs.readFileSync(proj, 'utf8').replace(/^\uFEFF/, '');
  const cacheKey = crypto.createHash('sha1').update('v3\0' + path.resolve(mdk)).update('\0' + xml).update('\0' + (layout.flavor || '')).update('\0' + targetName).digest('hex');
  const cacheFile = path.join(root, '.zkz', 'run', 'compile-commands-cache.json');
  let cached = compileCache && compileCache.key === cacheKey ? compileCache : null;
  const memoryHit = !!cached;
  if (!cached) {
    try {
      const obj = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (obj && obj.key === cacheKey && typeof obj.text === 'string') {
        const entries = JSON.parse(obj.text);
        if (Array.isArray(entries) && entries.length && entries.every((e) => e && typeof e.file === 'string' && typeof e.directory === 'string' && Array.isArray(e.arguments))) {
          cached = { key: cacheKey, text: obj.text, entries, target: obj.target || targetName };
        }
      }
    } catch (_) { /* invalid or missing cache is rebuilt */ }
  }
  const built = cached || buildCompileCommands(xml, mdk, targetName);
  if (!built.entries.length) throw new Error('目标 ' + built.target + ' 里没有 C 源文件');
  const text = cached ? cached.text : JSON.stringify(built.entries, null, 4) + '\n';
  compileCache = { key: cacheKey, text, entries: built.entries, target: built.target };
  try {
    if (!cached) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ key: cacheKey, text: text, target: built.target }, null, 2) + '\n', 'utf8');
    }
  } catch (_) { /* cache is an optimization, output generation must continue */ }
  const src = path.join(mdk, 'compile_commands.json');
  const dst = path.join(root, 'compile_commands.json');
  writeIfChanged(src, text);
  if (path.resolve(src) !== path.resolve(dst)) writeIfChanged(dst, text);
  try { writeCompileCommandsStamp(root, gitHead(root)); } catch (_) { /* ignore */ }
  if (log) log('compile_commands.json ready: ' + dst + ' (' + built.entries.length + ')');
  recordPerf(root, 'zkz-code.generateCompileCommands', {
    ms: Number(process.hrtime.bigint() - perfStart) / 1e6,
    entries: built.entries.length,
    flavor: layout.flavor || '',
    target: targetName,
    cacheHit: !!cached,
    memoryHit
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
