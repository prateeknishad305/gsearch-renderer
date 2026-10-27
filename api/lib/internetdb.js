'use strict';

// Official Shodan InternetDB enrichment. Free, no API key:
//   GET https://internetdb.shodan.io/<ip>
// Returns ports/hostnames/cpes/tags/vulns for a single IP.
// Requests are serialised and cached; failures are cached briefly so a dead
// endpoint cannot stall the whole search.

const TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 150;
const MAX_CACHE = 2000;

function intEnv(name, dflt) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const MAX_CONCURRENCY = intEnv('INTERNETDB_CONCURRENCY', 3);

const cache = new Map();
let active = 0;
const waiters = [];
let lastStart = 0;

async function withSlot(fn) {
  if (active >= MAX_CONCURRENCY) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastStart));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    return await fn();
  } finally {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}

function isIp(v) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(v || '').trim());
}

function parseCpe(cpe) {
  const raw = String(cpe || '').trim();
  if (!raw) return null;
  let parts;
  if (raw.startsWith('cpe:2.3:')) {
    parts = raw.split(':');
    return cleanCpe(parts[3], parts[4], parts[5]);
  }
  if (raw.startsWith('cpe:/')) {
    parts = raw.slice(5).split(':');
    return cleanCpe(parts[1], parts[2], parts[3]);
  }
  return null;
}

function cleanCpe(vendor, product, version) {
  const norm = (v) => {
    const s = String(v || '').trim();
    return !s || s === '*' || s === '-' ? null : s;
  };
  return { vendor: norm(vendor), product: norm(product), version: norm(version) };
}

function mergeInternetDb(host, data) {
  if (!host || !data) return host;
  const ports = Array.isArray(data.ports) ? data.ports.map(Number).filter((n) => Number.isFinite(n)) : [];
  const hostnames = Array.isArray(data.hostnames) ? data.hostnames.map(String).filter(Boolean) : [];
  const cpes = Array.isArray(data.cpes) ? data.cpes.map(String).filter(Boolean) : [];
  const tags = Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : [];
  const vulns = Array.isArray(data.vulns) ? data.vulns.map(String).filter(Boolean) : [];

  const existingPorts = Array.isArray(host.ports) ? host.ports.map(Number).filter(Number.isFinite) : [];
  host.ports = Array.from(new Set([...existingPorts, ...ports]));
  if (host.port == null && host.ports.length) host.port = host.ports[0];

  const existing = Array.isArray(host.hostnames) ? host.hostnames : [];
  host.hostnames = Array.from(new Set([...existing, ...hostnames.filter((h) => !isIp(h))]));
  host.domains = host.hostnames.slice();
  host.cpes = cpes;
  host.tags = tags;
  host.vulns = vulns;

  const first = cpes.map(parseCpe).find(Boolean) || null;
  if (first) {
    if (first.vendor) host.vendor = first.vendor;
    if (first.product) host.product = first.product;
    if (first.version) host.version = first.version;
  }
  if (data.ip && isIp(data.ip)) host.ip_str = String(data.ip);
  return host;
}

async function fetchHost(ip, opts = {}) {
  const address = String(ip || '').trim();
  if (!isIp(address) || (opts.enabled === false)) return null;

  const now = Date.now();
  const hit = cache.get(address);
  if (hit && now - hit.at < hit.ttl) return hit.value;

  const fetchImpl = opts.fetchImpl || global.fetch;
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 4000;

  const value = await withSlot(async () => {
    const hit2 = cache.get(address);
    if (hit2 && Date.now() - hit2.at < hit2.ttl) return hit2.value;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetchImpl(`https://internetdb.shodan.io/${encodeURIComponent(address)}`, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      if (!res || !res.ok) {
        cache.set(address, { at: Date.now(), ttl: FAIL_TTL_MS, value: null });
        return null;
      }
      const data = await res.json();
      cache.set(address, { at: Date.now(), ttl: TTL_MS, value: data });
      return data;
    } catch {
      cache.set(address, { at: Date.now(), ttl: FAIL_TTL_MS, value: null });
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
  trimCache();
  return value;
}

function trimCache() {
  if (cache.size <= MAX_CACHE) return;
  for (const key of cache.keys()) {
    if (cache.size <= MAX_CACHE) break;
    cache.delete(key);
  }
}

async function enrichShodanHosts(results, opts = {}) {
  if (!Array.isArray(results) || !results.length) return results;
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : results.length;
  const targets = results.slice(0, limit).filter((r) => r && r.host && isIp(r.host.ip_str));
  await Promise.all(
    targets.map(async (r) => {
      const data = await fetchHost(r.host.ip_str, opts);
      if (data) mergeInternetDb(r.host, data);
    })
  );
  return results;
}

function _reset() {
  cache.clear();
  active = 0;
  waiters.length = 0;
  lastStart = 0;
}

module.exports = {
  fetchHost,
  enrichShodanHosts,
  mergeInternetDb,
  parseCpe,
  isIp,
  _reset,
};
