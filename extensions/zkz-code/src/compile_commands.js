'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writeCompileCommandsStamp, gitHead } = require('./cc_stamp');

function resolveKeilLayout(root) {
  const h750 = path.join(root, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
  if (fs.existsSync(h750)) {
    const mdk = path.dirname(h750);
    let yt = path.join(root, 'Project', 'MDK-ARM(uV4)', 'YTSwarm.exe');
    if (!fs.existsSync(yt)) yt = path.join(mdk, 'YTSwarm.exe');
    return {
      flavor: 'h750',
      mdk,
      uvproj: 'H750_N.uvprojx',
      ytswarm: yt,
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
    ytswarm: path.join(mdk, 'YTSwarm.exe'),
    projectDir: mdk,
    projectFile: path.join(mdk, uvproj),
    defaultTarget: 'Flash',
    relAxf: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.axf'),
    relHex: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.hex'),
    relMap: path.join('Project', 'MDK-ARM(uV4)', 'Flash', '.zkz', 'gdb_source_map.gdb')
  };
}

async function preferredLayout(root) {
  try {
    const ids = await vscode.commands.getCommands(true);
    if (ids.indexOf('zkz-keil.resolveLayout') >= 0) {
      const layout = await vscode.commands.executeCommand('zkz-keil.resolveLayout');
      if (layout && layout.projectDir) {
        if (!layout.ytswarm) {
          let yt = path.join(root, 'Project', 'MDK-ARM(uV4)', 'YTSwarm.exe');
          if (!fs.existsSync(yt)) yt = path.join(layout.projectDir, 'YTSwarm.exe');
          layout.ytswarm = yt;
        }
        if (!layout.mdk) layout.mdk = layout.projectDir;
        if (!layout.uvproj) layout.uvproj = path.basename(layout.projectFile || '');
        return layout;
      }
    }
  } catch (_) { /* 未装 keil 时用本包回退 */ }
  return resolveKeilLayout(root);
}

function absolutizeEntries(entries, mdk) {
  const norm = (p) => String(p).replace(/\//g, '\\');
  const out = [];
  for (const entry of entries || []) {
    let filePath = entry.file || '';
    if (String(filePath).toLowerCase().endsWith('.s')) continue;
    let args = Array.isArray(entry.arguments) ? entry.arguments.slice() : [];
    if (args[0] === '<compilerPath>') args[0] = 'clang';
    const newArgs = [];
    for (const a of args) {
      if (typeof a === 'string' && a.startsWith('-I') && a.length > 2) {
        const inc = a.slice(2).replace(/^"|"$/g, '');
        const ap = path.isAbsolute(inc) ? path.normalize(inc) : path.normalize(path.join(mdk, inc));
        newArgs.push('-I' + norm(ap));
      } else {
        newArgs.push(a);
      }
    }
    const fp = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.normalize(path.join(mdk, filePath));
    entry.directory = norm(mdk);
    entry.file = norm(fp);
    if (newArgs.length) {
      const last = String(newArgs[newArgs.length - 1]).replace(/^"|"$/g, '');
      if (/\.(c|cpp|cc)$/i.test(last)) newArgs[newArgs.length - 1] = norm(fp);
      entry.arguments = newArgs;
    }
    out.push(entry);
  }
  return out;
}

function spawnYtSwarm(layout) {
  return new Promise((resolve, reject) => {
    const child = spawn(layout.ytswarm, [layout.uvproj], { cwd: layout.mdk, windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('YTSwarm exit ' + code + (err ? ': ' + err.trim() : '')));
    });
  });
}

async function generateOnRoot(root, log) {
  const layout = await preferredLayout(root);
  if (!fs.existsSync(layout.ytswarm)) {
    if (log) log('YTSwarm missing, skip compile_commands: ' + layout.ytswarm);
    return 'skip';
  }
  if (log) log('generate compile_commands flavor=' + layout.flavor + ' uvproj=' + layout.uvproj);
  await spawnYtSwarm(layout);
  const src = path.join(layout.mdk, 'compile_commands.json');
  const dst = path.join(root, 'compile_commands.json');
  if (!fs.existsSync(src)) throw new Error('compile_commands.json not generated: ' + src);
  const entries = JSON.parse(fs.readFileSync(src, 'utf8'));
  const fixed = absolutizeEntries(entries, layout.mdk);
  fs.writeFileSync(src, JSON.stringify(fixed, null, 4) + '\n', 'utf8');
  fs.copyFileSync(src, dst);
  try { writeCompileCommandsStamp(root, gitHead(root)); } catch (_) { /* ignore */ }
  if (log) log('compile_commands.json ready: ' + dst + ' (' + fixed.length + ')');
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

module.exports = { resolveKeilLayout, refreshCompileCommands };
