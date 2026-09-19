'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function existsFile(p) {
  try { return !!(p && fs.existsSync(p) && fs.statSync(p).isFile()); } catch (_) { return false; }
}

function firstExisting(cands) {
  for (const c of cands) {
    const p = String(c || '').trim().replace(/^["']|["']$/g, '');
    if (existsFile(p)) return path.resolve(p);
  }
  return '';
}

function getJLinkFlashTool(flavor) {
  const kind = String(flavor || '').toLowerCase();
  if (kind === 'h750') {
    const exe = firstExisting([
      process.env.ZKZ_JLINK_698,
      'C:\\Program Files (x86)\\SEGGER\\JLink\\JLink.exe'
    ]);
    if (!exe) {
      throw new Error('J-Link 6.98 JLink.exe not found. Set ZKZ_JLINK_698.');
    }
    const flm = firstExisting([
      process.env.ZKZ_H750_FLM,
      'D:\\ruanjian\\keil\\ARM\\Flash\\STM32H750_W25Q32.FLM'
    ]);
    if (!flm) throw new Error('H750 QSPI FLM not found. Set ZKZ_H750_FLM.');
    return {
      flavor: 'h750',
      exe,
      device: 'STM32H750IB',
      speedKHz: 6000,
      flm,
      noGui: true
    };
  }
  const exe = firstExisting([
    process.env.ZKZ_JLINK_502,
    'C:\\Program Files (x86)\\SEGGER\\JLink_V502c\\JLink.exe'
  ]);
  if (!exe) throw new Error('J-Link 5.02 JLink.exe not found. Set ZKZ_JLINK_502.');
  return {
    flavor: 'f429',
    exe,
    device: 'STM32F429BI',
    speedKHz: 6000,
    flm: '',
    noGui: false
  };
}

function taskkill(image) {
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/F', '/IM', image], { windowsHide: true });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

async function stopJLinkGdbServer(log) {
  const before = Date.now();
  await taskkill('JLinkGDBServerCL.exe');
  await taskkill('JLinkGDBServer.exe');
  if (log && Date.now() - before > 50) log('Stopping J-Link GDB Server (probe in use)...');
}

function writeUtf8(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { encoding: 'utf8' });
}

function writeH750JLinkDevicesXml(dir, flmPath, fileName) {
  fs.mkdirSync(dir, { recursive: true });
  const flmAttr = String(flmPath).replace(/\\/g, '/');
  const xml = [
    '<DataBase>',
    '  <Device>',
    '    <ChipInfo Vendor="ST" Name="STM32H750IB" Core="JLINK_CORE_CORTEX_M7" WorkRAMAddr="0x20000000" WorkRAMSize="0x00010000" />',
    '    <FlashBankInfo Name="W25Q32 QSPI" BaseAddr="0x90000000" MaxSize="0x00400000" Loader="' + flmAttr + '" LoaderType="FLASH_ALGO_TYPE_CMSIS" />',
    '  </Device>',
    '</DataBase>',
    ''
  ].join('\n');
  const out = path.join(dir, fileName || 'JLinkDevices.xml');
  writeUtf8(out, xml);
  return out;
}

function installH750JLinkCustomDevice(flmPath, jlinkDir, log) {
  const appSegger = path.join(process.env.APPDATA || '', 'SEGGER');
  if (appSegger) {
    writeH750JLinkDevicesXml(path.join(appSegger, 'JLinkDevices'), flmPath, 'STM32H750IB_W25Q32.xml');
  }
  const installXml = path.join(jlinkDir, 'JLinkDevices.xml');
  if (!existsFile(installXml)) {
    if (log) log(' 6.98 JLinkDevices.xml missing; Commander will use built-in STM32H750IB');
    return false;
  }
  const destDir = path.join(jlinkDir, 'Devices', 'ST', 'STM32H750');
  const destFlm = path.join(destDir, 'STM32H750_W25Q32.FLM');
  let relLoader = 'Devices/ST/STM32H750/STM32H750_W25Q32.FLM';
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(flmPath, destFlm);
  } catch (e) {
    if (log) log(' Copy W25Q32 FLM into J-Link dir failed: ' + (e && e.message ? e.message : e));
    relLoader = String(flmPath).replace(/\\/g, '/');
  }
  let text = fs.readFileSync(installXml, 'utf8');
  if (/STM32H750_W25Q32\.FLM/.test(text)) {
    if (log) log(' H750 QSPI already uses Keil W25Q32 FLM in ' + installXml);
    return true;
  }
  const old = '<ChipInfo Vendor="ST" Name="STM32H750IB" Core="JLINK_CORE_CORTEX_M7"/>';
  const oldBank = 'Loader="Devices/ST/STM32H7/ST_STM32H745I_Disco_QSPI.elf"';
  const idx = text.indexOf(old);
  if (idx < 0) {
    if (log) log(' STM32H750IB entry not found in 6.98 JLinkDevices.xml');
    return false;
  }
  const bankIdx = text.indexOf(oldBank, idx);
  if (bankIdx < 0 || (bankIdx - idx) > 400) {
    if (log) log(' STM32H750IB QSPI loader line not found; leave stock device');
    return false;
  }
  const patched = text.slice(0, bankIdx) + ('Loader="' + relLoader + '"') + text.slice(bankIdx + oldBank.length);
  const bak = installXml + '.zkz.bak';
  try {
    if (!fs.existsSync(bak)) fs.copyFileSync(installXml, bak);
    writeUtf8(installXml, patched);
    if (log) log(' Patched 6.98 JLinkDevices.xml: STM32H750IB QSPI -> Keil W25Q32 FLM @ 0x90000000');
    return true;
  } catch (e) {
    if (log) log(' Cannot write 6.98 JLinkDevices.xml: ' + (e && e.message ? e.message : e));
    return false;
  }
}

function assertH750HexQspiOnly(hexPath, log) {
  const qspiLo = 0x9000;
  const qspiHi = 0x903F;
  const internalLo = 0x0800;
  const internalHi = 0x0801;
  const seen = [];
  const bad = [];
  const lines = fs.readFileSync(hexPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (line.length < 11 || line[0] !== ':') continue;
    const type = parseInt(line.slice(7, 9), 16);
    if (type === 4) {
      const ext = parseInt(line.slice(9, 13), 16);
      const addr = '0x' + (ext << 16).toString(16).toUpperCase().padStart(8, '0');
      if (seen.indexOf(addr) < 0) seen.push(addr);
      if (ext >= internalLo && ext <= internalHi) bad.push('internal flash ' + addr + ' (boot)');
      else if (ext < qspiLo || ext > qspiHi) bad.push('not in QSPI 0x90000000-0x903FFFFF: ' + addr);
    } else if (type === 2) {
      bad.push('Intel HEX type 02 (segment address) is not allowed for H750 QSPI');
    }
  }
  if (!seen.length) {
    throw new Error('H750 hex has no extended linear address; refuse flash to avoid writing 0x08000000');
  }
  if (bad.length) {
    throw new Error('H750 hex is not QSPI-only; refuse flash (would risk boot). ' + bad.join('; '));
  }
  if (log) log(' HEX ranges: ' + seen.join(', ') + '  (QSPI only, boot 0x08000000 untouched)');
}

function writeJLinkFlashSettingsIni(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ini = [
    '[FLASH]',
    'SkipProgOnCRCMatch = 0',
    'VerifyDownload = 1',
    'AllowCaching = 0',
    'EnableFlashDL = 2',
    'Override = 0',
    'Device="UNSPECIFIED"',
    '[CPU]',
    'OverrideMemMap = 0',
    'AllowSimulation = 1',
    'ScriptFile=""',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'JLinkSettings.ini'), ini, 'ascii');
  return dir;
}

