'use strict';

function formatRelativeZh(unixSec) {
  const t = Number(unixSec) || 0;
  if (!t) return '';
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (sec < 60) return '\u521a\u521a';
  if (sec < 3600) return Math.floor(sec / 60) + ' \u5206\u949f\u524d';
  if (sec < 86400) return Math.floor(sec / 3600) + ' \u5c0f\u65f6\u524d';
  if (sec < 2592000) return Math.floor(sec / 86400) + ' \u5929\u524d';
  if (sec < 31536000) return Math.floor(sec / 2592000) + ' \u4e2a\u6708\u524d';
  return Math.floor(sec / 31536000) + ' \u5e74\u524d';
}

/** Unix \u79d2 -> \u672c\u5730\u7edd\u5bf9\u65f6\u95f4 YYYY-MM-DD HH:mm:ss */
function formatDateTimeZh(unixSec) {
  const n = Number(unixSec) || 0;
  if (!n) return '';
  const d = new Date(n * 1000);
  const pad = (x) => (x < 10 ? '0' + x : String(x));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function formatCommitTimeLine(unixSec) {
  const abs = formatDateTimeZh(unixSec);
  const rel = formatRelativeZh(unixSec);
  if (!abs && !rel) return '';
  if (abs && rel) return '\u63d0\u4ea4\u65f6\u95f4: ' + abs + ' (' + rel + ')';
  return '\u63d0\u4ea4\u65f6\u95f4: ' + (abs || rel);
}

/** ISO timestamp -> compact age for sync menu (30s / 5m / 2h / 3d). */
function ageText(iso) {
  if (!iso) return '-';
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return '-';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
}

module.exports = {
  formatRelativeZh,
  formatDateTimeZh,
  formatCommitTimeLine,
  ageText
};
