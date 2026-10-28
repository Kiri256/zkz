'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./keil_config');

/** J-Link 6.98 JLinkDevices.xml 里 STM32H750IB 的 ChipInfo 行。 */
const H750_JLINK_CHIP_INFO = '<ChipInfo Vendor="ST" Name="STM32H750IB" Core="JLINK_CORE_CORTEX_M7"/>';
/** 同一条目里自带的 QSPI loader。来源：J-Link 6.98 Devices/ST/STM32H7。 */
const H750_STOCK_QSPI_LOADER = 'Loader="Devices/ST/STM32H7/ST_STM32H745I_Disco_QSPI.elf"';
/** ChipInfo 到 loader 行的最大间距。超过则视为不是这条设备，避免误改别的芯片。 */
const H750_LOADER_SEARCH_WINDOW = 400;

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

function jlinkExeCandidates(root, flavor) {
  const prefix = String(flavor || '').toLowerCase() === 'h750' ? 'h750' : 'f429';
  return [
    cfg.get(root, prefix + '.jlinkPath', ''),
    cfg.get(root, prefix + '.jlinkGdbServerPath', '')
  ];
}

function jlinkMissingMessage(flavor) {
  const prefix = String(flavor || '').toLowerCase() === 'h750' ? 'h750' : 'f429';
  return '找不到 J-Link.exe，请在 .zkz/settings.json 设置 keil.' + prefix + '.jlinkPath。';
}

function isGdbServerName(file) {
  return /^jlinkgdbserver/i.test(path.basename(String(file || '')));
}

