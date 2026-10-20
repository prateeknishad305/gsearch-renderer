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
const { send, cors, authOk, unauthorized, maskProxy } = require('./lib/http');
const { parseShodanOptions, applyShodanOptions, active: shodanOptionsActive } = require('./lib/shodanQuery');
const { parseResultFilters, applyDomainFilters } = require('./lib/resultFilter');
const { parseDork, engineSupport, adaptQuery, dedupeResults, enforceDork } = require('./lib/dork');
const circuit = require('./lib/circuit');
const stats = require('./lib/stats');
const g = require('./lib/google');
const googleIp = require('./lib/googleIp');
const proxyRace = require('./lib/proxyRace');

const MAX_NUM = 100;
const MAX_PAGES = 10;
const MAX_QUERY_LEN = 512;
const GOOGLE_PAGE_SIZE = 10;
const FIXED_PAGE_SIZE = { google: 10, yahoo: 10 };

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
  process.env.AUTO_FALLBACK_ENGINES ||
    'duckduckgo,bing,wikipedia,archive,github,wiby,brave,yahoo,startpage,marginalia,mojeek,ecosia,qwant,yandex,google'
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

function resolveTryList(engineList, query) {
  const noFallback = noFallbackRequested(query);
  return { noFallback, tryList: noFallback ? engineList.slice() : withFallbacks(engineList) };
}

