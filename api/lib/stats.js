'use strict';

const started = Date.now();
const totals = {
  search: 0,
  search_ok: 0,
  search_fail: 0,
  batch: 0,
  crawl: 0,
  lite: 0,
  render: 0,
};
const byEngine = Object.create(null);
const durations = [];

function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

function recordSearch({ engine, ok, source, duration_ms, code }) {
  totals.search += 1;
  if (ok) totals.search_ok += 1;
  else totals.search_fail += 1;
  if (source === 'lite') totals.lite += 1;
  if (source === 'render') totals.render += 1;
  if (engine) {
    if (!byEngine[engine]) byEngine[engine] = { ok: 0, fail: 0, lite: 0, render: 0 };
    byEngine[engine][ok ? 'ok' : 'fail'] += 1;
    if (source === 'lite' || source === 'render') byEngine[engine][source] += 1;
  }
  const ms = Number(duration_ms);
  if (Number.isFinite(ms) && ms >= 0) {
    durations.push(ms);
    if (durations.length > 500) durations.shift();
  }
  return code;
}

function recordBatch() {
  totals.batch += 1;
}

function recordCrawl() {
  totals.crawl += 1;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return Math.round(s[i]);
}

function snapshot() {
  return {
    uptime_s: Math.round((Date.now() - started) / 1000),
    totals,
    engines: byEngine,
    latency_ms: {
      n: durations.length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length ? Math.round(Math.max(...durations)) : 0,
    },
  };
}

function reset() {
  totals.search = totals.search_ok = totals.search_fail = totals.batch = totals.crawl = totals.lite = totals.render = 0;
  for (const k of Object.keys(byEngine)) delete byEngine[k];
  durations.length = 0;
}

module.exports = { recordSearch, recordBatch, recordCrawl, snapshot, reset };
