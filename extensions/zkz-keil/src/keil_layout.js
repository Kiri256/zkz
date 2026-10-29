'use strict';

const loadShared = require('./load_shared');
const { resolveKeilLayout: resolveShared, layoutOptionsFromGet } = loadShared('keil_layout');
const cfg = require('./keil_config');

function resolveKeilLayout(root) {
  return resolveShared(root, layoutOptionsFromGet(function (key, fallback) {
    return cfg.get(root, key, fallback);
  }));
}

function discoverFlavor(root) {
  return resolveKeilLayout(root).flavor;
}

module.exports = { resolveKeilLayout, discoverFlavor };
