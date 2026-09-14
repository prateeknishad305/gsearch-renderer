'use strict';

const fs = require('fs');
const path = require('path');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

// Reads a newline/comma separated list of proxy URLs. Lines may be "# comment"-
// prefixed. Each entry is a full proxy URL, e.g. "http://user:pass@host:port"
// or "http://host:port".
function splitPool(raw) {
  return String(raw || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .filter((s) => /^https?:\/\//i.test(s) || /^[^/@:]+:\d+$/.test(s));
}

// Keeps only every Nth entry. Used to give each hosted API instance its own
// disjoint slice of the pool so two instances never hammer the same exit IP.
function shardPool(pool, index, total) {
  if (!total || total <= 1) return pool.slice();
  const start = ((index % total) + total) % total;
  return pool.filter((_, i) => i % total === start);
}

function getProxyPool() {
  const envPool = String(process.env.PROXY_POOL || '').trim();
  if (envPool) return splitPool(envPool);
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

function poolInfo() {
  const pool = getProxyPool();
  const total = intEnv('PROXY_SHARD_TOTAL', 1);
  const index = Math.max(0, parseInt(process.env.PROXY_SHARD_INDEX || '0', 10) || 0);
  return {
    pool_size: pool.length,
    shard_total: total,
    shard_index: index,
    shard_size: getShardPool().length,
  };
}

module.exports = { splitPool, shardPool, getProxyPool, getShardPool, poolInfo, intEnv };
