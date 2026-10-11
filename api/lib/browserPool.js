'use strict';

const { launchBrowser, parseProxy, stealthMarkup, resolveUA, DESKTOP_UA } = require('./browser');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const IDLE_MS = intEnv('BROWSER_IDLE_MS', 120000);
const WORKERS = intEnv('BROWSER_WORKERS', intEnv('MAX_CONTEXTS', 4));
const MAX_CONTEXTS = WORKERS;

const cache = new Map();
let active = 0;
const waiters = [];
const idle = [];
let busyPages = 0;
let createdPages = 0;

function reuseOn() {
  return String(process.env.BROWSER_REUSE || '1') !== '0';
}

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
    dropIdleForBrowser(entry.browser);
    entry.browser.close().catch(() => {});
  }, IDLE_MS);
  if (entry.timer.unref) entry.timer.unref();
}

function dropIdleForBrowser(browser) {
  for (let i = idle.length - 1; i >= 0; i--) {
    if (idle[i].browser === browser) {
      const w = idle.splice(i, 1)[0];
      createdPages = Math.max(0, createdPages - 1);
      w.context.close().catch(() => {});
    }
  }
}

async function getBrowser({ disableHttp2 = false, browser: browserName } = {}) {
  const reuse = reuseOn();
  const flavorId = require('./browserFlavor').normalizeFlavor(browserName);
  const key = `${flavorId}:${disableHttp2 ? 'h1' : 'h2'}`;

  if (reuse) {
    const entry = cache.get(key);
    if (entry && entry.browser.isConnected()) {
      entry.lastUsed = Date.now();
      scheduleIdleClose(key, entry);
      return entry.browser;
    }
    if (entry) cache.delete(key);
  }

  const browser = await launchBrowser({ disableHttp2, browser: flavorId });
  browser.on('disconnected', () => {
    const entry = cache.get(key);
    if (entry && entry.browser === browser) cache.delete(key);
    dropIdleForBrowser(browser);
  });
  if (reuse) {
    const entry = { browser, lastUsed: Date.now(), timer: null };
    cache.set(key, entry);
    scheduleIdleClose(key, entry);
  }
  return browser;
}

async function newContext(browser, { proxy, hl, gl, google, browser: browserName } = {}) {
  const flavorId = require('./browserFlavor').normalizeFlavor(browserName);
  const ua = await resolveUA(browser, DESKTOP_UA, flavorId);
  const g = google ? require('./google') : null;
  const geoOpts = g ? g.contextOptions({ proxy, hl, gl, chromeMajor: (ua.match(/Chrome\/(\d+)/) || [])[1] }) : null;
  const opts = {
    locale: (geoOpts && geoOpts.locale) || 'en-US',
    timezoneId: (geoOpts && geoOpts.timezoneId) || 'America/New_York',
    userAgent: ua,
    viewport: (geoOpts && geoOpts.viewport) || { width: 1366, height: 768 },
    colorScheme: 'light',
    hasTouch: false,
    javaScriptEnabled: true,
  };
  const headers = geoOpts && geoOpts.extraHTTPHeaders ? { ...geoOpts.extraHTTPHeaders } : {};
  const ch = require('./browserFlavor').chUa(flavorId, (ua.match(/Chrome\/(\d+)/) || [])[1] || 125);
  if (ch) {
    headers['sec-ch-ua'] = ch;
  } else {
    delete headers['sec-ch-ua'];
    delete headers['sec-ch-ua-mobile'];
    delete headers['sec-ch-ua-platform'];
  }
  if (Object.keys(headers).length) opts.extraHTTPHeaders = headers;
  if (proxy) opts.proxy = parseProxy(proxy);
  const context = await browser.newContext(opts);
  if (g) await context.addInitScript(g.googleInitScript, { langs: g.languageList(geoOpts && geoOpts.geo) });
  else await context.addInitScript(stealthMarkup);
  return context;
}

