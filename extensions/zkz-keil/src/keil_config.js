'use strict';

const loadShared = require('./load_shared');
const settings = loadShared('zkz_settings');

function get(root, key, fallback) {
  return settings.get(root, 'keil', key, fallback);
}

function getNumber(root, key, fallback) {
  return settings.getNumber(root, 'keil', key, fallback);
}

function set(root, key, value) {
  return settings.set(root, 'keil', key, value);
}

module.exports = { get, getNumber, set };
