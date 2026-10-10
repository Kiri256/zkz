'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const root = path.resolve(positional[0] || '');
const nativeSrc = path.resolve(positional[1] || path.join(__dirname, 'zkz-native', 'src'));
const codeSrc = path.resolve(positional[2] || path.join(__dirname, 'zkz-code', 'src'));
const count = 5;
const configIndex = Number(process.env.GIT_CONFIG_COUNT || 0);
process.env.GIT_CONFIG_COUNT = String(configIndex + 1);
process.env['GIT_CONFIG_KEY_' + configIndex] = 'safe.directory';
process.env['GIT_CONFIG_VALUE_' + configIndex] = root;
process.env.GIT_OPTIONAL_LOCKS = '0';

const encoding = require(path.join(nativeSrc, 'enc_table'));
const { withLock } = require(path.join(nativeSrc, 'lock'));
const { syncKeilTree } = require(path.join(nativeSrc, 'keil_tree'));
const { keilStampPath, keilNativeRoot } = require(path.join(nativeSrc, 'paths'));
const { stripCr } = require(path.join(nativeSrc, 'encoding'));
const report = { root, startedAt: new Date().toISOString(), samples: [], checks: {} };
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

function git(args, options = {}) {
  if (process.argv.includes('--current-filter')) {
    const command = '"' + process.execPath.replace(/\\/g, '/') + '" "' + path.join(nativeSrc, 'filter_process.js').replace(/\\/g, '/') + '"';
    args = ['-c', 'filter.zkznative.process=' + command].concat(args);
  }
  const result = spawnSync('git', args, {
    cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    timeout: 120000, ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('git ' + args[0] + ': ' + String(result.stderr));
  return result.stdout;
}

function status() {
  return git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
}

function stageEntries(buffer) {
  return new Map(buffer.toString('utf8').split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    return [record.slice(tab + 1), record.slice(0, tab)];
  }));
}

async function measure(phase, action, rounds = count) {
  for (let i = 0; i < rounds; i++) {
    const start = process.hrtime.bigint();
    const details = await action(i);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const sample = { phase, iteration: i + 1, ms, ...details };
    report.samples.push(sample);
    console.log(JSON.stringify(sample));
  }
}

function summarize() {
  return Array.from(new Set(report.samples.map((sample) => sample.phase))).map((phase) => {
    const values = report.samples.filter((sample) => sample.phase === phase).map((sample) => sample.ms).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return { phase, n: values.length, minMs: values[0], medianMs: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2, maxMs: values[values.length - 1] };
  });
}