function workerKey({ proxy, hl, gl, google, disableHttp2, browser: browserName }) {
  let host = 'direct';
  if (proxy) {
    try {
      const u = new URL(proxy);
      host = `${u.protocol}//${u.hostname}:${u.port || ''}`;
    } catch {
      host = 'proxy';
    }
  }
  const flavorId = require('./browserFlavor').normalizeFlavor(browserName);
  return `${flavorId}|${host}|${disableHttp2 ? 'h1' : 'h2'}|${google ? 'g' : 'n'}|${hl || 'en'}|${gl || 'us'}`;
}

async function checkout(opts) {
  const disableHttp2 = !!opts.proxy;
  const key = workerKey({ ...opts, disableHttp2 });
  const idx = idle.findIndex((w) => w.key === key && w.page && !w.page.isClosed());
  if (idx >= 0) {
    const w = idle.splice(idx, 1)[0];
    busyPages += 1;
    return w;
  }
  const browser = await getBrowser({ disableHttp2, browser: opts.browser });
  const context = await newContext(browser, opts);
  const page = await context.newPage();
  createdPages += 1;
  busyPages += 1;
  return { page, context, browser, key, disableHttp2 };
}

async function destroyWorker(w) {
  if (!w) return;
  createdPages = Math.max(0, createdPages - 1);
  await w.context.close().catch(() => {});
  if (!reuseOn() && w.browser) await w.browser.close().catch(() => {});
}

async function checkin(w) {
  busyPages = Math.max(0, busyPages - 1);
  if (!w || !w.page || w.page.isClosed() || !reuseOn()) {
    if (w) await destroyWorker(w);
    return;
  }
  try {
    await w.page.unroute('**/*').catch(() => {});
    await w.context.clearCookies().catch(() => {});
    await w.page.goto('about:blank', { waitUntil: 'commit', timeout: 2000 }).catch(() => {});
    while (idle.length >= WORKERS) {
      const old = idle.shift();
      await destroyWorker(old);
    }
    idle.push(w);
  } catch {
    await destroyWorker(w);
  }
}

async function withBrowser(opts, fn) {
  await acquireSlot();
  try {
    const browser = await getBrowser({ disableHttp2: !!opts.proxy, browser: opts.browser });
    return await fn(browser);
  } finally {
    releaseSlot();
  }
}

async function withPage(opts, fn) {
  await acquireSlot();
  let worker = null;
  try {
    worker = await checkout(opts);
    const navMs = opts.navMs;
    if (navMs) {
      worker.page.setDefaultTimeout(navMs);
      worker.page.setDefaultNavigationTimeout(navMs);
    }
    return await fn(worker.page, worker.context, worker.browser);
  } catch (err) {
    const dead =
      !worker ||
      !worker.page ||
      worker.page.isClosed() ||
      /Target closed|has been closed|browser has been closed/i.test(String((err && err.message) || ''));
    if (dead && worker) {
      busyPages = Math.max(0, busyPages - 1);
      await destroyWorker(worker);
      worker = null;
    }
    throw err;
  } finally {
    if (worker) await checkin(worker);
    releaseSlot();
  }
}

function browserConnected() {
  for (const entry of cache.values()) {
    if (entry.browser && entry.browser.isConnected()) return true;
  }
  return false;
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
  const connected = browserConnected();
  return {
    reuse: reuseOn(),
    max_contexts: MAX_CONTEXTS,
    workers: WORKERS,
    active,
    queued: waiters.length,
    browsers,
    browserConnected: connected,
    connected,
    freePages: idle.length,
    busyPages,
    createdPages,
  };
}

async function closeAll() {
  const leftover = idle.splice(0, idle.length);
  for (const w of leftover) {
    await w.context.close().catch(() => {});
  }
  createdPages = 0;
  busyPages = 0;
  for (const [, entry] of cache.entries()) {
    if (entry.timer) clearTimeout(entry.timer);
    await entry.browser.close().catch(() => {});
  }
  cache.clear();
}

module.exports = {
  getBrowser,
  newContext,
  withBrowser,
  withPage,
  stats,
  closeAll,
  browserConnected,
};