function jlinkExe(root, flavor) {
  const cands = jlinkExeCandidates(root, flavor);
  for (let i = 0; i < cands.length; i++) {
    const p = String(cands[i] || '').trim().replace(/^["']|["']$/g, '');
    if (p && isGdbServerName(p)) continue;
    if (existsFile(p)) return path.resolve(p);
  }
  const exe = firstExisting(cands);
  if (exe && !isGdbServerName(exe)) return exe;
  throw new Error(jlinkMissingMessage(flavor));
}

function jlinkGdbServerPath(root, flavor) {
  const cands = jlinkExeCandidates(root, flavor);
  for (let i = 0; i < cands.length; i++) {
    const p = String(cands[i] || '').trim().replace(/^["']|["']$/g, '');
    if (p && isGdbServerName(p) && existsFile(p)) return path.resolve(p);
  }
  const exe = jlinkExe(root, flavor);
  const dir = path.dirname(exe);
  const cl = path.join(dir, 'JLinkGDBServerCL.exe');
  if (existsFile(cl)) return cl;
  const gui = path.join(dir, 'JLinkGDBServer.exe');
  if (existsFile(gui)) return gui;
  throw new Error('在 J-Link 目录旁找不到 JLinkGDBServerCL.exe：' + exe);
}

function getJLinkFlashTool(root, flavor) {
  const kind = String(flavor || '').toLowerCase();
  const speedKHz = cfg.getNumber(root, 'speedKHz', 6000);
  const patchGlobal = cfg.get(root, 'patchGlobalJLinkDevices', true) !== false;
  if (kind === 'h750') {
    const exe = jlinkExe(root, 'h750');
    const flm = firstExisting([cfg.get(root, 'h750.flmPath', '')]);
    if (!flm) throw new Error('找不到 H750 的 QSPI FLM，请在 .zkz/settings.json 设置 keil.h750.flmPath。');
    return {
      flavor: 'h750',
      exe,
      device: String(cfg.get(root, 'h750.device', 'STM32H750IB')),
      speedKHz,
      flm,
      qspiBase: parseInt(String(cfg.get(root, 'h750.qspiBase', '0x90000000')), 16) || 0x90000000,
      qspiSize: parseInt(String(cfg.get(root, 'h750.qspiSize', '0x00400000')), 16) || 0x00400000,
      noGui: true,
      patchGlobal: patchGlobal
    };
  }
  const exe = jlinkExe(root, 'f429');
  return {
    flavor: 'f429',
    exe,
    device: String(cfg.get(root, 'f429.device', 'STM32F429BI')),
    speedKHz,
    flm: '',
    noGui: false,
    patchGlobal: patchGlobal
  };
}

function taskkillPid(pid) {
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

function decodeProcText(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  return buf.toString('utf8');
}

function listImageProcesses(image) {
  const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='" + image + "'\" | ForEach-Object { Write-Output (($_.ProcessId).ToString() + '|' + [string]$_.ExecutablePath) }";
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr.on('data', () => { });
    child.on('error', () => resolve({ ok: false, rows: [] }));
    child.on('close', (code) => {
      const rows = [];
      const text = decodeProcText(Buffer.concat(chunks));
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const bar = t.indexOf('|');
        if (bar <= 0) continue;
        const pid = parseInt(t.slice(0, bar), 10);
        const exe = t.slice(bar + 1).trim();
        if (pid > 0 && exe) rows.push({ pid: pid, exe: exe });
      }
      resolve({ ok: code === 0, rows: rows });
    });
  });
}

function samePath(a, b) {
  try { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); } catch (_) { return false; }
}

/** 只结束与这次 JLink.exe 同目录的 GDB Server。扩展宿主线程调用。 */
async function stopJLinkGdbServer(log, jlinkExe) {
  const dir = jlinkExe ? path.dirname(path.resolve(jlinkExe)) : '';
  if (!dir) return;
  const names = ['JLinkGDBServerCL.exe', 'JLinkGDBServer.exe'];
  const victims = [];
  for (let i = 0; i < names.length; i++) {
    const want = path.join(dir, names[i]);
    const listed = await listImageProcesses(names[i]);
    if (!listed.ok) {
      if (log) log('无法列出 ' + names[i] + '，不结束其它调试服务');
      continue;
    }
    for (let j = 0; j < listed.rows.length; j++) {
      if (samePath(listed.rows[j].exe, want)) victims.push(listed.rows[j]);
    }
  }
  if (log && victims.length) log('正在断开 J-Link GDB Server（调试器占用中）');
  for (let i = 0; i < victims.length; i++) await taskkillPid(victims[i].pid);
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

/** 默认只改安装目录的 JLinkDevices.xml。关掉全局补丁时改写用户目录那份。扩展宿主线程调用。 */
function installH750JLinkCustomDevice(flmPath, jlinkDir, log, patchGlobal) {
  if (patchGlobal === false) {
    const appSegger = path.join(process.env.APPDATA || '', 'SEGGER');
    if (appSegger) {
      writeH750JLinkDevicesXml(path.join(appSegger, 'JLinkDevices'), flmPath, 'STM32H750IB_W25Q32.xml');
    }
    if (log) log(' Skip global JLinkDevices.xml (keil.patchGlobalJLinkDevices=false)');
    return true;
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
    if (log) log(' H750 QSPI already uses target FLM STM32H750_W25Q32.FLM; skip patch ' + installXml);
    return true;
  }
  const old = H750_JLINK_CHIP_INFO;
  const oldBank = H750_STOCK_QSPI_LOADER;
  const idx = text.indexOf(old);
  if (idx < 0) {
    if (log) log(' STM32H750IB entry not found in 6.98 JLinkDevices.xml');
    return false;
  }
  const bankIdx = text.indexOf(oldBank, idx);
  if (bankIdx < 0 || (bankIdx - idx) > H750_LOADER_SEARCH_WINDOW) {
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

function parseIntelHex(text) {
  const recs = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    if (line[0] !== ':') {
      throw new Error('HEX 第 ' + (n + 1) + ' 行缺少起始符');
    }
    const hex = line.slice(1);
    if (hex.length < 10 || (hex.length % 2)) {
      throw new Error('HEX 第 ' + (n + 1) + ' 行长度不对');
    }
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) {
      const b = parseInt(hex.slice(i, i + 2), 16);
      if (!isFinite(b)) throw new Error('HEX 第 ' + (n + 1) + ' 行含有非十六进制字符');
      bytes.push(b);
    }
    const count = bytes[0];
    if (bytes.length !== count + 5) {
      throw new Error('HEX 第 ' + (n + 1) + ' 行记录长度不符（count=' + count + '）');
    }
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xff;
    if (sum !== 0) throw new Error('HEX 第 ' + (n + 1) + ' 行校验和不符');
    recs.push({
      count: count,
      addr: (bytes[1] << 8) | bytes[2],
      type: bytes[3],
      data: bytes.slice(4, 4 + count)
    });
  }
  return recs;
}

function assertH750HexQspiOnly(hexPath, log, tool) {
  const qspiBase = (tool && tool.qspiBase) || 0x90000000;
  const qspiSize = (tool && tool.qspiSize) || 0x00400000;
  const qspiLo = (qspiBase >>> 16) & 0xffff;
  const qspiHi = ((qspiBase + qspiSize - 1) >>> 16) & 0xffff;
  const internalLo = 0x0800;
  const internalHi = 0x0801;
  const seen = [];
  const bad = [];
  let dataBeforeExt = false;
  const recs = parseIntelHex(fs.readFileSync(hexPath, 'utf8'));
  for (const rec of recs) {
    if (rec.type === 4) {
      const ext = rec.data.length >= 2 ? ((rec.data[0] << 8) | rec.data[1]) : 0;
      const addr = '0x' + (ext << 16).toString(16).toUpperCase().padStart(8, '0');
      if (seen.indexOf(addr) < 0) seen.push(addr);
      if (ext >= internalLo && ext <= internalHi) bad.push('片内 ' + addr + '（boot）');
      else if (ext < qspiLo || ext > qspiHi) bad.push('不在 QSPI 0x' + qspiBase.toString(16).toUpperCase() + '：' + addr);
    } else if (rec.type === 2) {
      bad.push('不允许 Intel HEX 类型 02（段地址）');
    } else if (rec.type === 0 && rec.count > 0 && !seen.length) {
      dataBeforeExt = true;
    }
  }
  if (dataBeforeExt) bad.push('扩展地址之前有数据');
  if (!seen.length) {
    throw new Error('H750 hex 没有扩展线性地址，拒绝烧录，避免写到 0x08000000');
  }
  if (bad.length) {
    throw new Error('H750 hex 不是只含 QSPI，拒绝烧录。' + bad.join('；'));
  }
  if (log) log(' HEX 范围: ' + seen.join(', ') + '（只含 QSPI，boot 0x08000000 不动）');
}

/** 拒绝落在 F429 boot（0x08000000–0x0800BFFF）的 hex。扩展宿主线程调用。 */
function assertF429HexSkipsBoot(hexPath, log) {
  const bootLo = 0x08000000;
  const bootHi = 0x0800C000;
  let upper = 0;
  const bad = [];
  const recs = parseIntelHex(fs.readFileSync(hexPath, 'utf8'));
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if ((rec.type === 4 || rec.type === 2) && rec.data.length >= 2) {
      const seg = (rec.data[0] << 8) | rec.data[1];
      upper = rec.type === 4 ? (seg << 16) >>> 0 : (seg << 4) >>> 0;
    } else if (rec.type === 0 && rec.count > 0) {
      const start = (upper + rec.addr) >>> 0;
      const end = start + rec.count;
      if (start < bootHi && end > bootLo && bad.length < 8) {
        bad.push('0x' + start.toString(16).toUpperCase().padStart(8, '0'));
      }
    }
  }
  if (bad.length) {
    throw new Error('F429 hex 碰到 boot 0x08000000-0x0800BFFF，拒绝烧录。' + bad.join('，'));
  }
  if (log) log(' hex 避开 boot 0x08000000-0x0800BFFF');
}

const FLASH_PROGRESS_STAGES = [
  [/Comparing flash/i, '比较'],
  [/Erasing flash/i, '擦除'],
  [/Programming flash/i, '编程'],
  [/Verifying flash/i, '校验']
];

/** 从 J-Link 一行输出取通知条文案。有百分比用原文，没有就不编百分比。扩展宿主线程调用。 */
function flashProgressMessages(line) {
  const text = String(line || '');
  for (let i = 0; i < FLASH_PROGRESS_STAGES.length; i++) {
    if (!FLASH_PROGRESS_STAGES[i][0].test(text)) continue;
    const pct = text.match(/(\d+)\s*%/);
    return [pct ? FLASH_PROGRESS_STAGES[i][1] + ' ' + pct[1] + '%' : FLASH_PROGRESS_STAGES[i][1]];
  }
  const out = [];
  if (/Found SWD-DP/i.test(text) || /Device "[^"]+" selected/i.test(text)) out.push('已连接');
  if (/Downloading file/i.test(text)) out.push('下载');
  if (/Flash programming performed/i.test(text)) out.push('完成');
  return out;
}

function isFlashProgressBar(line) {
  return /(?:Comparing|Erasing|Programming|Verifying) flash/i.test(line);
}

/** 收 J-Link 标准输出。\r 进度只刷新通知，换行或 100% 才写日志。扩展宿主线程调用。 */
function createJLinkSink(log, progress) {
  let carry = '';
  let held = '';
  let lastLogged = '';
  let lastProgress = '';
  const report = (line) => {
    const msgs = flashProgressMessages(line);
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i] === lastProgress) continue;
      lastProgress = msgs[i];
      if (progress && typeof progress.report === 'function') progress.report({ message: msgs[i] });
    }
  };
  const write = (line) => {
    const shown = String(line || '').replace(/\s+$/g, '');
    if (!shown || shown === lastLogged) return;
    lastLogged = shown;
    if (log) log(shown);
    report(shown);
  };
  const drain = () => {
    while (carry.length) {
      const cr = carry.indexOf('\r');
      const lf = carry.indexOf('\n');
      if (cr < 0 && lf < 0) break;
      const cut = cr < 0 ? lf : (lf < 0 ? cr : Math.min(cr, lf));
      const line = carry.slice(0, cut);
      const sep = carry.charAt(cut);
      carry = carry.slice(cut + 1);
      if (sep === '\r') {
        if (isFlashProgressBar(line)) {
          report(line);
          if (/100\s*%/.test(line)) {
            held = '';
            write(line);
          } else held = line;
        } else if (line.replace(/\s+$/g, '')) {
          held = '';
          write(line);
        }
      } else {
        const text = line.replace(/\s+$/g, '') ? line : held;
        held = '';
        write(text);
      }
    }
  };
  return {
    push(chunk) {
      carry += String(chunk == null ? '' : chunk);
      drain();
      if (carry.replace(/\s+$/g, '')) report(carry);
    },
    end() {
      if (carry.replace(/\s+$/g, '')) write(carry);
      else if (held) write(held);
      carry = '';
      held = '';
    }
  };
}

