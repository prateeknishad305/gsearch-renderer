'use strict';

const { launchBrowser, newSearchContext, parseProxy, stealthMarkup, resolveUA, DESKTOP_UA } = require('./browser');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function intEnvZero(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

const IDLE_MS = intEnvZero('BROWSER_IDLE_MS', 0);
const serverless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV);
const WORKERS = intEnv('BROWSER_WORKERS', intEnv('MAX_CONTEXTS', serverless ? 1 : 4));
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

function pageReuse() {
  return String(process.env.PAGE_REUSE || '0') === '1';
}

const SLOT_WAIT_MS = intEnvZero('SLOT_WAIT_MS', 8000);

// The caller can cap how long it is willing to queue for a worker: a request
// with a short budget must not sit in the pool queue while the engines that
// could still answer are waiting for it.
async function acquireSlot(maxWaitMs) {
  if (active < MAX_CONTEXTS) {
    active += 1;
    return;
  }
  const waitMs = Math.max(0, Number(maxWaitMs) || SLOT_WAIT_MS || 0);
  await new Promise((resolve, reject) => {
    let settled = false;
    const waiter = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    const timer = waitMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          const e = new Error('browser workers busy');
          e.code = 'QUEUE_TIMEOUT';
          reject(e);
        }, waitMs)
      : null;
    waiters.push(waiter);
  });
  active += 1;
}

function releaseSlot() {
  if (active > 0) active -= 1;
  const next = waiters.shift();
  if (next) next();
}

function scheduleIdleClose(key, entry) {
  if (!IDLE_MS) return;
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

async function newContext(browser, { proxy, hl, gl, google, browser: browserName, javascript } = {}) {
  const { context } = await newSearchContext({ proxy, hl, gl, browser });
  return context;
}

function workerKey({ proxy, hl, gl, google, disableHttp2, browser: browserName, javascript }) {
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
  return `${flavorId}|${host}|${disableHttp2 ? 'h1' : 'h2'}|${google ? 'g' : 'n'}|${javascript === false ? 'noj' : 'js'}|${hl || 'en'}|${gl || 'us'}`;
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
  const closer = w.context ? w.context.close().catch(() => {}) : Promise.resolve();
  await Promise.race([closer, new Promise((r) => setTimeout(r, 1500))]);
  if (!reuseOn() && w.browser) {
    await Promise.race([w.browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  }
}

async function checkin(w) {
  busyPages = Math.max(0, busyPages - 1);
  if (!w || !w.page || w.page.isClosed() || !reuseOn() || !pageReuse()) {
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

async function sweepIdle() {
  const leftover = idle.splice(0, idle.length);
  for (const w of leftover) await destroyWorker(w);
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
  const slotWait = opts.checkoutMs || (opts.navMs ? Math.max(1000, opts.navMs) : SLOT_WAIT_MS);
  await acquireSlot(slotWait);
  let worker = null;
  let cancelled = false;
  try {
    // The caller can cap how long it is willing to wait for a slot: a render
    // that cannot get a browser in time is worse than no render at all when
    // the request budget is short.
    const checkoutMs = opts.checkoutMs
      ? Math.max(1000, opts.checkoutMs)
      : Math.max(8000, opts.navMs || SLOT_WAIT_MS || 8000);
    const pending = checkout(opts).then((w) => {
      if (cancelled) {
        busyPages = Math.max(0, busyPages - 1);
        destroyWorker(w).catch(() => {});
        return null;
      }
      return w;
    });
    worker = await Promise.race([
      pending,
      new Promise((_, reject) => {
        setTimeout(() => {
          const e = new Error('browser checkout timeout');
          e.code = 'QUEUE_TIMEOUT';
          reject(e);
        }, checkoutMs);
      }),
    ]);
    if (!worker) {
      const e = new Error('browser checkout timeout');
      e.code = 'QUEUE_TIMEOUT';
      throw e;
    }
    const navMs = opts.navMs;
    if (navMs) {
      worker.page.setDefaultTimeout(navMs);
      worker.page.setDefaultNavigationTimeout(navMs);
    }
    // When several renders are raced, the losers must stop instead of holding
    // a browser slot: an abandoned render either blocks the pool or gets its
    // browser closed underneath it.
    let onAbort = null;
    if (opts.signal) {
      if (opts.signal.aborted) {
        const e = new Error('render aborted');
        e.code = 'SKIP';
        throw e;
      }
      onAbort = () => {
        try {
          worker.page.close();
        } catch {
          /* ignore */
        }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await fn(worker.page, worker.context, worker.browser);
    } finally {
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
  } catch (err) {
    cancelled = true;
    const dead =
      !worker ||
      !worker.page ||
      worker.page.isClosed() ||
      /Target closed|has been closed|browser has been closed|checkout timeout/i.test(String((err && err.message) || ''));
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
    page_reuse: pageReuse(),
    always_on: reuseOn() && IDLE_MS === 0,
    idle_close_ms: IDLE_MS,
    slot_wait_ms: SLOT_WAIT_MS,
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

async function warm() {
  if (serverless || !reuseOn()) return false;
  try {
    await Promise.all([
      getBrowser({ disableHttp2: true }),
      getBrowser({ disableHttp2: false }),
    ]);
    // Warm the Google context as well. The first site:/filetype: query needs
    // a browser, and building that context costs seconds that would
    // otherwise be paid by the request that arrives first.
    try {
      const worker = await checkout({ google: true, hl: 'en', gl: 'us', proxy: null, disableHttp2: false });
      await checkin(worker);
    } catch {
      /* the browser is warm enough */
    }
    return true;
  } catch (err) {
    console.error('[gsearch-renderer] chromium warm failed:', (err && err.message) || err);
    return false;
  }
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
  warm,
  warmup: warm,
  sweepIdle,
  closeAll,
  browserConnected,
  acquireSlot,
  releaseSlot,
};
