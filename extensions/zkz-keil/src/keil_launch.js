'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./keil_config');
const { resolveKeilLayout } = require('./keil_layout');

const MANAGED_NAMES = ['编译调试', '调试'];

function existsFile(p) {
  try { return !!(p && fs.existsSync(p) && fs.statSync(p).isFile()); } catch (_) { return false; }
}

function firstExisting(cands) {
  for (let i = 0; i < cands.length; i++) {
    const p = String(cands[i] || '').trim().replace(/^["']|["']$/g, '');
    if (existsFile(p)) return path.resolve(p);
  }
  return '';
}

function slash(p) {
  return String(p || '').replace(/\\/g, '/');
}

function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  let esc = false;
  const src = String(text || '');
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function verGreater(a, b) {
  const av = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const bv = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  const n = Math.max(av.length, bv.length);
  for (let i = 0; i < n; i++) {
    const d = (av[i] || 0) - (bv[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function packRoots(root) {
  return [cfg.get(root, 'packRoot', '')];
}

function svdNames(flavor) {
  if (flavor === 'h750') return ['STM32H750.svd', 'STM32H750x.svd'];
  return ['STM32F429x.svd', 'STM32F429.svd'];
}

function findPackedSvd(root, flavor) {
  const pack = flavor === 'h750' ? 'STM32H7xx_DFP' : 'STM32F4xx_DFP';
  const names = svdNames(flavor);
  let best = '';
  let bestVer = '';
  const roots = packRoots(root);
  for (let i = 0; i < roots.length; i++) {
    const dir = path.join(String(roots[i] || ''), pack);
    let vers = [];
    try { vers = fs.readdirSync(dir); } catch (_) { vers = []; }
    for (let j = 0; j < vers.length; j++) {
      for (let k = 0; k < names.length; k++) {
        const svd = path.join(dir, vers[j], 'CMSIS', 'SVD', names[k]);
        if (!existsFile(svd)) continue;
        if (!best || verGreater(vers[j], bestVer)) {
          best = svd;
          bestVer = vers[j];
        }
        break;
      }
    }
  }
  return best;
}

function findSvd(root, flavor) {
  const key = flavor === 'h750' ? 'h750.svdFile' : 'f429.svdFile';
  const set = firstExisting([cfg.get(root, key, '')]);
  if (set) return slash(set);
  const packed = findPackedSvd(root, flavor);
  return packed ? slash(packed) : '';
}

function findGdb(root) {
  const direct = firstExisting([cfg.get(root, 'gdbPath', '')]);
  if (direct) return slash(direct);
  throw new Error('找不到 arm-none-eabi-gdb.exe，请在 .zkz/settings.json 设置 keil.gdbPath。');
}

function baseConfig(root, flavor) {
  const device = String(cfg.get(
    root,
    flavor === 'h750' ? 'h750.device' : 'f429.device',
    flavor === 'h750' ? 'STM32H750IB' : 'STM32F429BI'
  ));
  const gdbPath = findGdb(root);
  const svdFile = findSvd(root, flavor);
  const config = {
    type: 'cortex-debug',
    request: 'attach',
    cwd: '${workspaceFolder}',
    executable: '${workspaceFolder}/.zkz/output.axf',
    servertype: 'jlink',
    device: '${command:zkz-keil.device}',
    interface: 'swd',
    serverpath: '${command:zkz-keil.jlinkGdbServerPath}',
    gdbPath: '${command:zkz-keil.gdbPath}',
    debuggerArgs: ['-x', '${workspaceFolder}/.zkz/gdb_source_map.gdb'],
    showDevDebugOutput: 'raw',
    rtos: 'FreeRTOS',
    serverArgs: ['-speed', '${command:zkz-keil.debugSpeed}'],
    overrideAttachCommands: ['monitor flash breakpoints = 1']
  };
  config.svdFile = '${command:zkz-keil.svdFile}';
  return { device: device, gdbPath: gdbPath, svdFile: svdFile, config: config };
}

function managedConfigs(root) {
  const flavor = resolveKeilLayout(root).flavor;
  const built = baseConfig(root, flavor);
  const buildDebug = Object.assign({ name: '编译调试' }, built.config, {
    preLaunchTask: 'zkz-keil: Build + Flash + Prepare Debug'
  });
  const debugOnly = Object.assign({ name: '调试' }, built.config, {
    preLaunchTask: 'zkz-keil: Prepare Cortex Debug'
  });
  return {
    flavor: flavor,
    device: built.device,
    gdbPath: built.gdbPath,
    svdFile: built.svdFile,
    configurations: [buildDebug, debugOnly]
  };
}

function loadLaunch(file) {
  if (!fs.existsSync(file)) return [];
  let obj;
  try {
    obj = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error('无法解析 launch.json: ' + (e && e.message ? e.message : e));
  }
  if (!obj || !Array.isArray(obj.configurations)) return [];
  return obj.configurations;
}

function launchText(configurations) {
  const body = JSON.stringify({ version: '2.0.0', configurations: configurations }, null, 2);
  return [
    '// Written by zkz-keil.configureLaunch.',
    '// serverpath follows keil.flavor when a debug session starts.',
    body,
    ''
  ].join('\n');
}

function writeLaunchJson(root) {
  const file = path.join(root, '.vscode', 'launch.json');
  const managed = managedConfigs(root);
  const names = {};
  for (let i = 0; i < MANAGED_NAMES.length; i++) names[MANAGED_NAMES[i]] = true;
  const rest = loadLaunch(file).filter((c) => c && !names[c.name]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, launchText(managed.configurations.concat(rest)), 'utf8');
  return {
    file: file,
    flavor: managed.flavor,
    device: managed.device,
    gdbPath: managed.gdbPath,
    svdFile: managed.svdFile
  };
}

module.exports = { writeLaunchJson, stripJsonComments, findSvd, findGdb };
