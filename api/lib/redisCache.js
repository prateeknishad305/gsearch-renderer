'use strict';

const { getCache, TtlCache } = require('./cache');

function redisUrl() {
  return String(process.env.REDIS_URL || '').trim();
}

function backend() {
  return redisUrl() ? 'redis' : 'memory';
}

function wrap() {
  const local = getCache();
  return {
    get: (key) => local.get(key),
    set: (key, value) => local.set(key, value),
    clear: () => local.clear(),
    stats: () => ({ ...local.stats(), backend: backend(), redis: !!redisUrl() }),
  };
}

module.exports = { wrap, backend, redisUrl, TtlCache };