function runCaptured(exe, args, cwd, log, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let text = '';
    const onData = (d) => {
      const s = d.toString();
      text += s;
      if (log) log(s.replace(/\r?\n$/, ''));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const cancel = () => { try { child.kill(); } catch (_) { /* ignore */ } };
    if (token) {
      if (token.isCancellationRequested) { cancel(); reject(new Error('\u5df2\u53d6\u6d88')); return; }
      token.onCancellationRequested(cancel);
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code == null ? 1 : code, text }));
  });
}

function flashFailed(code, text, noGui) {
  if (code > 1) return true;
  if (/(Cannot connect|Failed to connect|Connecting to J-Link failed|Could not connect|ERROR:|Programming failed|Failed to open file|Unspecified error|No emulators|Cannot find flash|Failed to download)/i.test(text)) {
    return true;
  }
  if (text && !/(O\.K\.|Flash download|Script processing completed|Downloading)/i.test(text)) {
    if (code > 0) return true;
  }
  return false;
}

async function pinResetAfterFlash(workDir, device, log) {
  const exe698 = firstExisting([
    process.env.ZKZ_JLINK_698,
    'C:\\Program Files (x86)\\SEGGER\\JLink\\JLink.exe'
  ]);
  if (!exe698) {
    if (log) log('Skip pin-reset: J-Link 6.98 JLink.exe not found');
    return;
  }
  const scriptPath = path.join(workDir, 'pinreset.jlink');
  fs.writeFileSync(scriptPath, [
    'si 1', 'speed 6000', 'device ' + device, 'RSetType 2', 'rx 100', 'g', 'qc', ''
  ].join('\r\n'), 'ascii');
  if (log) log('');
  if (log) log(' Pin reset (698): ' + exe698);
  await runCaptured(exe698, [
    '-NoGui', '1', '-ExitOnError', '1', '-AutoConnect', '1',
    '-Device', device, '-If', 'SWD', '-Speed', '6000',
    '-CommanderScript', scriptPath
  ], workDir, log, null);
}