async function main() {
  assert.ok(process.argv[2], 'workspace path required');
  const beforeStatus = status();
  assert.strictEqual(beforeStatus.length, 0, 'benchmark requires a clean worktree');
  const indexFile = git(['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trim();
  const indexHash = hash(fs.readFileSync(indexFile));
  const head = git(['rev-parse', 'HEAD']).toString().trim();
  const parent = git(['rev-parse', 'HEAD^']).toString().trim();
  const expectedEntries = stageEntries(git(['ls-files', '--stage', '-z']));
  const table = encoding.loadTable(root);
  const rels = Object.keys(table).sort().filter((rel) => expectedEntries.has(rel) && fs.existsSync(path.join(root, rel)));
  assert.ok(rels.length > 0, 'encoding table is empty');
  const sourceHashes = new Map(rels.map((rel) => [rel, hash(fs.readFileSync(path.join(root, rel)))]));
  const input = Buffer.from(rels.join('\0') + '\0');
  const objects = git(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).toString().trim();
  report.metadata = {
    head, parent, node: process.version, git: git(['--version']).toString().trim(),
    native: JSON.parse(fs.readFileSync(path.join(nativeSrc, '..', 'package.json'))).version,
    code: JSON.parse(fs.readFileSync(path.join(codeSrc, '..', 'package.json'))).version,
    sourceFiles: rels.length, sourceBytes: rels.reduce((sum, rel) => sum + fs.statSync(path.join(root, rel)).size, 0),
    incrementalTableChanges: git(['diff', '--name-status', parent, head, '--', '*.c', '*.h']).toString().trim(),
    filter: git(['config', '--get', 'filter.zkznative.process']).toString().trim()
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zkz-benchmark-'));
  const memoryDir = path.join(temp, 'memory');
  fs.mkdirSync(memoryDir);
  const memoryEnv = {
    ...process.env,
    NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --require "' + path.join(__dirname, 'benchmark_memory_probe.js').replace(/\\/g, '/') + '"',
    ZKZ_BENCHMARK_MEMORY_DIR: memoryDir
  };
  function collectMemory(phase, iteration) {
    for (const name of fs.readdirSync(memoryDir)) {
      const file = path.join(memoryDir, name);
      const usage = JSON.parse(fs.readFileSync(file, 'utf8'));
      report.memory.push({ phase, iteration, ...usage });
      fs.unlinkSync(file);
    }
  }
  report.memory = [];
  const probeRel = 'driver/bsp/zkz_performance_' + process.pid + '.txt';
  const probe = path.join(root, probeRel);
  let probeOwned = false;
  try {
    if (!process.argv.includes('--tree-only')) {
    await measure('git.status.clean', () => { status(); return {}; });
    await measure('git.diff.clean', () => { git(['diff', '--no-ext-diff']); return {}; });

    for (const enabled of [true, false]) {
      const prefix = enabled ? [] : ['-c', 'filter.zkznative.process=', '-c', 'filter.zkznative.clean=', '-c', 'filter.zkznative.smudge=', '-c', 'filter.zkznative.required=false'];
      const mode = enabled ? 'filter' : 'raw';
      for (let i = 0; i < count; i++) {
        const roundDir = path.join(temp, mode + '-add-' + i);
        fs.mkdirSync(roundDir);
        const objectDir = path.join(roundDir, 'objects');
        fs.mkdirSync(objectDir);
        const env = { ...memoryEnv, GIT_INDEX_FILE: path.join(roundDir, 'index'), GIT_OBJECT_DIRECTORY: objectDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
        git(['read-tree', '--empty'], { env });
        const spec = path.join(roundDir, 'paths');
        fs.writeFileSync(spec, input);
        const start = process.hrtime.bigint();
        git(prefix.concat(['add', '-f', '--pathspec-from-file=' + spec, '--pathspec-file-nul']), { env });
        const sample = { phase: 'git.add.' + mode, iteration: i + 1, ms: Number(process.hrtime.bigint() - start) / 1e6, files: rels.length };
        collectMemory('git.add.' + mode, i + 1);
        report.samples.push(sample);
        console.log(JSON.stringify(sample));
        if (enabled) {
          const staged = stageEntries(git(['ls-files', '--stage', '-z'], { env }));
          for (const rel of rels) assert.strictEqual(staged.get(rel), expectedEntries.get(rel), 'clean differs from original index: ' + rel);
        }
      }

      const checkoutIndex = path.join(temp, mode + '-checkout-index');
      const env = { ...memoryEnv, GIT_INDEX_FILE: checkoutIndex };
      git(['read-tree', 'HEAD'], { env });
      for (let i = 0; i < count; i++) {
        const output = path.join(temp, mode + '-checkout-' + i);
        fs.mkdirSync(output);
        const start = process.hrtime.bigint();
        git(prefix.concat(['checkout-index', '--force', '--prefix=' + output.replace(/\\/g, '/') + '/', '-z', '--stdin']), { env, input });
        const sample = { phase: 'git.checkout.' + mode, iteration: i + 1, ms: Number(process.hrtime.bigint() - start) / 1e6, files: rels.length };
        collectMemory('git.checkout.' + mode, i + 1);
        report.samples.push(sample);
        console.log(JSON.stringify(sample));
        if (enabled) {
          for (const rel of rels) assert.ok(stripCr(fs.readFileSync(path.join(output, rel))).equals(stripCr(fs.readFileSync(path.join(root, rel)))), 'smudge differs beyond line endings: ' + rel);
        }
      }
    }
    report.checks.gitFilterContentVerified = true;

    await measure('encoding.full', () => withLock(root, async () => {
      const result = await encoding.buildTable(root, { force: true });
      return { files: Object.keys(result.files).length };
    }));
    await measure('encoding.incremental.parentToHead', () => withLock(root, async () => {
      const result = await encoding.buildTable(root, { from: parent, to: head });
      assert.ok(result.incremental);
      return { files: Object.keys(result.files).length };
    }));

    const ccModule = path.join(codeSrc, 'compile_commands');
    await measure('compileCommands.diskCache', async () => {
      delete require.cache[require.resolve(ccModule)];
      await require(ccModule).refreshCompileCommands(root, { force: true });
      return {};
    });
    const cc = require(ccModule);
    await measure('compileCommands.memoryCache', async () => {
      await cc.refreshCompileCommands(root, { force: true });
      return {};
    });
    }

    const treeDetails = (result) => ({ written: result.written, skipped: result.skipped, pruned: result.pruned, cacheHit: !!result.cacheHit, timings: result.timings });
    await measure('tree.initial', () => withLock(root, () => treeDetails(syncKeilTree(root))), 1);
    await measure('tree.forcedFull', () => withLock(root, () => {
      const stamp = JSON.parse(fs.readFileSync(keilStampPath(root), 'utf8'));
      stamp.version = -1;
      fs.writeFileSync(keilStampPath(root), JSON.stringify(stamp));
      return treeDetails(syncKeilTree(root));
    }));
    await measure('tree.cacheHit', () => withLock(root, () => {
      const result = syncKeilTree(root);
      assert.strictEqual(result.cacheHit, true);
      return treeDetails(result);
    }));
    assert.ok(!fs.existsSync(probe), 'test probe already exists');
    fs.writeFileSync(probe, 'test probe\n', { flag: 'wx' });
    probeOwned = true;
    await withLock(root, () => syncKeilTree(root));
    await measure('tree.singleFileCopy', (i) => withLock(root, () => {
      const bytes = Buffer.from('iteration=' + i + '\n' + 'x'.repeat(4096) + '\n');
      fs.writeFileSync(probe, bytes);
      const result = syncKeilTree(root);
      assert.ok(bytes.equals(fs.readFileSync(path.join(keilNativeRoot(root), probeRel))));
      return treeDetails(result);
    }));
  } finally {
    if (probeOwned) {
      fs.unlinkSync(probe);
      await withLock(root, () => syncKeilTree(root));
    }
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temp, { recursive: true, force: true });
    report.checks.indexUnchanged = hash(fs.readFileSync(indexFile)) === indexHash;
    report.checks.sourceUnchanged = rels.every((rel) => hash(fs.readFileSync(path.join(root, rel))) === sourceHashes.get(rel));
    report.checks.statusUnchanged = status().equals(beforeStatus);
    report.checks.headUnchanged = git(['rev-parse', 'HEAD']).toString().trim() === head;
    report.finishedAt = new Date().toISOString();
    report.summary = summarize();
    const output = path.join(__dirname, 'benchmark-results');
    fs.mkdirSync(output, { recursive: true });
    const file = path.join(output, path.basename(root) + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log('REPORT ' + file);
    console.log(JSON.stringify(report.summary, null, 2));
    console.log('CHECKS ' + JSON.stringify(report.checks));
    assert.ok(report.checks.indexUnchanged && report.checks.sourceUnchanged && report.checks.statusUnchanged && report.checks.headUnchanged, 'workspace changed during benchmark; inspect report');
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
