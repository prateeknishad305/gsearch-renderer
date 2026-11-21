'use strict';

const { ENGINES, names } = require('./lib/engines');
const { fastLiteSearch, ENDPOINTS } = require('./lib/lite');
const { runQuery } = require('./lib/runner');
const {
  getShardPool,
  getUserProxies,
  poolInfo,
  intEnv,
  altProxy,
  chromiumProxyOk,
  toChromiumProxy,
  takeGoogleProxy,
  peekStickyGoogleProxy,
  setStickyGoogleProxy,
  dropStickyGoogleProxy,
  proxyIdentity,
  googleProxyPool,
  otherProxyPool,
  classifyProxy,
  partitionPool,
  uniqueHosts,
} = require('./lib/proxyPool');
const { getCache } = require('./lib/cache');
const { sweepIdle } = require('./lib/browserPool');
const { send, cors, authOk, unauthorized, maskProxy } = require('./lib/http');
const { parseShodanOptions, applyShodanOptions, active: shodanOptionsActive } = require('./lib/shodanQuery');
const { parseResultFilters, applyDomainFilters } = require('./lib/resultFilter');
const { parseDork, engineSupport, adaptQuery, dedupeResults, enforceDork, isHostSiteTarget } = require('./lib/dork');
const circuit = require('./lib/circuit');
const stats = require('./lib/stats');
const g = require('./lib/google');
const googleIp = require('./lib/googleIp');
const proxyRace = require('./lib/proxyRace');
const googleCse = require('./lib/googleCse');

const MAX_NUM = 100;
const MAX_PAGES = 10;
const MAX_QUERY_LEN = 512;
const GOOGLE_PAGE_SIZE = 10;
const FIXED_PAGE_SIZE = { google: 10, google_lite: 10, chrome: 10, yahoo: 10 };

// Google removed &num=100 (10 organic hits/page). Yahoo also ignores n>10 and
// serves ~7-10. Paginate those with start=0,10,20,... Other engines keep a
// higher per-page num.
function pageStep(engine, num) {
  if (FIXED_PAGE_SIZE[engine]) return FIXED_PAGE_SIZE[engine];
  return Math.max(1, num);
}

function perPageNum(engine, num) {
  if (FIXED_PAGE_SIZE[engine]) return FIXED_PAGE_SIZE[engine];
  return Math.min(MAX_NUM, Math.max(1, num));
}

function autoPageCount(engine, num) {
  if (!FIXED_PAGE_SIZE[engine]) return 1;
  const step = FIXED_PAGE_SIZE[engine];
  return Math.min(MAX_PAGES, Math.max(1, Math.ceil(Math.max(1, num) / step)));
}

// Engines that have a plain-HTTP fast path. Turn the whole feature off with
// env LITE_FAST=0, or skip per-engine with LITE_FAST_<ENGINE>=0.
const LITE_ENGINES = new Set(Object.keys(ENDPOINTS));
// Archive.org HTML SERP times out; Wikipedia OpenSearch is official JSON.
const SKIP_RENDER = new Set(['archive', 'wikipedia']);
function liteEnabled(engine) {
  return (
    LITE_ENGINES.has(engine) &&
    String(process.env.LITE_FAST || '1') !== '0' &&
    String(process.env[`LITE_FAST_${engine.toUpperCase()}`] || '1') !== '0'
  );
}
function skipRender(engine) {
  return (
    SKIP_RENDER.has(engine) &&
    String(process.env[`SKIP_RENDER_${engine.toUpperCase()}`] || '1') !== '0'
  );
}

// Builds the ordered list of proxies to try for one page: random pool members
// (bounded by PROXY_ATTEMPTS) followed by a direct attempt unless disabled.
function isNetFail(err) {
  const m = String((err && err.message) || err || '');
  return /ERR_EMPTY_RESPONSE|ERR_CONNECTION|ERR_TUNNEL|ERR_SOCKS|ERR_TIMED_OUT|ERR_PROXY|ERR_HTTP2|net::ERR_|Navigation timeout|Timeout|ECONNRESET|ENOTFOUND/i.test(m);
}

function isHardBlock(err) {
  const code = err && err.code;
  return code === 'BLOCKED' || code === 'SORRY';
}