// Appends the fallback chain to an engine list, preserving order and dropping
// duplicates. With AUTO_FALLBACK=0 the list is returned untouched.
function withFallbacks(list) {
  if (!autoFallbackEnabled()) return list.slice();
  const out = list.slice();
  const seen = new Set(out);
  for (const e of AUTO_FALLBACK_CHAIN) {
    if (!seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

// Codes that mean "this engine could not be fetched from here" rather than a
// programming error. They are never surfaced verbatim to API callers.
const UNAVAILABLE_CODES = new Set(['BLOCKED', 'SORRY', 'CIRCUIT_OPEN']);

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
  return intEnv('PROXY_WINDOW_MS', 28000);
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
  const fallbackDirect = String(process.env.PROXY_FALLBACK_DIRECT || '1') !== '0';
  if (fallbackDirect && !tries.includes(null)) tries.push(null);
  return tries.length ? tries : [null];
}

function buildTries(explicitProxy, proxyless, engine, stickyKey) {
  const google = engine === 'google';
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
  const fallbackDirect = String(process.env.PROXY_FALLBACK_DIRECT || '1') !== '0';
  if (fallbackDirect || tries.length === 0) tries.push(null);
  return tries;
}

// Runs one engine, optionally across multiple result pages, merging unique URLs.
// autoPages=true keeps fetching until `num` unique URLs (or MAX_PAGES).
async function searchEngine({ engine, query, num, pages = 1, start = 0, hl = 'en', gl = 'us', proxy, debug, autoPages = false, proxyless = false, liteOnly = false, browser }) {
  const pageCount = Math.min(Math.max(1, pages), MAX_PAGES);
  const step = pageStep(engine, num);
  const perPage = perPageNum(engine, num);
  const cap = Math.min(MAX_NUM, autoPages ? Math.max(num, 1) : num * pageCount);

  if (!debug && liteEnabled(engine)) {
    try {
      const lite = await fastLiteSearch({ engine, query, num: cap, hl, gl, start });
      if (lite.results && lite.results.length) {
        circuit.record(engine, 'OK');
        return {
          results: lite.results.slice(0, cap),
          duration_ms: lite.duration_ms,
          attempts: 1,
          proxy: null,
          source: 'lite',
          pages_fetched: 1,
          pages_requested: pageCount,
        };
      }
     } catch (err) {
       if (liteOnly || skipRender(engine) || (engine !== 'google' && isHardBlock(err))) {
         if (err && err.code) throw err;
         const e = new Error(`Engine "${engine}" lite path empty`);
         e.code = 'LITE_EMPTY';
         throw e;
       }
     }
   }
   if (liteOnly || skipRender(engine)) {
     const e = new Error(`Engine "${engine}" has no lite results`);
     e.code = 'LITE_EMPTY';
     throw e;
   }

  if (engine !== 'google' && circuit.isOpen(engine)) {
    const e = new Error(`Engine "${engine}" circuit open after repeated failures`);
    e.code = 'CIRCUIT_OPEN';
    throw e;
  }

  const deadline = Date.now() + requestTimeoutMs() * pageCount;
  const merged = [];
  const seen = new Set();
  let attempts = 0;
  let pagesFetched = 0;
  let proxyUsed = null;
  let duration = 0;
  let lastErr = new Error('no search attempt could be made');
  const stickyKey = engine === 'google' ? `g:${query}|${hl}|${gl}` : '';

  async function fetchPage(offset) {
    let pageResults = null;
    let used = null;
    let dur = 0;
    let localAttempts = 0;
    let err = lastErr;
    const candidates = buildTries(proxy, proxyless, engine, stickyKey);
    let skipProxies = false;
    const width = proxyRace.raceWidth();

    async function attempt(candidate) {
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
      if (engine === 'google' && candidate) {
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
        const r = await runQuery({ engine, query, num: perPage, start: offset, hl, gl, proxy: candidate, debug, browser });
        if (candidate) googleIp.record(candidate, 'OK');
        return { pageResults: r.results, used: candidate, dur: r.duration_ms };
      } catch (caught) {
        if (candidate && engine !== 'google') googleIp.record(candidate, (caught && caught.code) || 'ERROR');
        throw caught;
      }
    }

    for (const group of proxyRace.batches(candidates, width)) {
      if (Date.now() > deadline) break;
      const batch = skipProxies ? group.filter((c) => !c) : group;
      if (!batch.length) continue;
      try {
        const win = await proxyRace.firstOk(batch.map((c) => () => attempt(c)));
        pageResults = win.pageResults;
        used = win.used;
        dur = win.dur;
        if (engine === 'google' && used) setStickyGoogleProxy(stickyKey, used);
        break;
      } catch (caught) {
        err = caught;
        if (caught && caught.code === 'UNKNOWN_ENGINE') throw caught;
        if (engine === 'google') dropStickyGoogleProxy(stickyKey);
        if (isHardBlock(caught)) {
          if (engine === 'google') skipProxies = true;
          else break;
        }
      }
    }
    if (!pageResults && proxyless && isNetFail(err) && String(process.env.PROXYLESS_STRICT || '0') !== '1') {
      for (const candidate of buildTries(null, false, engine, stickyKey)) {
        if (Date.now() > deadline) break;
        if (candidate == null) continue;
        localAttempts += 1;
        try {
        const r = await runQuery({ engine, query, num: perPage, start: offset, hl, gl, proxy: candidate, debug, browser });
          pageResults = r.results;
          dur = r.duration_ms;
          used = candidate;
          break;
        } catch (caught) {
          err = caught;
          if (caught && caught.code === 'UNKNOWN_ENGINE') throw caught;
        }
      }
    }
    return { pageResults, used, dur, localAttempts, err };
  }

  const parallel =
    pageCount > 1 &&
    String(process.env.PAGE_PARALLEL || '1') !== '0' &&
    (engine !== 'google' || g.pageParallel());
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
  return {
    results: merged.slice(0, autoPages ? Math.min(MAX_NUM, merged.length) : cap),
    duration_ms: duration,
    attempts,
    proxy: proxyUsed,
    source: 'render',
    pages_fetched: pagesFetched,
    pages_requested: pageCount,
  };
}

// Backwards-compatible single-engine entry point used by the gsearch-api
// integration and by callers that import renderSearch directly.
async function renderSearch(opts) {
  return searchEngine({ pages: 1, ...opts });
}

function parseEngineList(req) {
  const raw = req.query.engines ? String(req.query.engines) : String(req.query.engine || 'google');
  if (raw.trim() === '*' || raw.trim().toLowerCase() === 'all') return names();
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : ['google'];
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

module.exports = async (req, res) => {
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
  const mode = String(req.query.mode || 'fallback').toLowerCase() === 'merge' ? 'merge' : 'fallback';
  const shodanOpts = parseShodanOptions(req.query);
  const dorkInfo = parseDork(q);
  const dorkMode = req.query.dork === '1' || (dorkInfo.has_operators && req.query.dork !== '0');
  const wantDedupe = dorkMode || req.query.dedupe === '1';
  const resultFilters = parseResultFilters(req.query);
  if (dorkMode) {
    if (resultFilters.social === undefined) resultFilters.social = true;
    if (resultFilters.dev === undefined) resultFilters.dev = true;
  }
  if (dorkInfo.site_targets.length) {
    resultFilters.allowDomains = Array.from(
      new Set([...(resultFilters.allowDomains || []), ...dorkInfo.site_targets])
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
    'v8',
    engineList.join(','),
    mode,
    q,
    num,
    pagesGiven ? pages : 'auto',
    start,
    hl,
    gl,
    proxyless ? 1 : 0,
    browser,
    noFallbackRequested(req.query) ? 1 : 0,
    shodanOptionsActive(shodanOpts) ? shodanOpts : 0,
    dorkMode ? 1 : 0,
    wantDedupe ? 1 : 0,
    resultFilters,
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
          const r = await searchEngine({ engine, query: engineQuery, num, pages, start, hl, gl, proxy, debug, autoPages, proxyless, browser });
          let results = shodanOptionsActive(shodanOpts)
            ? applyShodanOptions(r.results, shodanOpts)
            : r.results;
          results = applyDomainFilters(results, resultFilters);
          if (dorkMode) results = enforceDork(results, dorkInfo);
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
      auto_fallback: autoFallbackEnabled() && !noFallbackRequested(req.query),
      dork: dorkBody(ok.length ? ok[0].engine : engineList[0]),
      dedupe: wantDedupe,
    };
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
  const { noFallback, tryList } = resolveTryList(engineList, req.query);
  const attemptsDetail = [];
  let lastErr = new Error('no engine produced a result');
  for (const engine of tryList) {
    const startedAt = Date.now();
    try {
      const engineQuery = dorkMode ? adaptQuery(q, engine) : q;
      const r = await searchEngine({ engine, query: engineQuery, num, pages, start, hl, gl, proxy, debug, autoPages, proxyless, browser });
      let results = shodanOptionsActive(shodanOpts)
        ? applyShodanOptions(r.results, shodanOpts)
        : r.results;
      results = applyDomainFilters(results, resultFilters);
      if (dorkMode) results = enforceDork(results, dorkInfo);
      if (wantDedupe) results = dedupeResults(results, num);
      if (
        results.length === 0 &&
        dorkMode &&
        (dorkInfo.site_targets.length || (dorkInfo.operators.filetype || []).length)
      ) {
        attemptsDetail.push({
          engine,
          success: false,
          code: 'EMPTY_RESULTS',
          duration_ms: r.duration_ms,
        });
        lastErr = Object.assign(new Error('No results matched dork constraints'), { code: 'EMPTY_RESULTS' });
        continue;
      }
      attemptsDetail.push({
        engine,
        success: results.length > 0,
        code: results.length ? 'OK' : 'EMPTY_RESULTS',
        duration_ms: r.duration_ms,
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
        proxy: maskProxy(r.proxy),
        browser,
        auto_fallback: !noFallback,
        dork: dorkBody(engine),
        dedupe: wantDedupe,
      };
      if (explain) {
        body.diagnostics = {
          mode: 'fallback',
          requested_engine: requested,
          auto_fallback: !noFallback,
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
  const failed = {
    engine: requested,
    requested_engine: requested,
    fallback: false,
    engines_tried: tryList,
    query: q,
    success: false,
    code: publicCode(lastErr.code),
    error: publicMessage(requested, lastErr),
    count: 0,
    results: [],
    duration_ms: Date.now() - t0,
    response_time_ms: Date.now() - t0,
    auto_fallback: !noFallback,
    dork: dorkBody(requested),
    dedupe: wantDedupe,
  };
  if (explain) {
    failed.diagnostics = {
      mode: 'fallback',
      requested_engine: requested,
      auto_fallback: !noFallback,
      engines: attemptsDetail,
    };
  }
  return send(res, failed);
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
