'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function resolveKeilLayout(w1) {
  const name = path.basename(w1).toLowerCase();
  const h750 = path.join(w1, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
  if (name.indexOf('h750') >= 0 && fs.existsSync(h750)) {
    const mdk = path.dirname(h750);
    let yt = path.join(w1, 'Project', 'MDK-ARM(uV4)', 'YTSwarm.exe');
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
  const mdk = path.join(w1, 'Project', 'MDK-ARM(uV4)');
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

function workspaceLayout(root) {
  const coreVer = fs.existsSync(path.join(root, 'core', 'core_common', 'yt_version.h'));
  const userVer = fs.existsSync(path.join(root, 'User', 'common', 'yt_version.h'));
  if (coreVer && !userVer) return 'core';
  if (userVer && !coreVer) return 'user';
  if (fs.existsSync(path.join(root, 'core', 'core_gui')) && !fs.existsSync(path.join(root, 'User', 'gui'))) return 'core';
  if (fs.existsSync(path.join(root, 'User', 'gui')) && !fs.existsSync(path.join(root, 'core', 'core_gui'))) return 'user';
  if (fs.existsSync(path.join(root, 'core'))) return 'core';
  if (fs.existsSync(path.join(root, 'User'))) return 'user';
  return 'unknown';
}

function rewritePaths(w1, sandbox) {
  const srcCc = path.join(w1, 'compile_commands.json');
  const dstCc = path.join(sandbox, 'compile_commands.json');
  if (!fs.existsSync(srcCc)) return 'missing';
  let text = fs.readFileSync(srcCc, 'utf8');
  const srcFwd = w1.replace(/\\/g, '/');
  const dstFwd = sandbox.replace(/\\/g, '/');
  const srcEsc = w1.replace(/\\/g, '\\\\');
  const dstEsc = sandbox.replace(/\\/g, '\\\\');
  text = text.split(srcEsc).join(dstEsc).split(srcFwd).join(dstFwd).split(w1).join(sandbox);
  const uProj = path.join(sandbox, 'Project');
  const w1Proj = path.join(w1, 'Project');
  text = text.split(uProj.replace(/\\/g, '\\\\')).join(w1Proj.replace(/\\/g, '\\\\'));
  text = text.split(uProj.replace(/\\/g, '/')).join(w1Proj.replace(/\\/g, '/'));
  text = text.split(uProj).join(w1Proj);
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(dstCc, text, 'utf8');
  return 'rewritten';
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

async function generateOnW1(w1, log) {
  const layout = resolveKeilLayout(w1);
  if (!fs.existsSync(layout.ytswarm)) {
    if (log) log('YTSwarm missing, skip compile_commands: ' + layout.ytswarm);
    return 'skip';
  }
  if (log) log('generate compile_commands flavor=' + layout.flavor + ' uvproj=' + layout.uvproj);
  await spawnYtSwarm(layout);
  const src = path.join(layout.mdk, 'compile_commands.json');
  const dst = path.join(w1, 'compile_commands.json');
  if (!fs.existsSync(src)) throw new Error('compile_commands.json not generated: ' + src);
  const entries = JSON.parse(fs.readFileSync(src, 'utf8'));
  const fixed = absolutizeEntries(entries, layout.mdk);
  fs.writeFileSync(src, JSON.stringify(fixed, null, 4) + '\n', 'utf8');
  fs.copyFileSync(src, dst);
  if (log) log('compile_commands.json ready on W1: ' + dst + ' (' + fixed.length + ')');
  return 'generated';
}

async function refreshCompileCommands(w1, sandbox, opts) {
  const log = opts && opts.log;
  const force = !!(opts && opts.force);
  if (force) {
    await generateOnW1(w1, log);
    return rewritePaths(w1, sandbox);
  }
  const ccW1 = path.join(w1, 'compile_commands.json');
  if (!fs.existsSync(ccW1)) {
    await generateOnW1(w1, log);
  }
  return rewritePaths(w1, sandbox);
}

module.exports = { resolveKeilLayout, workspaceLayout, rewritePaths, refreshCompileCommands };
