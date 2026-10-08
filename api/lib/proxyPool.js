'use strict';

const fs = require('fs');
const path = require('path');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const SOCKS_PORTS = new Set(['1080', '1081', '1082', '9050', '9051']);

function schemeForPort(port) {
  return SOCKS_PORTS.has(String(port)) ? 'socks5' : 'http';
}

function normalizeProxy(s) {
  const line = String(s || '').trim();
  if (!line || line.startsWith('#')) return null;
  if (/^(https?|socks5h?|socks4a?):\/\//i.test(line)) return line;
  if (/^[^/@:\s]+:\d+$/.test(line)) {
    const port = line.slice(line.lastIndexOf(':') + 1);
    return `${schemeForPort(port)}://${line}`;
  }
  const m = line.match(/^([^/@:\s]+):(\d+):([^:\s]+):(.+)$/);
  if (!m) return null;
  return `${schemeForPort(m[2])}://${encodeURIComponent(m[3])}:${encodeURIComponent(m[4])}@${m[1]}:${m[2]}`;
}

function altProxy(proxy) {
  const p = String(proxy || '');
  if (/^socks5h?:\/\//i.test(p)) return p.replace(/^socks5h?:/i, 'http:');
  if (/^https?:\/\//i.test(p)) return p.replace(/^https?:/i, 'socks5:');
  return null;
}

// Reads a newline/comma separated list of proxy URLs. Lines may be "# comment"-
// prefixed. Accepts http(s)://user:pass@host:port, host:port, or host:port:user:pass.
function splitPool(raw) {
  return String(raw || '')
    .split(/[\n,]/)
    .map(normalizeProxy)
    .filter(Boolean);
}

// Keeps only every Nth entry. Used to give each hosted API instance its own
// disjoint slice of the pool so two instances never hammer the same exit IP.
function shardPool(pool, index, total) {
  if (!total || total <= 1) return pool.slice();
  const start = ((index % total) + total) % total;
  return pool.filter((_, i) => i % total === start);
}

function filePool() {
  const candidates = [
    process.env.PROXY_POOL_FILE,
    path.join(__dirname, 'proxies.txt'),
    path.join(__dirname, '..', 'proxies.txt'),
    path.join(process.cwd(), 'proxies.txt'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const pool = splitPool(raw);
      if (pool.length) return pool;
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

const MAX_USER_PROXIES = Math.min(100, Math.max(1, parseInt(process.env.USER_PROXY_MAX || '50', 10) || 50));
let userPool = [];

function getUserProxies() {
  return userPool.slice();
}

function setUserProxies(raw) {
  const list = Array.isArray(raw) ? splitPool(raw.join('\n')) : splitPool(raw);
  const uniq = [];
  const seen = new Set();
  for (const p of list) {
    if (seen.has(p)) continue;
    seen.add(p);
    uniq.push(p);
    if (uniq.length >= MAX_USER_PROXIES) break;
  }
  userPool = uniq;
  return userPool.slice();
}

function clearUserProxies() {
  userPool = [];
}

function getProxyPool() {
  if (userPool.length) return userPool.slice();
  if (process.env.PROXY_SERVER !== undefined) {
    const one = String(process.env.PROXY_SERVER || '').trim();
    return one ? splitPool(one) : [];
  }
  const envPool = String(process.env.PROXY_POOL || '').trim();
  if (envPool) return splitPool(envPool);
  try {
    const { getLivePool } = require('./proxyFetch');
    const live = getLivePool();
    if (live.length) return live;
  } catch {
    /* proxyFetch not loaded yet */
  }
  return filePool();
}

// Pool for THIS instance: full list unless PROXY_SHARD_TOTAL>1, in which case
// only the shard for PROXY_SHARD_INDEX is used. Falls back to the full pool if
// the shard ends up empty so a bad config never disables proxies entirely.
function getShardPool() {
  const pool = getProxyPool();
  const total = intEnv('PROXY_SHARD_TOTAL', 1);
  if (total <= 1 || pool.length === 0) return pool;
  const index = Math.max(0, parseInt(process.env.PROXY_SHARD_INDEX || '0', 10) || 0);
  const shard = shardPool(pool, index, total);
  return shard.length ? shard : pool;
}

const googleUsed = new Set();
const googleSticky = new Map();
const STICKY_TTL_MS = 5 * 60 * 1000;

function proxyIdentity(p) {
  if (!p) return 'direct';
  try {
    const u = new URL(p);
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return String(p);
  }
}

function takeGoogleProxy(pool, exclude) {
  const skip = exclude instanceof Set ? exclude : new Set();
  const list = (Array.isArray(pool) ? pool : []).filter(Boolean);
  if (!list.length) return null;
  let unused = list.filter((p) => {
    const id = proxyIdentity(p);
    return !googleUsed.has(id) && !skip.has(id);
  });
  if (!unused.length) {
    unused = list.filter((p) => !skip.has(proxyIdentity(p)));
    if (!unused.length) {
      googleUsed.clear();
      unused = list.slice();
    }
  }
  if (!unused.length) return null;
  const pick = unused[Math.floor(Math.random() * unused.length)];
  googleUsed.add(proxyIdentity(pick));
  return pick;
}

function peekStickyGoogleProxy(key) {
  const k = String(key || '');
  if (!k) return null;
  const hit = googleSticky.get(k);
  if (hit && Date.now() - hit.at < STICKY_TTL_MS) return hit.proxy;
  if (hit) googleSticky.delete(k);
  return null;
}

function takeStickyGoogleProxy(key, pool) {
  const peek = peekStickyGoogleProxy(key);
  if (peek) return peek;
  return takeGoogleProxy(pool);
}

function setStickyGoogleProxy(key, proxy) {
  const k = String(key || '');
  if (!k || !proxy) return;
  googleSticky.set(k, { proxy, at: Date.now() });
}

function dropStickyGoogleProxy(key) {
  const k = String(key || '');
  if (k) googleSticky.delete(k);
}

function googleUsedCount() {
  return googleUsed.size;
}

function resetGoogleUsed() {
  googleUsed.clear();
  googleSticky.clear();
}

function poolInfo() {
  const pool = getProxyPool();
  const shard = getShardPool();
  const total = intEnv('PROXY_SHARD_TOTAL', 1);
  const index = Math.max(0, parseInt(process.env.PROXY_SHARD_INDEX || '0', 10) || 0);
  let fetcher = null;
  try {
    const raw = require('./proxyFetch').fetcherInfo();
    fetcher = {
      enabled: !!raw.enabled,
      alive: raw.alive || 0,
      last_ok_ms: raw.last_ok_ms || 0,
      error: raw.error || null,
    };
  } catch {
    /* ignore */
  }
  let source = 'none';
  if (userPool.length) source = 'user';
  else if (process.env.PROXY_SERVER !== undefined) source = String(process.env.PROXY_SERVER || '').trim() ? 'env' : 'none';
  else if (String(process.env.PROXY_POOL || '').trim()) source = 'env';
  else if (fetcher && fetcher.alive) source = 'live';
  else if (filePool().length) source = 'file';
  return {
    pool_size: pool.length,
    shard_total: total,
    shard_index: index,
    shard_size: shard.length,
    proxies_available: shard.length,
    source,
    fetcher,
  };
}

module.exports = {
  splitPool,
  shardPool,
  getProxyPool,
  getShardPool,
  poolInfo,
  intEnv,
  normalizeProxy,
  getUserProxies,
  setUserProxies,
  clearUserProxies,
  MAX_USER_PROXIES,
  altProxy,
  SOCKS_PORTS,
  proxyIdentity,
  takeGoogleProxy,
  takeStickyGoogleProxy,
  peekStickyGoogleProxy,
  setStickyGoogleProxy,
  dropStickyGoogleProxy,
  googleUsedCount,
  resetGoogleUsed,
};
