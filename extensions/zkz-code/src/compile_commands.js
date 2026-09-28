'use strict';

const fs = require('fs');
const path = require('path');
const { writeCompileCommandsStamp, gitHead } = require('./cc_stamp');

function resolveKeilLayout(root) {
  const h750 = path.join(root, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
  if (fs.existsSync(h750)) {
    const mdk = path.dirname(h750);
    return {
      flavor: 'h750',
      mdk,
      uvproj: 'H750_N.uvprojx',
      projectDir: mdk,
      projectFile: h750,
      defaultTarget: 'H750_N',
      relAxf: path.join('H750', 'Projects', 'MDK-ARM', 'Flash', 'Obj', 'output.axf'),
      relHex: path.join('H750', 'Projects', 'MDK-ARM', 'Flash', 'Obj', 'output.hex'),
      relMap: path.join('H750', 'Projects', 'MDK-ARM', 'Flash', '.zkz', 'gdb_source_map.gdb')
    };
  }
  const mdk = path.join(root, 'Project', 'MDK-ARM(uV4)');
  let uvproj = 'b_01.uvproj';
  if (!fs.existsSync(path.join(mdk, uvproj))) uvproj = 'b_01.uvprojx';
  return {
    flavor: 'f429',
    mdk,
    uvproj,
    projectDir: mdk,
    projectFile: path.join(mdk, uvproj),
    defaultTarget: 'Flash',
    relAxf: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.axf'),
    relHex: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.hex'),
    relMap: path.join('Project', 'MDK-ARM(uV4)', 'Flash', '.zkz', 'gdb_source_map.gdb')
  };
}

async function preferredLayout(root) {
  let vscode = null;
  try { vscode = require('vscode'); } catch (_) { vscode = null; }
  try {
    if (!vscode) return resolveKeilLayout(root);
    const ids = await vscode.commands.getCommands(true);
    if (ids.indexOf('zkz-keil.resolveLayout') >= 0) {
      const layout = await vscode.commands.executeCommand('zkz-keil.resolveLayout');
      if (layout && layout.projectDir) {
        if (!layout.mdk) layout.mdk = layout.projectDir;
        if (!layout.projectFile) {
          const name = layout.uvproj || '';
          if (name) layout.projectFile = path.join(layout.mdk, name);
        }
        if (!layout.uvproj) layout.uvproj = path.basename(layout.projectFile || '');
        return layout;
      }
    }
  } catch (_) { /* 未装 keil 时用本包回退 */ }
  return resolveKeilLayout(root);
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(block, tag) {
  const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>');
  const m = re.exec(String(block || ''));
  return m ? decodeXml(m[1].trim()) : '';
}

function blocks(xml, tag) {
  const src = String(xml || '');
  const open = '<' + tag + '>';
  const close = '</' + tag + '>';
  const out = [];
  let i = 0;
  while (i < src.length) {
    const a = src.indexOf(open, i);
    if (a < 0) break;
    let depth = 1;
    let j = a + open.length;
    let closed = -1;
    while (j < src.length && depth > 0) {
      const nOpen = src.indexOf(open, j);
      const nClose = src.indexOf(close, j);
      if (nClose < 0) break;
      if (nOpen >= 0 && nOpen < nClose) {
        depth += 1;
        j = nOpen + open.length;
      } else {
        depth -= 1;
        j = nClose + close.length;
        if (depth === 0) closed = nClose;
      }
    }
    if (closed < 0) break;
    out.push(src.slice(a + open.length, closed));
    i = closed + close.length;
  }
  return out;
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
  const opt = blocks(targetXml, 'TargetOption')[0] || '';
  const cads = blocks(opt, 'Cads')[0] || '';
  const vc = blocks(cads, 'VariousControls')[0] || '';
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
  const target = pickTarget(blocks(xml, 'Target'), targetName);
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
  const files = blocks(target, 'File');
  for (let i = 0; i < files.length; i++) {
    const fileXml = files[i];
    const type = tagText(fileXml, 'FileType');
    if (type !== '1' && type !== '8') continue;
    if (tagText(fileXml, 'IncludeInBuild') === '0') continue;
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

async function generateOnRoot(root, log) {
  const layout = await preferredLayout(root);
  const proj = projectFileOf(layout);
  if (!proj) {
    if (log) log('Keil project missing, skip compile_commands');
    return 'skip';
  }
  const mdk = (layout && (layout.mdk || layout.projectDir)) || path.dirname(proj);
  const targetName = (layout && layout.defaultTarget) || '';
  if (log) log('generate compile_commands flavor=' + (layout.flavor || '') + ' uvproj=' + path.basename(proj) + ' target=' + targetName);
  const xml = fs.readFileSync(proj, 'utf8').replace(/^\uFEFF/, '');
  const built = buildCompileCommands(xml, mdk, targetName);
  if (!built.entries.length) throw new Error('目标 ' + built.target + ' 里没有 C 源文件');
  const text = JSON.stringify(built.entries, null, 4) + '\n';
  const src = path.join(mdk, 'compile_commands.json');
  const dst = path.join(root, 'compile_commands.json');
  fs.writeFileSync(src, text, 'utf8');
  if (path.resolve(src) !== path.resolve(dst)) fs.writeFileSync(dst, text, 'utf8');
  try { writeCompileCommandsStamp(root, gitHead(root)); } catch (_) { /* ignore */ }
  if (log) log('compile_commands.json ready: ' + dst + ' (' + built.entries.length + ')');
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
