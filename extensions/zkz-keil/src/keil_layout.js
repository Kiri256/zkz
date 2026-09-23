'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./keil_config');

function discoverFlavor(root) {
  const override = String(cfg.get('flavor', 'auto') || 'auto').toLowerCase();
  if (override === 'h750' || override === 'f429') return override;
  const h750 = path.join(root, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
  if (fs.existsSync(h750)) return 'h750';
  return 'f429';
}

function resolveKeilLayout(root) {
  const flavor = discoverFlavor(root);
  if (flavor === 'h750') {
    const h750 = path.join(root, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
    const mdk = path.dirname(h750);
    return {
      flavor: 'h750',
      projectDir: mdk,
      projectFile: h750,
      defaultTarget: String(cfg.get('h750.target', 'H750_N')),
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
    projectDir: mdk,
    projectFile: path.join(mdk, uvproj),
    defaultTarget: String(cfg.get('f429.target', 'Flash')),
    relAxf: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.axf'),
    relHex: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.hex'),
    relMap: path.join('Project', 'MDK-ARM(uV4)', 'Flash', '.zkz', 'gdb_source_map.gdb')
  };
}

module.exports = { resolveKeilLayout, discoverFlavor };
