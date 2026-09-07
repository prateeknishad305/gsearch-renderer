'use strict';

// @sparticuz/chromium ships a compressed Chromium that works inside Vercel's
// serverless functions (Amazon Linux 2023). The binary is extracted to
// /tmp/chromium once and reused across invocations while the sandbox stays
// warm, but the browser process itself does not survive between invocations
// (Vercel reaps child processes after the response), so we launch a fresh
// browser for every request and close it before returning.
//
// Both dependencies are required lazily (not at module top level) so that a
// load/extraction failure surfaces as a normal error inside the handler and is
// returned as JSON instead of crashing the function during module evaluation.

let chromiumMod = null;
let playwright = null;

// @sparticuz/chromium v140+ is ESM-only. Use dynamic import() so this works on
// any Node runtime, including ones without require(esm) support.
async function loadChromium() {
  if (!chromiumMod) {
    const mod = await import('@sparticuz/chromium');
    chromiumMod = mod.default || mod;
  }
  return chromiumMod;
}

function loadPlaywright() {
  if (!playwright) {
    playwright = require('playwright-core').chromium;
  }
  return playwright;
}

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run'];

async function launchBrowser() {
  const chromiumBin = await loadChromium();
  const pw = loadPlaywright();
  return pw.launch({
    args: [...chromiumBin.args, ...STEALTH_ARGS],
    executablePath: await chromiumBin.executablePath(),
    headless: true,
    // Playwright injects --enable-automation by default; dropping it removes a
    // well-known "this is a bot" signal in the browser itself.
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
  const browser = await launchBrowser();
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

module.exports = { launchBrowser, newSearchContext, DESKTOP_UA, parseProxy };