/** 跑 J-Link 并收标准输出。取消时以「已取消」结束，不按退出码判断成败。扩展宿主线程调用。 */
function runCaptured(exe, args, cwd, log, token, progress) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    const sink = createJLinkSink(log, progress);
    let text = '';
    let settled = false;
    let cancelled = false;
    let cancelSub = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (cancelSub && typeof cancelSub.dispose === 'function') cancelSub.dispose();
      fn();
    };
    const onData = (d) => {
      const s = d.toString();
      text += s;
      sink.push(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const cancel = () => {
      cancelled = true;
      try { child.kill(); } catch (_) { /* ignore */ }
    };
    child.on('error', (err) => {
      try { sink.end(); } catch (_) { /* ignore */ }
      if (cancelled) finish(() => reject(new Error('已取消')));
      else finish(() => reject(err));
    });
    child.on('close', (code) => {
      try { sink.end(); } catch (_) { /* ignore */ }
      if (cancelled) {
        finish(() => reject(new Error('已取消')));
        return;
      }
      finish(() => resolve({ code: code == null ? 1 : code, text }));
    });
    if (token) {
      if (token.isCancellationRequested) cancel();
      else cancelSub = token.onCancellationRequested(cancel);
    }
  });
}

function flashFailed(code, text) {
  if (code > 0) return true;
  return /(Cannot connect|Failed to connect|Connecting to J-Link failed|Could not connect|ERROR:|Programming failed|Failed to open file|Unspecified error|No emulators|Cannot find flash|Failed to download)/i.test(text || '');
}

