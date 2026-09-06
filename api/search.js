'use strict';

const { newSearchContext } = require('./lib/browser');
const { ENGINES, names, detectBlock } = require('./lib/engines');

const MAX_NUM = 100;
const NAV_TIMEOUT_MS = 25000;
const READY_TIMEOUT_MS = 15000;

async function renderSearch({ engine, query, num = 20, start = 0, hl = 'en', gl = 'us', proxy }) {
  const cfg = ENGINES[engine];
  if (!cfg) {
    const e = new Error(`Unknown engine "${engine}". Available: ${names().join(', ')}`);
    e.code = 'UNKNOWN_ENGINE';
    throw e;
  }

  const url = cfg.url({ q: query, num, start, hl, gl });
  const { browser, context } = await newSearchContext({ proxy });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    if (cfg.cookies) {
      await context.addCookies(cfg.cookies({ hl, gl }));
    }

    // Google fingerprints fresh sessions harder. Visit the homepage once first
    // so the server issues its own real cookies/state before the search hits,
    // instead of only trusting pre-forged CONSENT/SOCS values.
    if (engine === 'google') {
      await page
        .goto(`https://www.google.com/?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`, {
          waitUntil: 'domcontentloaded',
          timeout: 12000,
        })
        .catch(() => {});
    }

    const t0 = Date.now();
    let navError = null;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((err) => {
      navError = err;
    });

    if (!navError) {
      // Resolve as soon as results appear OR a strong block signal appears, so
      // anti-bot pages (Google /sorry, Mojeek 403, DDG anomaly, ...) bail in a
      // second or two instead of waiting out the full ready timeout.
      await page
        .waitForFunction(
          ({ readySel }) => {
            if (document.querySelector(readySel)) return true;
            const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
            return /unusual traffic|automated queries|403\s*-\s*forbidden|access denied|prove you are human|verify you are human|went wrong during verification|enablejs|captcha|email us/i.test(t);
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
      // Some engines (Google) lazy-render results on scroll and may need a
      // second pass before the page is fully hydrated.
      for (let pass = 0; pass <= (cfg.scroll || 0); pass++) {
        const results = await page.evaluate(cfg.parse).catch(() => []);
        clean = (Array.isArray(results) ? results : [])
          .filter((r) => r && /^https?:\/\//i.test(r.url || '') && (r.title || '').trim());
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

    return { results: clean, duration_ms: Date.now() - t0 };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function send(res, body) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(body.http_status || 200).json(body);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return send(res, { error: 'Method not allowed', http_status: 405 });
  }

  const q = String(req.query.q || '').trim();
  if (!q) {
    return send(res, {
      service: 'gsearch-renderer',
      ok: true,
      usage: 'GET /api/search?q=<query>&engine=<google|bing|brave|mojeek|startpage|yahoo|duckduckgo|duckduckgo_lite|qwant>&num=&start=&hl=&gl=&proxy=',
      note: 'Headless-Chromium SERP renderer fallback for gsearch-api. Set RENDERER_URL on gsearch-api to this deployment.',
    });
  }
  if (q.length > 512) {
    return send(res, { error: 'Query too long (max 512 chars)', http_status: 400 });
  }

  const engine = String(req.query.engine || 'google').toLowerCase();
  if (!ENGINES[engine]) {
    return send(res, {
      error: `Unknown engine "${engine}". Available: ${names().join(', ')}`,
      http_status: 400,
    });
  }

  const num = Math.min(Math.max(1, Number(req.query.num) || 20), MAX_NUM);
  const start = Math.max(0, Number(req.query.start) || 0);
  const hl = String(req.query.hl || 'en').slice(0, 8);
  const gl = String(req.query.gl || 'us').slice(0, 8);
  const proxy = String(req.query.proxy || '').trim();

  try {
    const { results, duration_ms } = await renderSearch({ engine, query: q, num, start, hl, gl, proxy });
    return send(res, {
      engine,
      query: q,
      success: true,
      count: results.length,
      results,
      duration_ms,
    });
  } catch (err) {
    return send(res, {
      engine,
      query: q,
      success: false,
      code: err.code || 'ERROR',
      error: err.message,
      count: 0,
      results: [],
    });
  }
};

module.exports.config = {
  maxDuration: 60,
  memory: 1024,
};

module.exports.renderSearch = renderSearch;
