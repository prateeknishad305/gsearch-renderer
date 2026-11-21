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
  google_lite: ['site', 'inurl', 'intitle', 'intext', 'allintext', 'inbody', 'inanchor', 'filetype', 'related', 'cache'],
  chrome: ['site', 'inurl', 'intitle', 'intext', 'allintext', 'inbody', 'inanchor', 'filetype', 'related', 'cache'],
  bing: ['site', 'inurl', 'intitle', 'intext', 'inbody', 'inanchor', 'filetype'],
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
    .replace(/^\*\./, '.')
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

// The operators an engine understands natively. An engine that does not
// understand an operator must not receive it: "site:python.org" typed into a
// search box without operator support is searched for as the literal text
// "site:python.org", which returns nothing useful. The operator is dropped
// from the query instead and the constraint is enforced on the results.
function nativeSupport(engine) {
  const list = CAPABILITY[engine];
  return Array.isArray(list) ? list : [];
}

// The Google family receives the operator as an advanced-search parameter
// (as_sitesearch/as_filetype) rather than inside the query string, because
// Google drops the operator from q on automated traffic. The query therefore
// keeps the operator here; the URL builder moves it.
function usesOperatorParameter(engine) {
  return engine === 'google' || engine === 'google_lite' || engine === 'chrome';
}

// filetype:, ext: and mime: are the same constraint spelled differently.
const FILETYPE_KEYS = ['filetype', 'ext', 'mime'];

function isFileTypeKey(key) {
  return FILETYPE_KEYS.includes(key);
}

// The operator patterns, keyed by the name used in the capability table.
const OPERATOR_RE = {};
for (const [key, re] of OPERATORS) OPERATOR_RE[key] = re;

// Removes the given operators from a query.
function stripOperators(query, keys) {
  let q = String(query || '');
  for (const key of keys || []) {
    const re = isFileTypeKey(key) ? FILETYPE_RE : OPERATOR_RE[key];
    if (!re) continue;
    re.lastIndex = 0;
    q = q.replace(re, ' ');
  }
  return q.replace(/\s+/g, ' ').trim();
}

// Rewrites an operator into the spelling the engine uses. The value of the
// operator has to survive the rewrite.
const DIALECT = {
  yandex: { inurl: 'url', intitle: 'title', filetype: 'mime', ext: 'mime' },
};

function translateDialect(query, engine) {
  let q = String(query || '');
  const map = DIALECT[engine];
  if (map) {
    for (const [from, to] of Object.entries(map)) {
      const re = OPERATOR_RE[from];
      if (!re) continue;
      re.lastIndex = 0;
      q = q.replace(re, (match, value) => `${to}:${value}`);
    }
  }
  // Everywhere but yandex the file type operator is called filetype:.
  if (engine !== 'yandex') {
    q = q.replace(/\bmime:/gi, 'filetype:').replace(/\bext:/gi, 'filetype:');
  }
  return q;
}

function engineSupport(engine, dorkInfo) {
  const supported = new Set(nativeSupport(engine));
  const used = Object.keys((dorkInfo && dorkInfo.operators) || {});
  return {
    supported: used.filter((k) => supported.has(k)),
    unsupported: used.filter((k) => !supported.has(k)),
    // Whether the engine honours the site: constraint on its own. An engine
    // that does not can still answer a dork, its hits are just checked
    // against the constraint afterwards.
    site_native: supported.has('site'),
  };
}

