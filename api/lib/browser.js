'use strict';

// @sparticuz/chromium ships a compressed Chromium that works inside Vercel's
// serverless functions (Amazon Linux 2023). We keep a single browser instance
// across warm invocations to avoid paying the cold-start cost on every request.
//
// Both dependencies are required lazily (not at module top level) so that a
// load/extraction failure surfaces as a normal error inside the handler and is
// returned as JSON instead of crashing the function during module evaluation.

let chromiumMod = null;
let playwright = null;

function loadChromium() {
  if (!chromiumMod) {
    const mod = require('@sparticuz/chromium');
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

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    const chromiumBin = loadChromium();
    const pw = loadPlaywright();
    browserPromise = pw
      .launch({
        args: chromiumBin.args,
        executablePath: await chromiumBin.executablePath(),
        headless: true,
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function newSearchContext({ proxy }) {
  const browser = await getBrowser();
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
  return browser.newContext(opts);
}

module.exports = { getBrowser, newSearchContext, DESKTOP_UA };
