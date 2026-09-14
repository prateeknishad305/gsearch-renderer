'use strict';

// Runs a single SERP query inside a fresh browser context on the pooled
// Chromium. Pure rendering logic lives here; proxy choice, engine fallback,
// pagination, caching and rotation live in the endpoint handlers.

const { withBrowser, newContext } = require('./browserPool');
const { ENGINES, detectBlock, resolveGoogleRedirects } = require('./engines');

const NAV_TIMEOUT_MS = 25000;
const READY_TIMEOUT_MS = 15000;

async function renderOnPage({ engine, cfg, page, context, num, hl, gl, debug }) {
  const t0 = Date.now();

  if (cfg.cookies) {
    await context.addCookies(cfg.cookies({ hl, gl })).catch(() => {});
  }

  // Google fingerprints fresh sessions harder. Visit the homepage once first so
  // the server issues its own real state (cookies, NID) before the search hits.
  if (engine === 'google') {
    await page
      .goto(`https://www.google.com/?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 12000,
      })
      .catch(() => {});
  }

  let navError = null;
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((err) => {
    navError = err;
  });

  if (!navError) {
    await page
      .waitForFunction(
        ({ readySel }) => {
          if (document.querySelector(readySel)) return true;
          const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
          return /unusual traffic|automated queries|403\s*-\s*forbidden|access denied|prove you are human|verify you are human|went wrong during verification|enablejs|captcha|email us/i.test(
            t
          );
        },
        { readySel: cfg.ready, timeout: READY_TIMEOUT_MS }
      )
      .catch(() => {});
    await page.waitForTimeout(700);
  }

  const block = await page.evaluate(detectBlock, engine).catch(() => null);
  if (block) {
    const e = new Error(`Engine "${engine}" blocked the browser render: ${block}`);
    e.code = 'BLOCKED';
    throw e;
  }

  let clean = [];
  if (!navError) {
    for (let pass = 0; pass <= (cfg.scroll || 0); pass++) {
      let results = await page.evaluate(cfg.parse).catch(() => []);
      if (engine === 'google') {
        results = await resolveGoogleRedirects(context, results, num * 2);
      }
      clean = (Array.isArray(results) ? results : []).filter(
        (r) => r && /^https?:\/\//i.test(r.url || '') && (r.title || '').trim()
      );
      if (clean.length > 0 || pass === (cfg.scroll || 0)) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(800);
    }
    clean = clean.slice(0, num);
  }

  if (clean.length === 0) {
    let excerpt = '';
    if (!navError) {
      try {
        excerpt = (
          await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim())
        ).slice(0, 240);
        if (engine === 'google') {
          const dom = await page.evaluate(() => {
            const el = document.querySelector('#search, #rso, #main');
            return el ? el.innerHTML.replace(/\s+/g, ' ').slice(0, 900) : '';
          });
          if (dom) excerpt += ` | dom: ${dom}`;
        }
      } catch {
        /* ignore */
      }
    }
    const reason = navError
      ? `navigation failed: ${navError.message}`
      : `no result nodes found after render${excerpt ? ` (page text: ${excerpt})` : ''}`;
    const e = new Error(`Engine "${engine}" returned no results after browser render (${reason}).`);
    e.code = 'EMPTY_RESULTS';
    throw e;
  }

  let debugHtml = '';
  if (debug && !navError) {
    debugHtml = await page
      .evaluate(() => {
        const el = document.querySelector('#search, #rso, #main');
        if (!el) return '';
        const cards = [];
        const heads = el.querySelectorAll('h3, [role="heading"][aria-level="3"]');
        for (let i = 0; i < Math.min(heads.length, 3); i++) {
          const c = heads[i].closest('div[data-hveid], li, div.g');
          if (c) cards.push(c.outerHTML.replace(/\s+/g, ' ').slice(0, 5000));
        }
        return JSON.stringify({ full: el.innerHTML.replace(/\s+/g, ' ').slice(0, 4000), cards });
      })
      .catch(() => '');
  }

  return { results: clean, duration_ms: Date.now() - t0, debugHtml };
}

// opts: { engine, query, num, start, hl, gl, proxy, debug }
async function runQuery(opts) {
  const { engine, query, num = 20, start = 0, hl = 'en', gl = 'us', proxy, debug } = opts;
  const cfg = ENGINES[engine];
  if (!cfg) {
    const e = new Error(`Unknown engine "${engine}". Available: ${Object.keys(ENGINES).join(', ')}`);
    e.code = 'UNKNOWN_ENGINE';
    throw e;
  }
  const url = cfg.url({ q: query, num, start, hl, gl });

  return withBrowser({ proxy }, async (browser) => {
    const context = await newContext(browser, { proxy });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      return await renderOnPage({ engine, cfg: { ...cfg, url }, page, context, num, debug });
    } finally {
      await context.close().catch(() => {});
    }
  });
}

module.exports = { runQuery, renderOnPage };
