'use strict';

const OPEN_AFTER = Math.max(2, parseInt(process.env.CIRCUIT_FAILS || '3', 10) || 3);
const OPEN_MS = Math.max(5000, parseInt(process.env.CIRCUIT_MS || '120000', 10) || 120000);

const engines = Object.create(null);

function slot(engine) {
  if (!engines[engine]) {
    engines[engine] = {
      ok: 0,
      blocked: 0,
      empty: 0,
      error: 0,
      consecutive_fail: 0,
      skip_until: 0,
      last_code: null,
      last_ms: 0,
    };
  }
  return engines[engine];
}

function isOpen(engine) {
  return Date.now() < (slot(engine).skip_until || 0);
}

function record(engine, code) {
  const s = slot(engine);
  s.last_code = code || null;
  s.last_ms = Date.now();
  if (code === 'OK') {
    s.ok += 1;
    s.consecutive_fail = 0;
    s.skip_until = 0;
    return;
  }
  if (code === 'BLOCKED') s.blocked += 1;
  else if (code === 'EMPTY_RESULTS') s.empty += 1;
  else s.error += 1;
  s.consecutive_fail += 1;
  if (s.consecutive_fail >= OPEN_AFTER) s.skip_until = Date.now() + OPEN_MS;
}

function snapshot() {
  const now = Date.now();
  const out = {};
  for (const [name, s] of Object.entries(engines)) {
    out[name] = {
      ok: s.ok,
      blocked: s.blocked,
      empty: s.empty,
      error: s.error,
      consecutive_fail: s.consecutive_fail,
      open: now < s.skip_until,
      skip_remaining_ms: Math.max(0, s.skip_until - now),
      last_code: s.last_code,
    };
  }
  return out;
}

function reset() {
  for (const k of Object.keys(engines)) delete engines[k];
}

module.exports = { isOpen, record, snapshot, reset, OPEN_AFTER, OPEN_MS };
