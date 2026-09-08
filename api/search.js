'use strict';

const fs = require('fs');
const path = require('path');

const { newSearchContext } = require('./lib/browser');
const { ENGINES, names, detectBlock, resolveGoogleRedirects } = require('./lib/engines');

const MAX_NUM = 100;
const NAV_TIMEOUT_MS = 25000;
const READY_TIMEOUT_MS = 15000;

async function attemptSearch({ engine, query, num = 20, start = 0, hl = 'en', gl = 'us', proxy, debug }) {
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
        let results = await page.evaluate(cfg.parse).catch(() => []);
        if (engine === 'google') {
          results = await resolveGoogleRedirects(context, results, num * 2);
        }
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

// Reads a newline/comma separated list of proxy URLs from the PROXY_POOL env
// var. Lines may be "# comment"-prefixed. Each entry is a full proxy URL, e.g.
// "http://user:pass@host:port" or "http://host:port". If the env var is empty,
// falls back to the committed ./proxies.txt file (repo must be kept private).
function splitPool(raw) {
  return String(raw || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .filter((s) => /^https?:\/\//i.test(s) || /^[^/@:]+:\d+$/.test(s));
}
function getProxyPool() {
  const envPool = String(process.env.PROXY_POOL || '').trim();
  if (envPool) return splitPool(envPool);
  const candidates = [
    process.env.PROXY_POOL_FILE,
    path.join(__dirname, 'proxies.txt'),
    path.join(__dirname, '..', 'proxies.txt'),
    path.join(process.cwd(), 'proxies.txt'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const pool = splitPool(raw);
      if (pool.length) return pool;
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

// Public entry point: applies proxy rotation. When the caller does not pass an
// explicit proxy= and PROXY_POOL is configured, it tries a few random pool
// members (each failure like a Google /sorry interstitial just moves to the
// next exit IP) and finally falls back to a direct request. When an explicit
// proxy is given, exactly one attempt is made with it (same as before).
async function renderSearch(opts) {
  const explicitProxy = opts.proxy;
  const tries = [];
  if (explicitProxy) {
    tries.push(explicitProxy);
  } else {
    const pool = getProxyPool().sort(() => Math.random() - 0.5);
    const picks = Math.min(pool.length, intEnv('PROXY_ATTEMPTS', 3));
    for (let i = 0; i < picks; i++) tries.push(pool[i]);
    if (String(process.env.PROXY_FALLBACK_DIRECT) !== '0' || tries.length === 0) tries.push(null);
  }

  const deadline = Date.now() + intEnv('PROXY_WINDOW_MS', 42000);
  let lastErr = new Error('no search attempt could be made');
  for (let i = 0; i < tries.length; i++) {
    if (Date.now() > deadline) break;
    try {
      return await attemptSearch({ ...opts, proxy: tries[i] });
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'UNKNOWN_ENGINE') throw err; // validation, not retryable
    }
  }
  throw lastErr;
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
      note: 'Headless-Chromium SERP renderer fallback for gsearch-api. Set RENDERER_URL on gsearch-api to this deployment. Optional PROXY_POOL env (comma/newline proxy URLs) enables per-request rotation; PROXY_ATTEMPTS and PROXY_FALLBACK_DIRECT tune retries. Proxy requests run over HTTP/1.1 (some proxy providers stall Chromium HTTP/2 to Google).',
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
  const debug = req.query.debug === '1';

  try {
    const { results, duration_ms, debugHtml } = await renderSearch({ engine, query: q, num, start, hl, gl, proxy, debug });
    const body = {
      engine,
      query: q,
      success: true,
      count: results.length,
      results,
      duration_ms,
    };
    if (debugHtml) body.debug_html = debugHtml;
    return send(res, body);
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