async function invokeJLinkHexFlash(opts) {
  const tool = opts.tool;
  const log = opts.log || (() => { });
  const hexFull = path.resolve(opts.hexPath);
  if (tool.flavor === 'h750') assertH750HexQspiOnly(hexFull, log);
  const cmdWork = writeJLinkFlashSettingsIni(path.join(opts.workDir, '.zkz', 'jlink_flash'));
  const scriptPath = path.join(cmdWork, 'flash.jlink');
  const lines = [
    'device ' + tool.device,
    'si 1',
    'speed ' + tool.speedKHz
  ];
  if (tool.noGui) lines.push('connect');
  lines.push('r', 'h', 'loadfile "' + hexFull + '"');
  if (tool.noGui) lines.push('RSetType 2', 'rx 100');
  else lines.push('r');
  lines.push('g', 'qc', '');
  fs.writeFileSync(scriptPath, lines.join('\r\n'), 'ascii');

  const args = [];
  if (tool.noGui) {
    args.push('-NoGui', '1', '-ExitOnError', '1', '-AutoConnect', '1',
      '-Device', tool.device, '-If', 'SWD', '-Speed', String(tool.speedKHz));
    if (tool.flm) {
      installH750JLinkCustomDevice(tool.flm, path.dirname(tool.exe), log);
      writeH750JLinkDevicesXml(path.join(cmdWork, 'jlink_devices'), tool.flm);
    }
    args.push('-CommanderScript', scriptPath);
  } else {
    args.push('-CommanderScript', scriptPath);
  }

  log(' JLink: ' + tool.exe);
  log(' Device: ' + tool.device + '  Speed: ' + tool.speedKHz + ' kHz');
  log(' Script: ' + scriptPath);
  log('');

  const result = await runCaptured(tool.exe, args, cmdWork, log, opts.token);
  const failed = flashFailed(result.code, result.text, tool.noGui);
  if (!failed && tool.noGui) {
    await pinResetAfterFlash(cmdWork, tool.device, log);
  }
  if (opts.logFile) {
    try { fs.writeFileSync(opts.logFile, result.text, 'utf8'); } catch (_) { /* ignore */ }
  }
  return { exitCode: result.code, failed, logFile: opts.logFile };
}

module.exports = {
  getJLinkFlashTool,
  stopJLinkGdbServer,
  invokeJLinkHexFlash
};
