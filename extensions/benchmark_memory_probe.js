'use strict';

// Preload only in benchmark child processes; never write to filter stdout.
const fs = require('fs');
const path = require('path');
const baseline = process.memoryUsage();
process.once('exit', () => {
  const directory = process.env.ZKZ_BENCHMARK_MEMORY_DIR;
  if (!directory) return;
  const report = {
    pid: process.pid, argv: process.argv, baseline,
    final: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS
  };
  fs.writeFileSync(path.join(directory, process.pid + '.json'), JSON.stringify(report));
});
