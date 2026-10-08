'use strict';

const { withPage } = require('./browserPool');
const { ENGINES, detectBlock, resolveGoogleRedirects } = require('./engines');
const g = require('./google');
const session = require('./googleSession');
const ip = require('./googleIp');
const lock = require('./googleLock');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

const NAV_TIMEOUT_MS = intEnv('NAVIGATION_TIMEOUT', intEnv('GOOGLE_NAV_MS', 25000));
const READY_TIMEOUT_MS = intEnv('RESULT_TIMEOUT', intEnv('GOOGLE_READY_MS', 15000));

async function renderOnPage({ engine, cfg, page, context, num, hl, gl, debug, proxy, start }) {
  const t0 = Date.now();
  const google = engine === 'google';

  if (google) await g.attachRoutes(page);

  if (cfg.cookies) {
    const sticky = google && session.get(proxy);
    const list = cfg.cookies({ hl, gl, sticky: !!sticky });
    if (list && list.length) await context.addCookies(list).catch(() => {});
    if (sticky && sticky.cookies && sticky.cookies.length) {
      await context.addCookies(sticky.cookies).catch(() => {});
    }
  }

  if (engine === 'google' && String(process.env.GOOGLE_HOME_WARMUP || '0') === '1' && !(cfg && cfg.skipHome)) {
    await page
      .goto(`https://www.google.com/?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 8000,
      })
      .catch(() => {});
  }
  if (engine === 'mojeek' && String(process.env.MOJEEK_HOME_WARMUP || '0') === '1' && !(cfg && cfg.skipHome)) {
    await page.goto('https://www.mojeek.com/', { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
  }

  if (google && start > 0) {
    await page.setExtraHTTPHeaders({ Referer: 'https://www.google.com/' }).catch(() => {});
  }

  const waitUntil = google ? g.navWaitUntil() : 'domcontentloaded';
  const navMs = google ? g.navTimeoutMs() : NAV_TIMEOUT_MS;
  const readyMs = google ? g.readyTimeoutMs() : READY_TIMEOUT_MS;

  let navError = null;
  let navStatus = 0;
  let sorryHandler = null;
  const sorryWatch = google
    ? new Promise((_, reject) => {
        sorryHandler = (frame) => {
          if (frame !== page.mainFrame()) return;
          if (!g.isSorryUrl(frame.url())) return;
          const e = new Error(`Engine "google" blocked the browser render: unusual traffic interstitial`);
          e.code = 'BLOCKED';
          reject(e);
        };
        page.on('framenavigated', sorryHandler);
      })
    : null;
  try {
    await Promise.race([
      page.goto(cfg.url, { waitUntil, timeout: navMs }).then((resp) => {
        navStatus = (resp && resp.status()) || 0;
      }),
      ...(sorryWatch ? [sorryWatch] : []),
    ]);
  } catch (err) {
    if (err && err.code === 'BLOCKED') throw err;
    navError = err;
  } finally {
    if (sorryHandler) page.off('framenavigated', sorryHandler);
  }

  if (!navError && (navStatus === 429 || navStatus === 403)) {
    const e = new Error(`Engine "${engine}" blocked the browser render: HTTP ${navStatus}`);
    e.code = 'BLOCKED';
    throw e;
  }

  if (google && g.isSorryUrl(page.url())) {
    const e = new Error(`Engine "google" blocked the browser render: unusual traffic interstitial`);
    e.code = 'BLOCKED';
    throw e;
  }

  if (!navError) {
    await page
      .waitForFunction(
        (readySel) => {
          if (document.querySelector(readySel)) return true;
          const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
          return /unusual traffic|automated queries|403\s*-\s*forbidden|access denied|prove you are human|verify you are human|went wrong during verification|enablejs|captcha|email us|drag the slider|not a bot|not yet available in your country|temporarily unavailable|service indisponible|verification required|protected by altcha|waiting for verification/i.test(
            t
          );
        },
        cfg.ready,
        { timeout: readyMs }
      )
      .catch(() => {});
    if (google) {
      await g.dismissConsent(page);
      const hasH3 = await page.evaluate(() => !!document.querySelector('h3')).catch(() => false);
      const delay = g.postReadyDelayMs(hasH3);
      if (delay) await page.waitForTimeout(delay);
    } else {
      await page.waitForTimeout(engine === 'brave' || engine === 'startpage' ? 900 : 200);
    }
  }

  const block = await page.evaluate(detectBlock, engine).catch(() => null);
  if (block) {
    const e = new Error(`Engine "${engine}" blocked the browser render: ${block}`);
    e.code = 'BLOCKED';
    throw e;
  }

  if (google && !navError) {
    const soft = await page
      .evaluate(() => ({
        h3: document.querySelectorAll('h3').length,
        textLen: (document.body ? document.body.innerText : '').length,
        url: location.href,
      }))
      .catch(() => ({ h3: 0, textLen: 0, url: '' }));
    if (g.isSoftBlock({ navStatus, h3: soft.h3, textLen: soft.textLen, url: soft.url })) {
      const e = new Error(`Engine "google" served a soft-block / empty SERP`);
      e.code = 'BLOCKED';
      throw e;
    }
  }

  let clean = [];
  if (!navError) {
    for (let pass = 0; pass <= (cfg.scroll || 0); pass++) {
      let results = await page.evaluate(cfg.parse).catch(() => []);
      if (engine === 'google') {
        if (g.followGoto()) results = await resolveGoogleRedirects(context, results, num * 2);
        results = g.filterResults(results);
      }
      clean = (Array.isArray(results) ? results : []).filter(
        (r) => r && /^https?:\/\//i.test(r.url || '') && (r.title || '').trim()
      );
      if (clean.length > 0 || pass === (cfg.scroll || 0)) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(800);
    }
    if (google && clean.length === 0 && cfg.url && !/[?&]gbv=2/.test(cfg.url) && Date.now() - t0 < navMs) {
      const classic = cfg.url.includes('?') ? `${cfg.url}&gbv=2` : `${cfg.url}?gbv=2`;
      await page.goto(classic, { waitUntil: waitUntil, timeout: navMs }).catch(() => {});
      await g.dismissConsent(page);
      const delay = g.postReadyDelayMs(false);
      if (delay) await page.waitForTimeout(delay);
      const block2 = await page.evaluate(detectBlock, engine).catch(() => null);
      if (!block2) {
        let results = await page.evaluate(cfg.parse).catch(() => []);
        if (g.followGoto()) results = await resolveGoogleRedirects(context, results, num * 2);
        results = g.filterResults(results);
        clean = (Array.isArray(results) ? results : []).filter(
          (r) => r && /^https?:\/\//i.test(r.url || '') && (r.title || '').trim()
        );
      }
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

  if (google) {
    const cookies = await context.cookies().catch(() => []);
    session.put(proxy, cookies, true);
    ip.record(proxy, 'OK');
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

async function runQuery(opts) {
  const { engine, query, num = 10, start = 0, hl = 'en', gl = 'us', proxy, debug } = opts;
  const cfg = ENGINES[engine];
  if (!cfg) {
    const e = new Error(`Unknown engine "${engine}". Available: ${Object.keys(ENGINES).join(', ')}`);
    e.code = 'UNKNOWN_ENGINE';
    throw e;
  }
  const google = engine === 'google';
  const url = cfg.url({ q: query, num, start, hl, gl, proxy });
  const navMs = google ? g.navTimeoutMs() : NAV_TIMEOUT_MS;

  const exec = async () =>
    withPage({ proxy, hl, gl, google, navMs }, async (page, context) =>
      renderOnPage({
        engine,
        cfg: { ...cfg, url, skipHome: start > 0 },
        page,
        context,
        num,
        hl,
        gl,
        debug,
        proxy,
        start,
      })
    );

  if (!google) return exec();

  if (ip.shouldSkip(proxy)) {
    const e = new Error(`Engine "google" skipped this exit for ${ip.remainingMs(proxy)}ms after repeated blocks`);
    e.code = 'CIRCUIT_OPEN';
    throw e;
  }

  const jitter = g.jitterMs();
  if (jitter) await new Promise((r) => setTimeout(r, jitter));

  const held = await lock.acquire(proxy);
  try {
    return await exec();
  } catch (err) {
    ip.record(proxy, err && err.code ? err.code : 'ERROR');
    if (err && (err.code === 'BLOCKED' || err.code === 'CIRCUIT_OPEN')) session.drop(proxy);
    throw err;
  } finally {
    held.release();
  }
}

module.exports = { runQuery, renderOnPage };