// Ordered engines to try after the requested engine(s) fail, so a caller always
// gets usable results instead of a dead-end "unavailable" body. Override the
// order with env AUTO_FALLBACK_ENGINES, or turn the whole feature off with
// AUTO_FALLBACK=0.
const AUTO_FALLBACK_CHAIN = String(
  process.env.AUTO_FALLBACK_ENGINES || 'duckduckgo,bing'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((e) => ENGINES[e]);

function autoFallbackEnabled() {
  return String(process.env.AUTO_FALLBACK || '1') !== '0';
}

// Per-request override: ?fallback=0 (or ?auto_fallback=0) disables the chain
// for this call only, leaving the process-wide default untouched.
function noFallbackRequested(query) {
  if (!query) return false;
  return (
    query.fallback === '0' ||
    query.fallback === 'false' ||
    query.auto_fallback === '0' ||
    query.auto_fallback === 'false'
  );
}

// GOOGLE_STANDALONE=1 makes Google engines (google, google_lite, chrome) only
// try themselves, without falling back to DuckDuckGo/Bing.
function googleStandalone() {
  return String(process.env.GOOGLE_STANDALONE || '0') !== '0';
}

function resolveTryList(engineList, query, dorkInfo) {
  const noFallback = noFallbackRequested(query);
  if (noFallback) return { noFallback, tryList: engineList.slice() };
  if (googleStandalone() && engineList.length === 1 && isGoogleEngine(engineList[0])) {
    return { noFallback: true, tryList: engineList.slice() };
  }
  return { noFallback, tryList: withFallbacks(engineList, dorkInfo) };
}

// Appends the fallback chain to an engine list, preserving order and dropping
// duplicates. With AUTO_FALLBACK=0 the list is returned untouched.
// How much of the request budget to keep for an engine that has not run yet.
// The plain-HTTP engines answer in a fraction of a second; a browser render
// needs seconds, so it is not reserved for.
function fallbackReserveMs(engine) {
  if (isGoogleEngine(engine)) return 0;
  return Math.max(1000, intEnv('FALLBACK_RESERVE_MS', 3000));
}

function fallbackDelayMs() {
  const v = parseInt(process.env.GOOGLE_FALLBACK_DELAY_MS, 10);
  if (Number.isFinite(v) && v >= 0) return v;
  return 1500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withGoogleLiteFallback(list) {
  const out = list.slice();
  if (!out.includes('google_lite') || out.includes('chrome')) return out;
  const i = out.indexOf('google_lite');
  out.splice(i + 1, 0, 'chrome');
  return out;
}

// For a dork, the plain-HTTP engines use their lite path only. Their browser
// fallback costs seconds and cannot add anything the operator-aware lite path
// does not already have.
function dorkLiteOnly(engine, dorkMode, liteOnly) {
  if (liteOnly) return true;
  if (!dorkMode) return false;
  return !isGoogleEngine(engine);
}

// For a dork, the engines that honour site:/filetype: without a browser
// answer in milliseconds, while the primary Google path needs a browser.
// Racing them turns a slow chain into a fast answer without giving up the
// primary engine: whoever produces on-target results first wins.
async function raceDorkEngines(engines, ctx) {
  const runs = engines.map((engine) =>
    (async () => {
      const r = await searchEngine({
        engine,
        query: adaptQuery(ctx.q, engine),
        num: ctx.num,
        pages: ctx.pages,
        start: ctx.start,
        hl: ctx.hl,
        gl: ctx.gl,
        proxy: ctx.proxy,
        debug: ctx.debug,
        autoPages: ctx.autoPages,
        proxyless: ctx.proxyless,
        liteOnly: dorkLiteOnly(engine, ctx.dorkMode, ctx.liteOnly),
        renderOnly: ctx.renderOnly,
        browser: ctx.browser,
        deadlineAt: ctx.deadlineAt,
        tbs: ctx.tbs,
        before: ctx.before,
        after: ctx.after,
      });
      let items = applyDomainFilters(r.results || [], ctx.resultFilters);
      items = enforceDork(items, ctx.dorkInfo);
      if (!items.length) {
        const e = new Error(`Engine "${engine}" returned no on-target result`);
        e.code = 'EMPTY_RESULTS';
        throw e;
      }
      return { engine, r, items };
    })(),
  );
  // The losers keep running in the background; absorb their rejections.
  for (const p of runs) p.catch(() => {});
  return new Promise((resolve, reject) => {
    let pending = runs.length;
    let lastErr = null;
    for (const p of runs) {
      p.then(
        (value) => resolve(value),
        (err) => {
          lastErr = err;
          pending -= 1;
          if (pending === 0) reject(lastErr || new Error('no engine answered'));
        },
      );
    }
  });
}

function withFallbacks(list, dorkInfo) {
  const out = withGoogleLiteFallback(list);
  if (!autoFallbackEnabled()) return out;
  if (googleStandalone() && list.length === 1 && isGoogleEngine(list[0])) return out;
  const seen = new Set(out);
  const chain = [];
  for (const e of AUTO_FALLBACK_CHAIN) {
    if (!seen.has(e)) {
      seen.add(e);
      chain.push(e);
    }
  }
  // A dork query needs an engine that honours the operator. Google serves a
  // degraded SERP without operator support on a share of its exits, so the
  // operator-capable engines are tried before the (expensive) browser
  // fallback, and long before the budget runs out.
  if (dorkInfo && dorkInfo.has_operators) {
    const sites = dorkInfo.site_targets || [];
    const capable = chain.filter((e) => {
      if (!sites.length) return true;
      return engineSupport(e, dorkInfo).supported.includes('site');
    });
    if (capable.length) {
      const chromeIdx = out.indexOf('chrome');
      const insertAt = chromeIdx >= 0 ? chromeIdx : out.length;
      out.splice(insertAt, 0, ...capable);
      for (const e of capable) {
        const i = chain.indexOf(e);
        if (i >= 0) chain.splice(i, 1);
      }
    }
  }
  return out.concat(chain);
}

// Codes that mean "this engine could not be fetched from here" rather than a
// programming error. They are never surfaced verbatim to API callers.
  const UNAVAILABLE_CODES = new Set(['BLOCKED', 'SORRY', 'CIRCUIT_OPEN', 'NO_ATTEMPT', 'QUEUE_TIMEOUT', 'TIMEOUT']);

function publicCode(code) {
  if (UNAVAILABLE_CODES.has(code)) return 'ENGINE_UNAVAILABLE';
  return code || 'ERROR';
}

function publicMessage(engine, err) {
  const code = err && err.code;
  if (UNAVAILABLE_CODES.has(code) || code === 'LITE_EMPTY') {
    return `Engine "${engine}" could not be reached from this network. No results were returned.`;
  }
  return (err && err.message) || 'Search failed';
}

function retryAttempts(dflt) {
  const raw = process.env.MAX_RETRIES;
  if (raw != null && raw !== '') {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return Math.max(1, n + 1);
  }
  return dflt;
}

function requestTimeoutMs() {
  const v = parseInt(process.env.REQUEST_TIMEOUT, 10);
  if (Number.isFinite(v) && v > 0) return v;
  return intEnv('PROXY_WINDOW_MS', 18000);
}

function searchBudgetMs() {
  const v = parseInt(process.env.SEARCH_BUDGET_MS, 10);
  if (Number.isFinite(v) && v > 0) return v;
  return requestTimeoutMs();
}

function buildGoogleTries(explicitProxy, stickyKey) {
  if (explicitProxy) return [g.preferHttp(explicitProxy)];
  if (process.env.PROXY_SERVER === undefined) {
    try {
      const { getLivePool, refreshLivePool } = require('./lib/proxyFetch');
      if (!getLivePool().length) refreshLivePool().catch(() => {});
    } catch {
      /* ignore */
    }
  }
  let pool = uniqueHosts(googleProxyPool(getShardPool()).map((p) => g.preferHttp(p)));
  pool = googleIp.pickOpen(pool);
  const tries = [];
  const seen = new Set();
  const sticky = peekStickyGoogleProxy(stickyKey);
  if (sticky && !googleIp.isOpen(sticky)) {
    const one = g.preferHttp(sticky);
    const kinds = partitionPool(pool);
    const dcSticky = classifyProxy(one) === 'datacenter' && kinds.residential.length > 0;
    if (!dcSticky) {
      tries.push(one);
      seen.add(proxyIdentity(one));
    }
  }
  const max = Math.min(pool.length, retryAttempts(intEnv('GOOGLE_PROXY_ATTEMPTS', intEnv('PROXY_ATTEMPTS', 8))));
  while (tries.length < max) {
    const next = takeGoogleProxy(pool, seen);
    if (!next) break;
    const id = proxyIdentity(next);
    if (seen.has(id)) break;
    seen.add(id);
    tries.push(next);
  }
  const usable = tries.map(toChromiumProxy).filter((p) => p == null || chromiumProxyOk(p));
  const user = getUserProxies().length > 0;
  const hasResi = usable.some((p) => classifyProxy(p) === 'residential') || partitionPool(pool).residential.length > 0;
  const fallbackDirect = String(process.env.PROXY_FALLBACK_DIRECT || '1') !== '0' && !user && !hasResi;
  if (fallbackDirect && !usable.includes(null)) usable.push(null);
  return usable.length ? usable : [null];
}

function buildTries(explicitProxy, proxyless, engine, stickyKey) {
  const google = isGoogleEngine(engine);
  if (proxyless) return [null];
  if (google) return buildGoogleTries(explicitProxy, stickyKey);
  if (explicitProxy) return [explicitProxy];
  try {
    const { getLivePool, refreshLivePool } = require('./lib/proxyFetch');
    if (!getLivePool().length) refreshLivePool().catch(() => {});
  } catch {
    /* ignore */
  }
  const pool = uniqueHosts(otherProxyPool(getShardPool()).sort(() => Math.random() - 0.5));
  const user = getUserProxies().length > 0;
  const picks = Math.min(pool.length, retryAttempts(intEnv('PROXY_ATTEMPTS', user ? 8 : 4)));
  const tries = [];
  for (const p of pool.slice(0, picks)) {
    tries.push(p);
    const alt = altProxy(p);
    if (alt && !tries.includes(alt)) tries.push(alt);
  }
  const usable = tries.map(toChromiumProxy).filter((p) => p == null || chromiumProxyOk(p));
  const fallbackDirect = String(process.env.PROXY_FALLBACK_DIRECT || '1') !== '0';
  if (fallbackDirect || usable.length === 0) usable.push(null);
  return usable;
}

// Runs one engine, optionally across multiple result pages, merging unique URLs.
// autoPages=true keeps fetching until `num` unique URLs (or MAX_PAGES).
async function searchEngine({ engine, query, num, pages = 1, start = 0, hl = 'en', gl = 'us', proxy, debug, autoPages = false, proxyless = false, liteOnly = false, renderOnly = false, browser, deadlineAt, tbs, before, after }) {
  const pageCount = Math.min(Math.max(1, pages), MAX_PAGES);
  const step = pageStep(engine, num);
  const perPage = perPageNum(engine, num);
  const cap = Math.min(MAX_NUM, autoPages ? Math.max(num, 1) : num * pageCount);

  if (engine === 'google_lite' || engine === 'mojeek') liteOnly = true;
  if (engine === 'chrome') renderOnly = true;

  // Started before the SERP request so the two run in parallel.
  const enrich = googleEnrich(engine, query, hl, gl);

  const deadline = Math.min(
    Date.now() + requestTimeoutMs(),
    deadlineAt || Date.now() + requestTimeoutMs()
  );

  // Official Google Custom Search JSON API: datacenter-friendly, no proxies.
  // Used as the primary Google path when GOOGLE_CSE_KEY + GOOGLE_CSE_CX are set.
  if (isGoogleEngine(engine) && !debug && googleCse.configured()) {
    try {
      const cse = await googleCse.cseSearch({ query, num: cap, hl, gl, start });
      if (cse.results && cse.results.length) {
        circuit.record(engine, 'OK');
        const enrichExtras = await attachEnrich(enrich);
        return {
          results: cse.results.slice(0, cap),
          duration_ms: cse.duration_ms,
          attempts: 1,
          proxy: null,
          source: 'google_cse',
          pages_fetched: Math.ceil(cse.results.length / GOOGLE_PAGE_SIZE) || 1,
          pages_requested: pageCount,
          extras: Object.keys(enrichExtras).length ? enrichExtras : null,
        };
      }
    } catch {
      // Quota exhausted / misconfigured -> fall through to free proxy + render.
    }
  }

  const tryLite = !renderOnly && (liteOnly || (!debug && liteEnabled(engine)));
  let liteAttempted = false;
  let liteError = null;
  if (tryLite && Date.now() + 2500 < deadline) {
    liteAttempted = true;
    try {
      const lite = await fastLiteSearch({ engine, query, num: cap, hl, gl, start, tbs, before, after, deadlineAt });
      if (lite.results && lite.results.length) {
        circuit.record(engine, 'OK');
        const enrichExtras = await attachEnrich(enrich);
        return {
          results: lite.results.slice(0, cap),
          duration_ms: lite.duration_ms,
          attempts: 1,
          proxy: null,
          source: 'lite',
          transport: lite.transport || null,
          pages_fetched: 1,
          pages_requested: pageCount,
          extras: Object.keys(lite.extras || {}).length || Object.keys(enrichExtras).length
            ? { ...(lite.extras || {}), ...enrichExtras }
            : null,
        };
      }
    } catch (err) {
      liteError = err;
      if (liteOnly || skipRender(engine) || (engine !== 'google' && isHardBlock(err))) {
        if (err && err.code) throw err;
        // Keep the cause: "lite path empty" on its own is impossible to act on.
        const e = new Error(`Engine "${engine}" lite path empty: ${(err && err.message) || 'unknown'}`);
        e.code = 'LITE_EMPTY';
        e.cause = err;
        throw e;
      }
    }
  }
  // The browser render is the expensive path. When this engine's slice of the
  // request budget is already gone, the engines behind it must get their
  // share: a dork that needs bing/duckduckgo has to reach them.
  if (deadlineAt && Date.now() + 1200 >= deadlineAt) {
    if (liteError && liteError.code) throw liteError;
    const e = new Error(`Engine "${engine}" ran out of request budget`);
    e.code = 'BUDGET_EXHAUSTED';
    throw e;
  }
   if (liteOnly || skipRender(engine)) {
     const e = new Error(`Engine "${engine}" has no lite results`);
     e.code = 'LITE_EMPTY';
     throw e;
   }
   if (liteAttempted && engine === 'google') {
     const pause = fallbackDelayMs();
     if (pause && Date.now() + pause + 1500 < deadline) await sleep(pause);
   }

  if (!isGoogleEngine(engine) && circuit.isOpen(engine)) {
    const e = new Error(`Engine "${engine}" circuit open after repeated failures`);
    e.code = 'CIRCUIT_OPEN';
    throw e;
  }

  const merged = [];
  const seen = new Set();
  let attempts = 0;
  let pagesFetched = 0;
  let proxyUsed = null;
  let duration = 0;
  let extras = null;
  let lastErr = new Error('no search attempt could be made');
  const stickyKey = isGoogleEngine(engine) ? `g:${query}|${hl}|${gl}` : '';

  async function fetchPage(offset) {
    let pageResults = null;
    let used = null;
    let dur = 0;
    let localAttempts = 0;
    let err = lastErr;
    let pageExtras = null;
    const candidates = buildTries(proxy, proxyless, engine, stickyKey);
    if (!candidates.length) {
      const e = new Error('no usable proxy or direct exit');
      e.code = 'NO_ATTEMPT';
      return { pageResults: null, used: null, dur: 0, localAttempts: 0, err: e };
    }
    let skipProxies = false;
    const width = proxyRace.raceWidth();

    async function attempt(candidate, signal) {
      if (signal && signal.aborted) {
        const e = new Error('race lost');
        e.code = 'SKIP';
        throw e;
      }
      if (Date.now() > deadline) {
        const e = new Error('deadline');
        e.code = 'TIMEOUT';
        throw e;
      }
      if (skipProxies && candidate) {
        const e = new Error('skip proxy');
        e.code = 'SKIP';
        throw e;
      }
      if (candidate && googleIp.shouldSkip(candidate)) {
        const e = new Error('exit cooling down');
        e.code = 'CIRCUIT_OPEN';
        throw e;
      }
      if (candidate && !chromiumProxyOk(candidate)) {
        const e = new Error('skip socks5 auth');
        e.code = 'SKIP';
        throw e;
      }
      if (isGoogleEngine(engine) && candidate) {
        const ok = await g.probeProxy(candidate);
        if (!ok) {
          googleIp.record(candidate, 'ERROR');
          const e = new Error('probe failed');
          e.code = 'ERROR';
          throw e;
        }
      }
      localAttempts += 1;
      try {
        const r = await runQuery({ engine, query, num: perPage, start: offset, hl, gl, proxy: candidate, debug, browser, tbs, before, after, deadlineAt });
        if (candidate) googleIp.record(candidate, 'OK');
        return { pageResults: r.results, used: candidate, dur: r.duration_ms, extras: r.extras || null };
      } catch (caught) {
        if (candidate && !isGoogleEngine(engine)) googleIp.record(candidate, (caught && caught.code) || 'ERROR');
        throw caught;
      }
    }

    for (const group of proxyRace.batches(candidates, width)) {
      if (Date.now() > deadline) break;
      const batch = skipProxies ? group.filter((c) => !c) : group;
      if (!batch.length) continue;
      try {
        const win = await proxyRace.firstOk(batch.map((c) => (signal) => attempt(c, signal)));
        pageResults = win.pageResults;
        used = win.used;
        dur = win.dur;
        if (win.extras) pageExtras = win.extras;
        if (isGoogleEngine(engine) && used) setStickyGoogleProxy(stickyKey, used);
        break;
      } catch (caught) {
        err = caught;
        if (caught && caught.code === 'UNKNOWN_ENGINE') throw caught;
        if (isGoogleEngine(engine)) dropStickyGoogleProxy(stickyKey);
        if (isHardBlock(caught)) {
          if (isGoogleEngine(engine)) skipProxies = true;
        }
      }
    }
    if (!pageResults && proxyless && isNetFail(err) && String(process.env.PROXYLESS_STRICT || '0') !== '1') {
      for (const candidate of buildTries(null, false, engine, stickyKey)) {
        if (Date.now() > deadline) break;
        if (candidate == null) continue;
        localAttempts += 1;
        try {
        const r = await runQuery({ engine, query, num: perPage, start: offset, hl, gl, proxy: candidate, debug, browser, tbs, before, after, deadlineAt });
          pageResults = r.results;
          dur = r.duration_ms;
          used = candidate;
          if (r.extras) pageExtras = r.extras;
          break;
        } catch (caught) {
          err = caught;
          if (caught && caught.code === 'UNKNOWN_ENGINE') throw caught;
        }
      }
    }
      if (!pageResults && localAttempts === 0) {
       const late = Date.now() > deadline;
       const e = new Error(late ? 'search budget exhausted' : 'no search attempt could be made');
       e.code = late ? 'TIMEOUT' : 'NO_ATTEMPT';
       err = e;
     }
      return { pageResults, used, dur, localAttempts, err, extras: pageExtras };
  }

  const parallel =
    pageCount > 1 &&
    String(process.env.PAGE_PARALLEL || '1') !== '0' &&
    (!isGoogleEngine(engine) || g.pageParallel());
  if (parallel) {
    const jobs = [];
    for (let i = 0; i < pageCount; i++) jobs.push(fetchPage(start + i * step));
    const settled = await Promise.all(jobs);
    for (const one of settled) {
      attempts += one.localAttempts;
      lastErr = one.err || lastErr;
      if (!one.pageResults) continue;
      pagesFetched += 1;
      duration += one.dur;
      if (one.used) proxyUsed = one.used;
      if (one.extras && !extras) extras = one.extras;
      for (const item of one.pageResults) {
        if (item && item.url && !seen.has(item.url)) {
          seen.add(item.url);
          merged.push(item);
        }
      }
    }
  } else {
    for (let i = 0; i < pageCount; i++) {
      if (Date.now() > deadline) break;
      const one = await fetchPage(start + i * step);
      attempts += one.localAttempts;
      lastErr = one.err || lastErr;
      if (!one.pageResults) {
        if (merged.length === 0) throw lastErr;
        break;
      }
      pagesFetched += 1;
      duration += one.dur;
      proxyUsed = one.used;
      if (one.extras && !extras) extras = one.extras;
      for (const item of one.pageResults) {
        if (item && item.url && !seen.has(item.url)) {
          seen.add(item.url);
          merged.push(item);
        }
      }
      if (one.pageResults.length === 0) break;
      if (autoPages && merged.length >= num) break;
    }
  }

  if (merged.length === 0) {
    circuit.record(engine, lastErr && lastErr.code ? lastErr.code : 'ERROR');
    throw lastErr;
  }
  circuit.record(engine, 'OK');
  const enrichExtras = await attachEnrich(enrich);
  const mergedExtras = Object.keys(extras || {}).length || Object.keys(enrichExtras).length
    ? { ...(extras || {}), ...enrichExtras }
    : null;
  return {
    results: merged.slice(0, autoPages ? Math.min(MAX_NUM, merged.length) : cap),
    duration_ms: duration,
    attempts,
    proxy: proxyUsed,
    source: 'render',
    pages_fetched: pagesFetched,
    pages_requested: pageCount,
    extras: mergedExtras,
  };
}

// Backwards-compatible single-engine entry point used by the gsearch-api
// integration and by callers that import renderSearch directly.
async function renderSearch(opts) {
  return searchEngine({ pages: 1, ...opts });
}

const ALL_SEARCH_ENGINES = ['google', 'duckduckgo', 'bing'];

function parseEngineList(req) {
  const raw = req.query.engines ? String(req.query.engines) : String(req.query.engine || 'google');
  if (raw.trim() === '*' || raw.trim().toLowerCase() === 'all') return ALL_SEARCH_ENGINES.slice();
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list.map(aliasEngine) : ['google'];
}

function aliasEngine(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'googlelite' || n === 'google-lite' || n === 'glite') return 'google_lite';
  if (n === 'chromium') return 'chrome';
  return n;
}

function isGoogleEngine(engine) {
  return engine === 'google' || engine === 'google_lite' || engine === 'chrome';
}

// Google Suggest and Google News are not behind the JavaScript gate, so they
// keep working from a datacenter IP where the SERP itself is gated. The
// Programmable Search JSON API offers neither, which makes these two surfaces
// a concrete quality win over GOOGLE_CSE_KEY / GOOGLE_CSE_CX.
//
// They are started before the SERP request and awaited after it, so they never
// add latency to a slow SERP fetch.
function googleEnrich(engine, query, hl, gl) {
  if (!isGoogleEngine(engine)) return null;
  if (String(process.env.GOOGLE_ENRICH || '1') === '0') return null;
  const suggest = require('./lib/googleSuggest');
  const wantSuggest = String(process.env.GOOGLE_SUGGEST || '1') !== '0';
  const wantNews = String(process.env.GOOGLE_NEWS || '1') !== '0';
  if (!wantSuggest && !wantNews) return null;
  const out = {};
  if (wantSuggest) {
    out.suggestions = suggest
      .suggest(query, { hl, gl, limit: intEnv('GOOGLE_SUGGEST_LIMIT', 10) })
      .catch(() => []);
  }
  if (wantNews) {
    out.news = suggest.news(query, { hl, gl, limit: intEnv('GOOGLE_NEWS_LIMIT', 10) }).catch(() => []);
  }
  return out;
}

async function attachEnrich(enrich) {
  if (!enrich) return {};
  const keys = Object.keys(enrich);
  const values = await Promise.all(keys.map((k) => enrich[k]));
  const out = {};
  keys.forEach((k, i) => {
    const v = values[i];
    if (Array.isArray(v) && v.length) out[k] = v;
  });
  return out;
}

function mergeUnique(lists, cap) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!item || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// Ranks are per page while a response can merge several pages and several
// engines, so they are renumbered once, at the end, to stay contiguous.
function withRanks(results) {
  return (results || []).map((r, i) => ({ ...r, rank: i + 1 }));
}

async function handleSearch(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    return res.status(204).end();
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    return require('./serper')(req, res);
  }
  if (req.method !== 'GET') {
    return send(res, { error: 'Method not allowed', http_status: 405 });
  }
  if (!authOk(req)) return unauthorized(res);

  const q = String(req.query.q || '').trim();
  if (!q) {
    return send(res, {
      service: 'gsearch-renderer',
      ok: true,
      usage:
        'GET /api/search?q=<query>&engine=<name>  OR  engines=<name,name,...|&*>  mode=fallback|merge  num= pages= hl= gl= proxy= nocache= browser=chromium|firefox|edge|safari|brave|tor  fallback=0  explain=1  unique=1  exclude=social,dev  exclude_domains=a.com,b.com  dork=1  dedupe=1  token=  |  shodan: min_ports= has_vulns=1 sort=ports|vulns|ip fields=ip_str,port,hostnames  |  GET /api/shodan/ip?ips=1.2.3.4,5.6.7.8',
      engines: names(),
      pool: poolInfo(),
      note:
        'engines= fallback in order (default). mode=merge runs listed engines in parallel and unions unique URLs. engines=* tries every engine. Lite HTTP is used first when the engine serves static SERP HTML.',
    });
  }
  if (q.length > MAX_QUERY_LEN) {
    return send(res, { error: `Query too long (max ${MAX_QUERY_LEN} chars)`, http_status: 400 });
  }

  const engineList = parseEngineList(req);
  const unknown = engineList.filter((e) => !ENGINES[e]);
  if (unknown.length) {
    return send(res, {
      error: `Unknown engine(s) "${unknown.join(', ')}". Available: ${names().join(', ')}`,
      http_status: 400,
    });
  }

  const num = Math.min(Math.max(1, Number(req.query.num) || 10), MAX_NUM);
  const pagesGiven = req.query.pages !== undefined && req.query.pages !== '';
  const autoPages = !pagesGiven;
  const pages = pagesGiven
    ? Math.min(Math.max(1, Number(req.query.pages) || 1), MAX_PAGES)
    : Math.max(...engineList.map((e) => autoPageCount(e, num)));
  const start = Math.max(0, Number(req.query.start) || 0);
  const hl = String(req.query.hl || 'en').slice(0, 8);
  const gl = String(req.query.gl || 'us').slice(0, 8);
  const proxy = String(req.query.proxy || '').trim();
  const browser = require('./lib/browserFlavor').normalizeFlavor(req.query.browser || req.query.ua);
  const debug = req.query.debug === '1';
  const explain = req.query.explain === '1';
  const proxyless = req.query.proxyless === '1' || req.query.proxyless === 'true';
  const liteOnly = req.query.lite === '1' || req.query.source === 'lite';
  const renderOnly = req.query.render === '1' || req.query.source === 'render';
  const tbs = String(req.query.tbs || '').trim();
  const before = String(req.query.before || '').trim();
  const after = String(req.query.after || '').trim();
  const mode = String(req.query.mode || 'fallback').toLowerCase() === 'merge' ? 'merge' : 'fallback';
  const shodanOpts = parseShodanOptions(req.query);
  const dorkInfo = parseDork(q);
  const dorkMode = req.query.dork === '1' || (dorkInfo.has_operators && req.query.dork !== '0');
  const wantDedupe = dorkMode || req.query.dedupe === '1';
  const resultFilters = parseResultFilters(req.query);
  if (dorkMode) {
    if (resultFilters.social === undefined) resultFilters.social = true;
    if (resultFilters.dev === undefined) resultFilters.dev = true;
    if (resultFilters.ugc === undefined) resultFilters.ugc = true;
    if (resultFilters.forum === undefined) resultFilters.forum = true;
    if (resultFilters.blog === undefined) resultFilters.blog = true;
  }
  const hostSiteTargets = dorkInfo.site_targets.filter(isHostSiteTarget);
  if (hostSiteTargets.length) {
    resultFilters.allowDomains = Array.from(
      new Set([...(resultFilters.allowDomains || []), ...hostSiteTargets])
    );
  }
  const useCache = req.query.nocache !== '1' && !debug && !explain && !proxy && !proxyless;
  const t0 = Date.now();

  function dorkBody(engine) {
    if (!dorkMode) return undefined;
    return {
      enabled: true,
      operators: dorkInfo.operators,
      site_targets: dorkInfo.site_targets,
      engine_support: engineSupport(engine, dorkInfo),
    };
  }

  const cache = getCache();
  const cacheKey = JSON.stringify([
    'v11',
    engineList.join(','),
    mode,
    q,
    num,
    pagesGiven ? pages : 'auto',
    start,
    hl,
    gl,
    proxyless ? 1 : 0,
    liteOnly ? 1 : 0,
    renderOnly ? 1 : 0,
    browser,
    noFallbackRequested(req.query) ? 1 : 0,
    shodanOptionsActive(shodanOpts) ? shodanOpts : 0,
    dorkMode ? 1 : 0,
    wantDedupe ? 1 : 0,
    resultFilters,
    tbs || 0,
    before || 0,
    after || 0,
  ]);
  if (useCache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      return send(res, { ...hit, cached: true, response_time_ms: Date.now() - t0 });
    }
  }

  if (mode === 'merge' && engineList.length > 1) {
    const settled = await Promise.all(
      engineList.map(async (engine) => {
        try {
          const engineQuery = dorkMode ? adaptQuery(q, engine) : q;
          const r = await searchEngine({ engine, query: engineQuery, num, pages, start, hl, gl, proxy, debug, autoPages, proxyless, liteOnly, renderOnly, browser, deadlineAt: Date.now() + searchBudgetMs(), tbs, before, after });
          let results = shodanOptionsActive(shodanOpts)
            ? applyShodanOptions(r.results, shodanOpts)
            : r.results;
          results = applyDomainFilters(results, resultFilters);
          if (dorkMode) results = enforceDork(results, dorkInfo);
          results = withRanks(results);
          r.results = results;
          return { engine, ok: true, r };
        } catch (err) {
          return { engine, ok: false, err };
        }
      })
    );
    const ok = settled.filter((s) => s.ok && s.r && s.r.results && s.r.results.length);
    let results = mergeUnique(ok.map((s) => s.r.results), num);
    if (wantDedupe) results = dedupeResults(results, num);
    const duration = Math.max(0, ...ok.map((s) => s.r.duration_ms || 0));
    const body = {
      engine: ok.length ? ok.map((s) => s.engine).join(',') : engineList[0],
      engines_tried: engineList,
      engines_ok: ok.map((s) => s.engine),
      mode: 'merge',
      query: q,
      success: results.length > 0,
      count: results.length,
      results,
      duration_ms: duration,
      response_time_ms: Date.now() - t0,
      source: ok.map((s) => s.r.source).filter(Boolean).join(',') || 'none',
      browser,
      auto_fallback: autoFallbackEnabled() && !noFallbackRequested(req.query) && !googleStandalone(),
      dork: dorkBody(ok.length ? ok[0].engine : engineList[0]),
      dedupe: wantDedupe,
    };
    const mergeExtras = ok[0] && ok[0].r && ok[0].r.extras;
    if (mergeExtras) {
      if (mergeExtras.knowledgeGraph) body.knowledgeGraph = mergeExtras.knowledgeGraph;
      if (mergeExtras.peopleAlsoAsk) body.peopleAlsoAsk = mergeExtras.peopleAlsoAsk;
      if (mergeExtras.relatedSearches) body.relatedSearches = mergeExtras.relatedSearches;
      if (mergeExtras.answerBox) body.answerBox = mergeExtras.answerBox;
      if (mergeExtras.suggestions) body.suggestions = mergeExtras.suggestions;
      if (mergeExtras.news) body.news = mergeExtras.news;
    }
    if (explain) {
      body.diagnostics = {
        mode: 'merge',
        engines: settled.map((s) => ({
          engine: s.engine,
          success: !!(s.ok && s.r && s.r.results),
          code: s.ok ? (s.r && s.r.results.length ? 'OK' : 'EMPTY_RESULTS') : publicCode(s.err && s.err.code),
          duration_ms: s.ok && s.r ? s.r.duration_ms : null,
        })),
      };
    }
    stats.recordSearch({
      engine: body.engine,
      ok: body.success,
      source: ok[0] && ok[0].r.source,
      duration_ms: Date.now() - t0,
      code: body.success ? 'OK' : 'EMPTY_RESULTS',
    });
    if (useCache && results.length) cache.set(cacheKey, body);
    return send(res, body);
  }

  const requested = engineList[0];
  const { noFallback, tryList } = resolveTryList(engineList, req.query, dorkInfo);
  const attemptsDetail = [];
  let lastErr = new Error('no engine produced a result');
  // Set when an engine returned hits that the dork/domain filters removed.
  let dorkFilteredOut = false;
  const deadlineAt = Date.now() + searchBudgetMs();
  let prevEngine = null;
  // The engines that already ran inside the dork race do not run again in the
  // sequential pass: they had their chance and their budget.
  const racedEngines = new Set();
  for (let ei = 0; ei < tryList.length; ei += 1) {
    let engine = tryList[ei];
    if (Date.now() >= deadlineAt - 1500) break;
    if (racedEngines.has(engine)) {
      attemptsDetail.push({
        engine,
        success: false,
        code: 'RACED_NO_MATCH',
        duration_ms: 0,
      });
      continue;
    }
    // For a dork the browser fallback repeats what google_lite already tried
    // on the same modern surface. Skipping it keeps a failing dork fast
    // instead of paying for a second render.
    if (dorkMode && engine === 'chrome' && engine !== requested) {
      attemptsDetail.push({
        engine,
        success: false,
        code: 'SKIPPED_DORK',
        duration_ms: 0,
      });
      continue;
    }
    if (prevEngine === 'google_lite' && engine === 'chrome') {
      const pause = fallbackDelayMs();
      if (pause && Date.now() + pause + 1500 < deadlineAt) await sleep(pause);
    }
    prevEngine = engine;
    const startedAt = Date.now();
    // Reserve a slice for every remaining fallback engine so a slow first
    // engine (Google on datacenter IPs) cannot consume the whole budget and
    // starve the chain. The plain-HTTP engines answer in well under a second,
    // the browser paths need much more, so only the cheap ones are reserved.
    const remaining = tryList.slice(ei + 1);
    // For a dork the engines that honour site:/filetype: without a browser
    // are the ones that can still answer, so they get a bigger slice.
    const reserve = remaining.reduce((sum, e) => {
      const base = fallbackReserveMs(e);
      const capable = dorkMode && engineSupport(e, dorkInfo).supported.includes('site');
      return sum + (capable ? base * 2 : base);
    }, 0);
    let engineDeadline = Math.min(deadlineAt, startedAt + Math.max(3000, deadlineAt - startedAt - reserve));
    if (dorkMode && engine === 'google_lite') {
      // Google honours site: only on the exits that serve the modern surface
      // to a clean IP. The browser path must not starve bing/duckduckgo, which
      // honour the operator without a browser.
      const cap = Math.max(3000, intEnv('LITE_DORK_ENGINE_MS', 8000));
      engineDeadline = Math.min(engineDeadline, startedAt + cap);
    }
    try {
      const engineQuery = dorkMode ? adaptQuery(q, engine) : q;
      // Google only honours site: on a share of the exits that serve it, so a
      // dork that comes back with nothing on target is retried on another exit
      // before the engine is given up on.
      const engineTries = dorkMode ? Math.max(1, intEnv('DORK_RETRIES', 2)) : 1;
      let r = null;
      let results = [];
      let fetched = 0;
      let raced = false;
      // The dork race: the primary engine and the engines that honour the
      // operator without a browser go at the same time. Google only answers
      // site: from a share of its exits, and it needs a browser to do it, so
      // waiting for it before asking bing means a slow answer to a question
      // bing can answer in a fraction of a second.
      const dorkRace =
        dorkMode && dorkInfo.has_operators && ei === 0 && !noFallback
          ? [engine].concat(
              tryList
                .slice(1)
                .filter(
                  (e) =>
                    // The chrome engine is the browser fallback: racing it
                    // with google_lite only makes two renders compete for the
                    // same pool. The plain-HTTP engines are the interesting
                    // opponents, they answer in milliseconds.
                    e !== 'chrome' &&
                    engineSupport(e, dorkInfo).supported.includes('site'),
                ),
            )
          : null;
      if (dorkRace && dorkRace.length > 1) {
        // Whatever happens, these engines have had their chance: they must
        // not run a second time in the sequential pass.
        for (const e of dorkRace) racedEngines.add(e);
        try {
          const winner = await raceDorkEngines(dorkRace, {
            q,
            dorkInfo,
            dorkMode,
            num,
            pages,
            start,
            hl,
            gl,
            proxy,
            debug,
            autoPages,
            proxyless,
            liteOnly: dorkLiteOnly(engine, dorkMode, liteOnly),
            renderOnly,
            browser,
            deadlineAt: engineDeadline,
            tbs,
            before,
            after,
          });
          engine = winner.engine;
          r = winner.r;
          results = winner.items;
          fetched = (r.results || []).length;
          raced = true;
        } catch (raceErr) {
          lastErr = raceErr && raceErr.code ? raceErr : Object.assign(new Error('no engine answered the dork'), { code: 'EMPTY_RESULTS' });
        }
      }
      for (let attempt = 0; attempt < engineTries; attempt += 1) {
        // A raced winner already carries its result object; the normal path
        // still has to fetch one.
        if (r === null) {
          r = await searchEngine({ engine, query: engineQuery, num, pages, start, hl, gl, proxy, debug, autoPages, proxyless, liteOnly: dorkLiteOnly(engine, dorkMode, liteOnly), renderOnly, browser, deadlineAt: engineDeadline, tbs, before, after });
        }
        fetched = (r.results || []).length;
        results = shodanOptionsActive(shodanOpts)
          ? applyShodanOptions(r.results, shodanOpts)
          : r.results;
        results = applyDomainFilters(results, resultFilters);
        if (dorkMode) results = enforceDork(results, dorkInfo);
        if (wantDedupe) results = dedupeResults(results, num);
        results = withRanks(results);
        if (results.length > 0 || fetched === 0) break;
        if (attempt < engineTries - 1) {
          // The engine did answer, every hit was dropped by the site:/filetype:
          // filter. Try another exit before calling it a failure.
          dorkFilteredOut = true;
          if (Date.now() >= engineDeadline - 1000) break;
        }
      }
      if (results.length === 0 && fetched > 0) {
        // The engine did answer, every hit was dropped by the site:/filetype:
        // filter. That is a real answer, not an unreachable engine.
        dorkFilteredOut = true;
      }
      if (results.length === 0) {
        attemptsDetail.push({
          engine,
          success: false,
          code: 'EMPTY_RESULTS',
          duration_ms: r.duration_ms,
        });
        lastErr = Object.assign(new Error('No results matched'), { code: 'EMPTY_RESULTS' });
        continue;
      }
      attemptsDetail.push({
        engine,
        success: true,
        code: 'OK',
        duration_ms: r.duration_ms,
        ...(raced ? { raced: true } : {}),
      });
      const body = {
        engine,
        requested_engine: requested,
        fallback: engine !== requested,
        engines_tried: tryList.slice(0, tryList.indexOf(engine) + 1),
        query: q,
        success: true,
        count: results.length,
        results,
        duration_ms: r.duration_ms,
        response_time_ms: Date.now() - t0,
        attempts: r.attempts,
        pages_fetched: r.pages_fetched,
        pages_requested: r.pages_requested,
        source: r.source,
        transport: r.transport || null,
        proxy: maskProxy(r.proxy),
        browser,
        auto_fallback: !noFallback && !googleStandalone(),
        dork: dorkBody(engine),
        dedupe: wantDedupe,
      };
      if (r.extras) {
        if (r.extras.knowledgeGraph) body.knowledgeGraph = r.extras.knowledgeGraph;
        if (r.extras.peopleAlsoAsk) body.peopleAlsoAsk = r.extras.peopleAlsoAsk;
        if (r.extras.relatedSearches) body.relatedSearches = r.extras.relatedSearches;
        if (r.extras.answerBox) body.answerBox = r.extras.answerBox;
        // Surfaced by the Google transport and by the Custom Search API path
        // alike, so both engines expose the same shape.
        if (r.extras.suggestions) body.suggestions = r.extras.suggestions;
        if (r.extras.news) body.news = r.extras.news;
      }
      if (explain) {
        body.diagnostics = {
          mode: 'fallback',
          requested_engine: requested,
          auto_fallback: !noFallback && !googleStandalone(),
          engines: attemptsDetail,
        };
      }
      stats.recordSearch({ engine, ok: true, source: r.source, duration_ms: Date.now() - t0, code: 'OK' });
      if (useCache && results.length) cache.set(cacheKey, body);
      return send(res, body);
    } catch (err) {
      attemptsDetail.push({
        engine,
        success: false,
        code: publicCode(err && err.code),
        duration_ms: Date.now() - startedAt,
      });
      if (err && err.code === 'UNKNOWN_ENGINE') {
        return send(res, { error: err.message, http_status: 400, response_time_ms: Date.now() - t0 });
      }
      lastErr = err;
    }
  }

  stats.recordSearch({
    engine: requested,
    ok: false,
    source: null,
    duration_ms: Date.now() - t0,
    code: lastErr.code || 'ERROR',
  });
  // When an engine answered but every hit was removed by the site:/filetype:
  // filter, say so instead of claiming the engine could not be reached.
  const filteredCode = dorkFilteredOut ? 'EMPTY_RESULTS' : publicCode(lastErr.code);
  const failed = {
    engine: requested,
    requested_engine: requested,
    fallback: false,
    engines_tried: tryList,
    query: q,
    success: false,
    code: filteredCode,
    error: dorkFilteredOut
      ? `Search returned results, but none matched the site:/filetype: filter for "${q}".`
      : publicMessage(requested, lastErr),
    count: 0,
    results: [],
    duration_ms: Date.now() - t0,
    response_time_ms: Date.now() - t0,
    auto_fallback: !noFallback && !googleStandalone(),
    dork: dorkBody(requested),
    dedupe: wantDedupe,
  };
  if (explain) {
    failed.diagnostics = {
      mode: 'fallback',
      requested_engine: requested,
      auto_fallback: !noFallback && !googleStandalone(),
      engines: attemptsDetail,
    };
  }
  return send(res, failed);
}

