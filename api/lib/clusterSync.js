'use strict';

const crypto = require('node:crypto');

const mem = new Map();

function ttlMs() {
  const n = parseInt(process.env.CLUSTER_TTL_MS || '300000', 10);
  return Number.isFinite(n) && n > 0 ? n : 300000;
}

function keyOf(name) {
  return `gsearch:${String(name || 'state')}`;
}

function get(name) {
  const k = keyOf(name);
  const row = mem.get(k);
  if (!row) return null;
  if (Date.now() > row.exp) {
    mem.delete(k);
    return null;
  }
  return row.value;
}

function set(name, value, ttl) {
  const k = keyOf(name);
  mem.set(k, { value, exp: Date.now() + (ttl || ttlMs()) });
  return value;
}

function snapshot() {
  return {
    backend: process.env.REDIS_URL ? 'redis-env' : 'memory',
    keys: mem.size,
    node: process.env.CLUSTER_NODE || crypto.createHash('sha1').update(String(process.pid)).digest('hex').slice(0, 8),
  };
}

function reset() {
  mem.clear();
}

module.exports = { get, set, snapshot, reset, keyOf };
