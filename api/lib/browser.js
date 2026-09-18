'use strict';

// Chromium is resolved per platform:
//   Vercel  -> @sparticuz/chromium (serverless binary)
//   Docker / Railway / Render / local with Chrome installed -> system Chromium
//   fallback -> @sparticuz/chromium
//
// Both Chromium and Playwright are required lazily so a load/extraction failure
// surfaces as a normal JSON error instead of crashing module evaluation.

const { resolveLaunch } = require('./chromium');

let playwright = null;

function loadPlaywright() {
  if (!playwright) {
    playwright = require('playwright-core').chromium;
  }
  return playwright;
}

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run'];

// Some HTTP proxy providers (PureVPN/pointtoserver, PVData, squid proxies...)
// mishandle Chromium's HTTP/2 towards Google and the connection silently
// stalls (curl h2 works, so it is a Chromium-h2-specific path bug). Falling
// back to HTTP/1.1 only when a proxy is in play keeps direct connections on h2
// while making proxied Google requests complete.
async function launchBrowser({ disableHttp2 = false } = {}) {
  const launch = await resolveLaunch();
  const pw = loadPlaywright();
  const extra = disableHttp2 ? ['--disable-http2'] : [];
  return pw.launch({
    args: [...launch.args, ...STEALTH_ARGS, ...extra],
    executablePath: launch.executablePath,
    headless: true,
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

// Fallback only. The real UA is derived from the launched Chromium version so
// the claimed Chrome major always matches the engine actually running (a
// mismatch, e.g. Chrome/125 UA over Chromium 149, is an easy bot tell).
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function resolveUA(browser, fallback) {
  try {
    const ver = await browser.version(); // e.g. "HeadlessChrome/149.0.6324.32"
    const m = String(ver).match(/(\d+)\.[\d.]+/);
    if (m) {
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m[1]}.0.0.0 Safari/537.36`;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

// Hides common automation fingerprints. Runs before any page script.
function stealthMarkup() {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  } catch {}
  try {
    window.chrome = window.chrome || {};
    window.chrome.runtime = window.chrome.runtime || {};
  } catch {}
  try {
    const q = navigator.permissions && navigator.permissions.query;
    if (q) {
      navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : q.call(navigator.permissions, p);
    }
  } catch {}
}

async function newSearchContext({ proxy }) {
  const browser = await launchBrowser({ disableHttp2: !!proxy });
  const ua = await resolveUA(browser, DESKTOP_UA);
  const opts = {
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: ua,
    viewport: { width: 1366, height: 900 },
    colorScheme: 'light',
  };
  if (proxy) {
    // Split embedded credentials out of the URL: Chromium's network service
    // fails CONNECT with 407 unless credentials are passed as explicit
    // username/password options rather than only inside the server URL.
    opts.proxy = parseProxy(proxy);
  }
  try {
    const context = await browser.newContext(opts);
    await context.addInitScript(stealthMarkup);
    return { browser, context };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

// "http://user:pass@host:port" -> { server, username, password }
function parseProxy(proxy) {
  try {
    const u = new URL(proxy);
    const out = { server: `${u.protocol}//${u.host}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: proxy };
  }
}

module.exports = {
  launchBrowser,
  newSearchContext,
  DESKTOP_UA,
  parseProxy,
  stealthMarkup,
  resolveUA,
};
