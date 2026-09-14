'use strict';

// Tiny TTL + LRU cache for successful search results. Duplicate dorks (common
// when scanning big wordlists) then cost nothing. Bounded so a long-lived
// container never grows without limit.

class TtlCache {
  constructor({ ttlMs = 300000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map(); // key -> { value, exp }
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() > entry.exp) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, exp: Date.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }

  stats() {
    return { size: this.map.size, max: this.max, ttl_ms: this.ttlMs, hits: this.hits, misses: this.misses };
  }
}

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

let shared = null;
function getCache() {
  if (!shared) {
    shared = new TtlCache({
      ttlMs: intEnv('CACHE_TTL_MS', 300000),
      max: intEnv('CACHE_MAX', 500),
    });
  }
  return shared;
}

module.exports = { TtlCache, getCache };
