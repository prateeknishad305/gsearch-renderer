'use strict';

const { proxyKey, intEnv } = require('./google');

const slots = Object.create(null);

function openAfter() {
  return Math.max(1, intEnv('GOOGLE_IP_FAILS', 2));
}

function openMs() {
  return Math.max(1000, intEnv('GOOGLE_IP_COOLDOWN_MS', 180000));
}

function slot(proxy) {
  const k = proxyKey(proxy);
  if (!slots[k]) {
    slots[k] = {
      ok: 0,
      blocked: 0,
      empty: 0,
      error: 0,
      consecutive_fail: 0,
      skip_until: 0,
      last_code: null,
      uses: 0,
    };
  }
  return slots[k];
}

function isOpen(proxy) {
  return Date.now() < (slot(proxy).skip_until || 0);
}

function shouldSkip(proxy) {
  return !!proxy && isOpen(proxy);
}

function remainingMs(proxy) {
  return Math.max(0, (slot(proxy).skip_until || 0) - Date.now());
}

function record(proxy, code) {
  const s = slot(proxy);
  s.last_code = code || null;
  s.uses += 1;
  if (code === 'OK') {
    s.ok += 1;
    s.consecutive_fail = 0;
    s.skip_until = 0;
    return;
  }
  if (code === 'BLOCKED' || code === 'SORRY') s.blocked += 1;
  else if (code === 'EMPTY_RESULTS' || code === 'SOFT_BLOCK') s.empty += 1;
  else s.error += 1;
  s.consecutive_fail += 1;
  if (s.consecutive_fail >= openAfter()) s.skip_until = Date.now() + openMs();
}

function snapshot() {
  const now = Date.now();
  const out = {};
  for (const [k, s] of Object.entries(slots)) {
    out[k] = {
      ok: s.ok,
      blocked: s.blocked,
      empty: s.empty,
      error: s.error,
      consecutive_fail: s.consecutive_fail,
      open: now < s.skip_until,
      skip_remaining_ms: Math.max(0, s.skip_until - now),
      last_code: s.last_code,
      uses: s.uses,
    };
  }
  return out;
}

function reset() {
  for (const k of Object.keys(slots)) delete slots[k];
}

function pickOpen(list) {
  return (list || []).filter((p) => !isOpen(p));
}

module.exports = { isOpen, shouldSkip, remainingMs, record, snapshot, reset, pickOpen, proxyKey, openAfter, openMs };
