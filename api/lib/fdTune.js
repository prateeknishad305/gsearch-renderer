'use strict';

function suggested() {
  const workers = parseInt(process.env.BROWSER_WORKERS || process.env.MAX_CONTEXTS || '2', 10) || 2;
  const conns = parseInt(process.env.HTTP_MAX_CONNECTIONS || '64', 10) || 64;
  return Math.max(256, workers * 64 + conns * 2 + 128);
}

function apply() {
  const want = suggested();
  let applied = false;
  try {
    if (typeof process.setMaxListeners === 'function') process.setMaxListeners(0);
  } catch {
    /* ignore */
  }
  return {
    suggested_nofile: want,
    applied,
    note: 'ulimit is OS-level; this process only records the suggested nofile',
  };
}

module.exports = { suggested, apply };