module.exports = async (req, res) => {
  try {
    return await handleSearch(req, res);
  } finally {
    const q = req && req.query ? String(req.query.q || '').trim() : '';
    if (q) await sweepIdle().catch(() => {});
  }
};

module.exports.config = { maxDuration: 60, memory: 1024 };
module.exports.renderSearch = renderSearch;
module.exports.searchEngine = searchEngine;
module.exports.pageStep = pageStep;
module.exports.perPageNum = perPageNum;
module.exports.autoPageCount = autoPageCount;
module.exports.GOOGLE_PAGE_SIZE = GOOGLE_PAGE_SIZE;
module.exports.MAX_PAGES = MAX_PAGES;
module.exports.withFallbacks = withFallbacks;
module.exports.autoFallbackEnabled = autoFallbackEnabled;
module.exports.resolveTryList = resolveTryList;
module.exports.noFallbackRequested = noFallbackRequested;
module.exports.AUTO_FALLBACK_CHAIN = AUTO_FALLBACK_CHAIN;
module.exports.publicCode = publicCode;
module.exports.publicMessage = publicMessage;
module.exports.aliasEngine = aliasEngine;
module.exports.isGoogleEngine = isGoogleEngine;
module.exports.parseEngineList = parseEngineList;
module.exports.ALL_SEARCH_ENGINES = ALL_SEARCH_ENGINES;
module.exports.withGoogleLiteFallback = withGoogleLiteFallback;
module.exports.fallbackDelayMs = fallbackDelayMs;
