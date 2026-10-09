'use strict';

const fs = require('fs');
const path = require('path');

function normalizeFlavor(flavor) {
  return String(flavor || '').trim().toLowerCase() === 'h750' ? 'h750' : 'f429';
}

function layoutOptionsFromGet(get) {
  const read = typeof get === 'function' ? get : function (_key, fallback) { return fallback; };
  const flavor = normalizeFlavor(read('flavor', 'f429'));
  const target = read(
    flavor === 'h750' ? 'h750.target' : 'f429.target',
    flavor === 'h750' ? 'H750_N' : 'Flash'
  );
  return { flavor: flavor, target: target };
}

function resolveKeilLayout(root, options) {
  const opts = options || {};
  const flavor = normalizeFlavor(opts.flavor);
  const target = String(opts.target || '').trim() || (flavor === 'h750' ? 'H750_N' : 'Flash');
  if (flavor === 'h750') {
    const projectFile = path.join(root, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
    const mdk = path.dirname(projectFile);
    return {
      flavor: 'h750',
      mdk: mdk,
      uvproj: 'H750_N.uvprojx',
      projectDir: mdk,
      projectFile: projectFile,
      defaultTarget: target,
      relAxf: path.join('H750', 'Projects', 'MDK-ARM', 'Flash', 'Obj', 'output.axf'),
      relHex: path.join('H750', 'Projects', 'MDK-ARM', 'Flash', 'Obj', 'output.hex'),
      relMap: path.join('H750', 'Projects', 'MDK-ARM', 'Flash', '.zkz', 'gdb_source_map.gdb')
    };
  }
  const mdk = path.join(root, 'Project', 'MDK-ARM(uV4)');
  let uvproj = 'b_01.uvproj';
  if (!fs.existsSync(path.join(mdk, uvproj))) uvproj = 'b_01.uvprojx';
  const projectFile = path.join(mdk, uvproj);
  return {
    flavor: 'f429',
    mdk: mdk,
    uvproj: uvproj,
    projectDir: mdk,
    projectFile: projectFile,
    defaultTarget: target,
    relAxf: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.axf'),
    relHex: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.hex'),
    relMap: path.join('Project', 'MDK-ARM(uV4)', 'Flash', '.zkz', 'gdb_source_map.gdb')
  };
}

module.exports = { normalizeFlavor, layoutOptionsFromGet, resolveKeilLayout };
