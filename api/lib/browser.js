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

async function launchBrowser() {
  const chromiumBin = await loadChromium();
  const pw = loadPlaywright();
  return pw.launch({
    args: chromiumBin.args,
    executablePath: await chromiumBin.executablePath(),
    headless: true,
  });
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function newSearchContext({ proxy }) {
  const browser = await launchBrowser();
  const opts = {
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: DESKTOP_UA,
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      'accept-language': 'en-US,en;q=0.9',
    },
  };
  if (proxy) opts.proxy = { server: proxy };
  try {
    const context = await browser.newContext(opts);
    return { browser, context };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

module.exports = { launchBrowser, newSearchContext, DESKTOP_UA };
