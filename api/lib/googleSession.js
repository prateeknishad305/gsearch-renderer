'use strict';

const { proxyKey, stickyEnabled, stickyLimit, mintEnabled } = require('./google');

const jar = new Map();

function key(proxy) {
  return proxyKey(proxy);
}

function get(proxy) {
  if (!stickyEnabled()) return null;
  const k = key(proxy);
  const s = jar.get(k);
  if (!s) return null;
  if (s.uses >= stickyLimit()) {
    jar.delete(k);
    return null;
  }
  return s;
}

function put(proxy, cookies, minted) {
  if (!stickyEnabled()) return;
  const k = key(proxy);
  const prev = jar.get(k) || { uses: 0, minted: false, cookies: [] };
  jar.set(k, {
    cookies: Array.isArray(cookies) ? cookies : prev.cookies,
    uses: prev.uses + 1,
    minted: minted || prev.minted,
    at: Date.now(),
  });
}

function needsMint(proxy) {
  if (!mintEnabled()) return false;
  const s = get(proxy);
  return !s || !s.minted;
}

function markMinted(proxy) {
  const k = key(proxy);
  const prev = jar.get(k) || { uses: 0, cookies: [] };
  jar.set(k, { ...prev, minted: true, at: Date.now() });
}

function drop(proxy) {
  jar.delete(key(proxy));
}

function snapshot() {
  const out = {};
  for (const [k, s] of jar.entries()) {
    out[k] = { uses: s.uses, minted: !!s.minted, cookies: (s.cookies || []).length };
  }
  return out;
}

function reset() {
  jar.clear();
}

module.exports = { get, put, needsMint, markMinted, drop, snapshot, reset, key };
