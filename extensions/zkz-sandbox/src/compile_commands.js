'use strict';

const fs = require('fs');
const path = require('path');

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

function copyOneAxf(root, srcAxf, label, log) {
  if (!root || !fs.existsSync(root)) return null;
  const dstAxf = path.join(root, '.zkz', 'output.axf');
  fs.mkdirSync(path.dirname(dstAxf), { recursive: true });
  if (fs.existsSync(dstAxf)) {
    try {
      if (fs.lstatSync(dstAxf).isSymbolicLink()) fs.unlinkSync(dstAxf);
    } catch (_) { /* ignore */ }
  }
  let needCopy = true;
  if (fs.existsSync(dstAxf)) {
    const a = fs.statSync(srcAxf);
    const b = fs.statSync(dstAxf);
    if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2) needCopy = false;
  }
  if (needCopy) {
    fs.copyFileSync(srcAxf, dstAxf);
    const a = fs.statSync(srcAxf);
    try { fs.utimesSync(dstAxf, a.atime, a.mtime); } catch (_) { /* ignore */ }
  }
  const msg = needCopy
    ? ('debug axf -> ' + label + ' copy: .zkz/output.axf')
    : ('debug axf unchanged (' + label + '): .zkz/output.axf');
  if (log) log(msg);
  return msg;
}

/**
 * Copy W1 Flash/Obj/output.axf to W1 and sandbox `.zkz/output.axf` (real files, not symlinks).
 * GDB substitute-path rewrites the W1 prefix; a symlink would resolve into *U/Project which does not exist.
 */
function copyDebugAxf(w1, sandbox, log) {
  const layout = resolveKeilLayout(w1);
  const srcAxf = path.join(w1, layout.relAxf);
  if (!fs.existsSync(srcAxf)) {
    throw new Error('Missing ' + srcAxf + '\nBuild on workspace1 first (Keil Build from sandbox is OK).');
  }
  const lines = [];
  const w1Msg = copyOneAxf(w1, srcAxf, '\u771f\u6e90', log);
  if (w1Msg) lines.push(w1Msg);
  if (sandbox && path.resolve(sandbox) !== path.resolve(w1)) {
    const uMsg = copyOneAxf(sandbox, srcAxf, 'sandbox', log);
    if (uMsg) lines.push(uMsg);
  }
  return lines;
}

module.exports = {
  resolveKeilLayout,
  copyDebugAxf
};
