'use strict';

// Long-lived Chromium manager.
//
// On serverless (Vercel) a browser does not survive between invocations, so the
// cache simply misses each time and behaviour matches the old per-request
// launch. On a self-hosted container/VM (Fly, Railway, Render, a VPS) the module
// stays alive and the browser is reused across requests, which removes the
// per-query launch cost (~1-3s) and keeps warm cookies. Set BROWSER_REUSE=0 to
// force the old one-browser-per-request behaviour everywhere.
//
// A small semaphore bounds how many contexts (tabs) run at once so a burst of
// concurrent requests cannot exhaust container memory.

const { launchBrowser, parseProxy, stealthMarkup, resolveUA, DESKTOP_UA } = require('./browser');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const IDLE_MS = intEnv('BROWSER_IDLE_MS', 120000);
const MAX_CONTEXTS = intEnv('MAX_CONTEXTS', 4);

const cache = new Map(); // key -> { browser, lastUsed, timer }
let active = 0;
const waiters = [];

async function acquireSlot() {
  if (active < MAX_CONTEXTS) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function releaseSlot() {
  if (active > 0) active -= 1;
  const next = waiters.shift();
  if (next) next();
}

function scheduleIdleClose(key, entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (cache.get(key) !== entry) return;
    if (Date.now() - entry.lastUsed < IDLE_MS) return scheduleIdleClose(key, entry);
    cache.delete(key);
    entry.browser.close().catch(() => {});
  }, IDLE_MS);
  if (entry.timer.unref) entry.timer.unref();
}

async function getBrowser({ disableHttp2 = false } = {}) {
  const reuse = String(process.env.BROWSER_REUSE || '1') !== '0';
  const key = disableHttp2 ? 'h1' : 'h2';

  if (reuse) {
    const entry = cache.get(key);
    if (entry && entry.browser.isConnected()) {
      entry.lastUsed = Date.now();
      scheduleIdleClose(key, entry);
      return entry.browser;
    }
    if (entry) cache.delete(key);
  }

  const browser = await launchBrowser({ disableHttp2 });
  browser.on('disconnected', () => {
    const entry = cache.get(key);
    if (entry && entry.browser === browser) cache.delete(key);
  });
  if (reuse) {
    const entry = { browser, lastUsed: Date.now(), timer: null };
    cache.set(key, entry);
    scheduleIdleClose(key, entry);
  }
  return browser;
}

// Builds a fresh isolated context (cookies/cache/UA per query) on a shared
// browser. Proxy credentials are split out of the URL the same way as before.
async function newContext(browser, { proxy } = {}) {
  const ua = await resolveUA(browser, DESKTOP_UA);
  const opts = {
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: ua,
    viewport: { width: 1366, height: 900 },
    colorScheme: 'light',
  };
  if (proxy) opts.proxy = parseProxy(proxy);
  const context = await browser.newContext(opts);
  await context.addInitScript(stealthMarkup);
  return context;
}

async function withBrowser(opts, fn) {
  await acquireSlot();
  try {
    const browser = await getBrowser({ disableHttp2: !!opts.proxy });
    return await fn(browser);
  } finally {
    releaseSlot();
  }
}

function stats() {
  const browsers = [];
  for (const [key, entry] of cache.entries()) {
    browsers.push({
      mode: key,
      connected: entry.browser.isConnected(),
      idle_ms: Date.now() - entry.lastUsed,
    });
  }
  return {
    reuse: String(process.env.BROWSER_REUSE || '1') !== '0',
    max_contexts: MAX_CONTEXTS,
    active,
    queued: waiters.length,
    browsers,
  };
}

async function closeAll() {
  for (const [, entry] of cache.entries()) {
    if (entry.timer) clearTimeout(entry.timer);
    await entry.browser.close().catch(() => {});
  }
  cache.clear();
}

module.exports = { getBrowser, newContext, withBrowser, stats, closeAll };
