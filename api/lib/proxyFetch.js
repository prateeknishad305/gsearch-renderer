'use strict';

const http = require('http');
const { URL } = require('url');
const { splitPool, intEnv } = require('./proxyPool');

const PROXY_FETCH_URL = 'https://etherealproxyfetch.onrender.com/live.txt';

let livePool = [];
let refreshTimer = null;
let inFlight = null;
const state = {
  url: PROXY_FETCH_URL,
  last_fetch_ms: 0,
  last_ok_ms: 0,
  fetched: 0,
  checked: 0,
  alive: 0,
  error: null,
};

function fetchUrl() {
  return String(process.env.PROXY_FETCH_URL || PROXY_FETCH_URL).trim() || PROXY_FETCH_URL;
}

function enabled() {
  if (String(process.env.PROXY_FETCH || '1') === '0') return false;
  if (String(process.env.PROXY_POOL || '').trim()) return false;
  return true;
}

function proxyAuthHeader(u) {
  if (!u.username) return undefined;
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password || '');
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function checkConnect(proxy, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(proxy);
    } catch {
      resolve(false);
      return;
    }
    const req = http.request({
      host: u.hostname,
      port: Number(u.port) || 80,
      method: 'CONNECT',
      path: 'example.com:443',
      timeout: timeoutMs,
      headers: (() => {
        const auth = proxyAuthHeader(u);
        return auth ? { 'Proxy-Authorization': auth } : {};
      })(),
    });
    const done = (ok) => {
      req.destroy();
      resolve(ok);
    };
    req.on('connect', (res, socket) => {
      if (socket) socket.destroy();
      done(res.statusCode === 200);
    });
    req.on('timeout', () => done(false));
    req.on('error', () => done(false));
    req.end();
  });
}

function checkHttpGet(proxy, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(proxy);
    } catch {
      resolve(false);
      return;
    }
    const headers = { Host: 'example.com' };
    const auth = proxyAuthHeader(u);
    if (auth) headers['Proxy-Authorization'] = auth;
    const req = http.request({
      host: u.hostname,
      port: Number(u.port) || 80,
      method: 'GET',
      path: 'http://example.com/',
      timeout: timeoutMs,
      headers,
    });
    const done = (ok) => {
      req.destroy();
      resolve(ok);
    };
    req.on('response', (res) => {
      res.resume();
      done(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => done(false));
    req.on('error', () => done(false));
    req.end();
  });
}

async function checkProxy(proxy, timeoutMs) {
  const t = timeoutMs || intEnv('PROXY_CHECK_MS', 4000);
  if (await checkConnect(proxy, t)) return true;
  return checkHttpGet(proxy, t);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function downloadList() {
  const url = fetchUrl();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), intEnv('PROXY_FETCH_TIMEOUT_MS', 20000));
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'gsearch-renderer' } });
    if (!res.ok) throw new Error(`proxy fetch HTTP ${res.status}`);
    const raw = await res.text();
    return splitPool(raw);
  } finally {
    clearTimeout(timer);
  }
}

async function refreshLivePool() {
  if (!enabled()) return livePool;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const all = shuffle(await downloadList());
      state.last_fetch_ms = Date.now();
      state.fetched = all.length;
      state.error = null;

      const checkMax = Math.min(all.length, intEnv('PROXY_CHECK_MAX', 30));
      const want = Math.min(checkMax, intEnv('PROXY_LIVE_MIN', 8));
      const concurrency = intEnv('PROXY_CHECK_CONCURRENCY', 8);
      const timeoutMs = intEnv('PROXY_CHECK_MS', 4000);
      const candidates = all.slice(0, checkMax);
      const alive = [];
      let checked = 0;

      await mapLimit(candidates, concurrency, async (proxy) => {
        if (alive.length >= want) return;
        checked += 1;
        if (await checkProxy(proxy, timeoutMs)) alive.push(proxy);
      });

      state.checked = checked;
      if (alive.length) {
        livePool = alive;
        state.alive = alive.length;
        state.last_ok_ms = Date.now();
      } else {
        state.alive = livePool.length;
        if (!livePool.length) state.error = 'no live proxies passed check';
      }
      return livePool;
    } catch (err) {
      state.error = err.message || String(err);
      state.last_fetch_ms = Date.now();
      return livePool;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function startProxyFetcher() {
  if (!enabled()) return;
  refreshLivePool().catch(() => {});
  const every = intEnv('PROXY_FETCH_INTERVAL_MS', 600000);
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshLivePool().catch(() => {});
  }, every);
  if (refreshTimer.unref) refreshTimer.unref();
}

function stopProxyFetcher() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function getLivePool() {
  return livePool.slice();
}

function setLivePoolForTests(list) {
  livePool = Array.isArray(list) ? list.slice() : [];
  state.alive = livePool.length;
}

function fetcherInfo() {
  return {
    url: fetchUrl(),
    enabled: enabled(),
    last_fetch_ms: state.last_fetch_ms,
    last_ok_ms: state.last_ok_ms,
    fetched: state.fetched,
    checked: state.checked,
    alive: state.alive,
    error: state.error,
  };
}

module.exports = {
  PROXY_FETCH_URL,
  checkProxy,
  refreshLivePool,
  startProxyFetcher,
  stopProxyFetcher,
  getLivePool,
  setLivePoolForTests,
  fetcherInfo,
};
