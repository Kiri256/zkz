'use strict';

const fs = require('fs');
const path = require('path');

function resolveKeilLayout(w1) {
  const name = path.basename(w1).toLowerCase();
  const h750 = path.join(w1, 'H750', 'Projects', 'MDK-ARM', 'H750_N.uvprojx');
  if (name.indexOf('h750') >= 0 && fs.existsSync(h750)) {
    const mdk = path.dirname(h750);
    return {
      flavor: 'h750',
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
    projectDir: mdk,
    projectFile: path.join(mdk, uvproj),
    defaultTarget: 'Flash',
    relAxf: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.axf'),
    relHex: path.join('Project', 'MDK-ARM(uV4)', 'Flash', 'Obj', 'output.hex'),
    relMap: path.join('Project', 'MDK-ARM(uV4)', 'Flash', '.zkz', 'gdb_source_map.gdb')
  };
}

module.exports = { resolveKeilLayout };