/** 烧录成功后再拉一次复位脚。速度与这次烧录相同。取消时抛出「已取消」，失败返回 true。扩展宿主线程调用。 */
async function pinResetAfterFlash(workDir, device, log, exe, speedKHz, token) {
  const exe698 = exe && existsFile(exe) ? path.resolve(exe) : '';
  if (!exe698) {
    if (log) log('Skip pin-reset: J-Link 6.98 JLink.exe not found');
    return false;
  }
  const speed = String(speedKHz || 6000);
  const scriptPath = path.join(workDir, 'pinreset.jlink');
  fs.writeFileSync(scriptPath, [
    'si 1', 'speed ' + speed, 'device ' + device, 'RSetType 2', 'rx 100', 'g', 'qc', ''
  ].join('\r\n'), 'ascii');
  if (log) log('');
  if (log) log(' Pin reset (698): ' + exe698 + '  Speed: ' + speed + ' kHz');
  const result = await runCaptured(exe698, [
    '-NoGui', '1', '-ExitOnError', '1', '-AutoConnect', '1',
    '-Device', device, '-If', 'SWD', '-Speed', speed,
    '-CommanderScript', scriptPath
  ], workDir, log, token);
  return flashFailed(result.code, result.text);
}

/** 先检查 hex 和 H750 设备描述，通过后再断开 GDB Server 并烧录。扩展宿主线程调用。 */
async function invokeJLinkHexFlash(opts) {
  const tool = opts.tool;
  const log = opts.log || (() => { });
  const hexFull = path.resolve(opts.hexPath);
  if (tool.flavor === 'h750') assertH750HexQspiOnly(hexFull, log, tool);
  if (tool.flavor === 'f429') assertF429HexSkipsBoot(hexFull, log);
  const cmdWork = path.join(opts.root, '.zkz', 'jlink_flash');
  fs.mkdirSync(cmdWork, { recursive: true });
  const scriptPath = path.join(cmdWork, 'flash.jlink');
  const lines = [];
  if (!tool.noGui) {
    lines.push('exec SuppressControlPanel');
    lines.push('exec DisableInfoWinFlashDL');
  }
  lines.push(
    'device ' + tool.device,
    'si 1',
    'speed ' + tool.speedKHz
  );
  if (tool.noGui) lines.push('connect');
  lines.push('r', 'h', 'loadfile "' + hexFull + '"');
  if (tool.noGui) lines.push('RSetType 2', 'rx 100');
  else lines.push('r');
  lines.push('g', 'qc', '');
  fs.writeFileSync(scriptPath, lines.join('\r\n'), 'ascii');

  const args = [];
  if (tool.noGui) {
    args.push('-NoGui', '1');
    args.push('-ExitOnError', '1', '-AutoConnect', '1',
      '-Device', tool.device, '-If', 'SWD', '-Speed', String(tool.speedKHz));
    if (tool.flm) {
      const patched = installH750JLinkCustomDevice(tool.flm, path.dirname(tool.exe), log, tool.patchGlobal);
      if (!patched) throw new Error('H750 的 J-Link 设备描述没有改成功，已拒绝烧录');
    }
    args.push('-CommanderScript', scriptPath);
  } else {
    args.push('-CommanderScript', scriptPath);
  }

  log(' JLink: ' + tool.exe);
  log(' Device: ' + tool.device + '  Speed: ' + tool.speedKHz + ' kHz');
  log(' Script: ' + scriptPath);
  log('');
  await stopJLinkGdbServer(log, tool.exe);

  const result = await runCaptured(tool.exe, args, cmdWork, log, opts.token, opts.progress);
  let exitCode = result.code;
  let failed = flashFailed(result.code, result.text);
  if (!failed && tool.noGui) {
    if (await pinResetAfterFlash(cmdWork, tool.device, log, tool.exe, tool.speedKHz, opts.token)) {
      failed = true;
      if (!exitCode) exitCode = 1;
    }
  }
  if (opts.logFile) {
    try { fs.writeFileSync(opts.logFile, result.text, 'utf8'); } catch (_) { /* ignore */ }
  }
  return { exitCode: exitCode, failed, logFile: opts.logFile };
}

module.exports = {
  getJLinkFlashTool,
  jlinkGdbServerPath,
  stopJLinkGdbServer,
  invokeJLinkHexFlash,
  parseIntelHex,
  assertH750HexQspiOnly,
  assertF429HexSkipsBoot,
  createJLinkSink,
  flashProgressMessages,
  runCaptured
};
