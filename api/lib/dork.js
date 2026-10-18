'use strict';

// Dork-aware helpers: operator detection, per-engine capability checks, query
// adaptation and canonical de-duplication.
//
// A "dork" here is simply a query that uses advanced search operators
// (site:, inurl:, intitle:, filetype:), quoted phrases or -exclusions. There
// is no special dork result format; these helpers only make sure operators are
// preserved and that we know which engines understand them.

const OPERATORS = [
  ['site', /\bsite:\s*("[^"]+"|[^\s]+)/gi],
  ['inurl', /\binurl:\s*("[^"]+"|[^\s]+)/gi],
  ['intitle', /\bintitle:\s*("[^"]+"|[^\s]+)/gi],
  ['intext', /\bintext:\s*("[^"]+"|[^\s]+)/gi],
  ['allintext', /\ballintext:\s*("[^"]+"|[^\s]+)/gi],
  ['inbody', /\binbody:\s*("[^"]+"|[^\s]+)/gi],
  ['inanchor', /\binanchor:\s*("[^"]+"|[^\s]+)/gi],
  ['filetype', /\b(?:filetype|ext):\s*("[^"]+"|[^\s]+)/gi],
  ['related', /\brelated:\s*("[^"]+"|[^\s]+)/gi],
  ['cache', /\bcache:\s*("[^"]+"|[^\s]+)/gi],
  ['title', /\btitle:\s*("[^"]+"|[^\s]+)/gi],
  ['url', /\burl:\s*("[^"]+"|[^\s]+)/gi],
  ['mime', /\bmime:\s*("[^"]+"|[^\s]+)/gi],
];

const CAPABILITY = {
  google: ['site', 'inurl', 'intitle', 'intext', 'allintext', 'inbody', 'inanchor', 'filetype', 'related', 'cache'],
  bing: ['site', 'intitle', 'intext', 'inbody', 'inanchor', 'filetype'],
  yahoo: ['site', 'intitle', 'inurl', 'filetype'],
  duckduckgo: ['site', 'intitle', 'inurl', 'filetype'],
  duckduckgo_lite: ['site', 'intitle', 'inurl', 'filetype'],
  brave: ['site', 'intitle', 'intext', 'filetype'],
  mojeek: ['site', 'intitle', 'inurl', 'filetype'],
  startpage: ['site', 'intitle', 'inurl', 'filetype'],
  ecosia: ['site', 'intitle', 'inurl', 'filetype'],
  qwant: ['site', 'intitle', 'inurl', 'filetype'],
  swisscows: ['site', 'filetype'],
  seznam: ['site', 'intitle', 'url'],
  yandex: ['site', 'title', 'url', 'mime'],
  marginalia: ['site', 'filetype'],
  wiby: [],
  github: [],
  wikipedia: [],
  archive: [],
  shodan: [],
};

function unquote(value) {
  const v = String(value || '').trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function normalizeSite(value) {
  return unquote(value)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/^\*\./, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function parseDork(query) {
  const raw = String(query || '');
  const operators = {};
  let isDork = false;

  for (const [key, re] of OPERATORS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw))) {
      isDork = true;
      const value = unquote(m[1]);
      if (!value) continue;
      if (!operators[key]) operators[key] = [];
      if (!operators[key].includes(value)) operators[key].push(value);
    }
  }

  const phrases = Array.from(raw.matchAll(/"([^"]{2,})"/g)).map((m) => m[1]);
  const exclusions = Array.from(raw.matchAll(/(?:^|\s)-(\S+)/g)).map((m) => m[1]);
  if (phrases.length || exclusions.length) isDork = true;

  const siteTargets = (operators.site || [])
    .map(normalizeSite)
    .filter(Boolean);

  return {
    is_dork: isDork,
    has_operators: Object.keys(operators).length > 0,
    operators,
    phrases,
    exclusions,
    site_targets: Array.from(new Set(siteTargets)),
  };
}

function engineSupport(engine, dorkInfo) {
  const supported = new Set(CAPABILITY[engine] || ['site', 'filetype']);
  const used = Object.keys((dorkInfo && dorkInfo.operators) || {});
  return {
    supported: used.filter((k) => supported.has(k)),
    unsupported: used.filter((k) => !supported.has(k)),
  };
}

// Yandex uses different operator names. Other engines keep the query as-is;
// unsupported operators are reported instead of silently rewritten.
function adaptQuery(query, engine) {
  let q = String(query || '');
  if (engine === 'yandex') {
    q = q
      .replace(/\binurl:/gi, 'url:')
      .replace(/\bintitle:/gi, 'title:')
      .replace(/\bfiletype:/gi, 'mime:')
      .replace(/\bext:/gi, 'mime:');
  }
  return q.replace(/\s+/g, ' ').trim();
}

const TRACKING_PARAM = /^(?:utm_[a-z]+|gclid|dclid|fbclid|yclid|msclkid|igshid|mc_cid|mc_eid|ref|ref_src|source)$/i;

function canonicalUrl(url) {
  try {
    const u = new URL(String(url || ''));
    u.hash = '';
    const drop = [];
    for (const key of u.searchParams.keys()) {
      if (TRACKING_PARAM.test(key)) drop.push(key);
    }
    for (const key of drop) u.searchParams.delete(key);
    const path = u.pathname.replace(/\/+$/, '');
    u.pathname = path || '/';
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url || '');
  }
}

function dedupeResults(list, cap) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = canonicalUrl(item && item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (cap && out.length >= cap) break;
  }
  return out;
}

module.exports = {
  parseDork,
  engineSupport,
  adaptQuery,
  canonicalUrl,
  dedupeResults,
  CAPABILITY,
};