// Builds the query an engine is actually asked for.
//
// - operators the engine understands are kept, in the engine's own spelling;
// - operators it does not understand are removed, so the engine searches for
//   the words of the query instead of the operator token;
// - the Google family keeps the operator, because its URL builder moves it
//   into as_sitesearch/as_filetype.
function adaptQuery(query, engine) {
  const raw = String(query || '');
  let q = translateDialect(raw, engine);
  if (usesOperatorParameter(engine)) return q.replace(/\s+/g, ' ').trim();

  // The operators that are left after the dialect rewrite decide what the
  // engine can keep.
  const info = parseDork(q);
  const supported = new Set(nativeSupport(engine));
  // The file type family counts as one operator: an engine that understands
  // filetype: understands ext: and mime: as well.
  const understandsFileType = FILETYPE_KEYS.some((k) => supported.has(k));
  const drop = Object.keys(info.operators || {}).filter((k) => {
    if (isFileTypeKey(k)) return !understandsFileType;
    return !supported.has(k);
  });
  if (drop.length) q = stripOperators(q, drop);
  q = q.replace(/\s+/g, ' ').trim();
  if (q) return q;
  // The query was nothing but operators ("site:github.com"). Stripping them
  // would leave the engine with an empty query, so the value of the operator
  // becomes a plain word instead: the engine still has something to search
  // for and the constraint is enforced on the results.
  const words = []
    .concat(info.site_targets || [])
    .concat(Object.values(info.operators || {}).flat())
    .map((v) => String(v).replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
  return Array.from(new Set(words)).join(' ');
}

// Google honours its advanced-search parameters (as_sitesearch/as_filetype)
// even when it drops the matching operator from q on automated traffic, so
// callers move the operator into a parameter and strip it from the query.
// filetype:, ext: and mime: all mean the same thing, so they are stripped
// together.
const FILETYPE_RE = /\b(?:filetype|ext|mime):\s*("[^"]+"|[^\s]+)/gi;

function stripOperator(query, key) {
  const re = isFileTypeKey(key) ? FILETYPE_RE : OPERATOR_RE[key];
  if (!re) return String(query || '');
  re.lastIndex = 0;
  return String(query || '')
    .replace(re, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRACKING_PARAM = /^(?:utm_[a-z0-9_]+|gclid|dclid|fbclid|yclid|msclkid|igshid|mc_cid|mc_eid|ref|ref_src|source|ved|usg|sa|sxsrf|ei|gs_lcp|sourceid|ie|oe)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalUrl(url) {
  try {
    const u = new URL(String(url || ''));
    u.hash = '';
    const drop = [];
    for (const [key, val] of u.searchParams.entries()) {
      if (TRACKING_PARAM.test(key)) drop.push(key);
      else if (key === 't' && UUID_RE.test(String(val))) drop.push(key);
      else if (key === 'param' && /^\d{1,6}$/.test(String(val))) drop.push(key);
    }
    for (const key of drop) u.searchParams.delete(key);
    const path = u.pathname.replace(/\/+$/, '');
    u.pathname = path || '/';
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url || '');
  }
}

function isHostSiteTarget(target) {
  const t = String(target || '')
    .toLowerCase()
    .replace(/^www\./, '');
  return Boolean(t) && t.includes('.') && !t.startsWith('.');
}

function hostMatchesSite(host, target) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/^www\./, '');
  const t = String(target || '')
    .toLowerCase()
    .replace(/^www\./, '');
  if (!h || !t) return false;
  if (t.startsWith('.')) return h === t.slice(1) || h.endsWith(t);
  return h === t || h.endsWith(`.${t}`);
}

function enforceDork(results, dorkInfo) {
  if (!Array.isArray(results) || !dorkInfo) return results;
  let out = results;

  const sites = dorkInfo.site_targets || [];
  if (sites.length) {
    out = out.filter((r) => {
      try {
        return sites.some((s) => hostMatchesSite(new URL(r.url).hostname, s));
      } catch {
        return false;
      }
    });
  }

  const filetypes = []
    .concat(dorkInfo.operators && dorkInfo.operators.filetype)
    .concat(dorkInfo.operators && dorkInfo.operators.ext)
    .concat(dorkInfo.operators && dorkInfo.operators.mime)
    .filter(Boolean)
    .map((v) => String(v).replace(/^\./, '').toLowerCase());
  if (filetypes.length) {
    out = out.filter((r) => {
      try {
        const path = new URL(r.url).pathname.toLowerCase();
        return filetypes.some((ext) => path.endsWith(`.${ext}`));
      } catch {
        return false;
      }
    });
  }

  const inurls = (dorkInfo.operators && dorkInfo.operators.inurl) || [];
  if (inurls.length) {
    out = out.filter((r) => {
      const u = String(r && r.url || '').toLowerCase();
      return inurls.every((tok) => u.includes(String(tok).toLowerCase()));
    });
  }

  return out;
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
  nativeSupport,
  usesOperatorParameter,
  stripOperator,
  stripOperators,
  canonicalUrl,
  dedupeResults,
  enforceDork,
  hostMatchesSite,
  isHostSiteTarget,
  CAPABILITY,
};
