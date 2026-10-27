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
  ['allinurl', /\ballinurl:\s*("[^"]+"|[^\s]+)/gi],
  ['intitle', /\bintitle:\s*("[^"]+"|[^\s]+)/gi],
  ['allintitle', /\ballintitle:\s*("[^"]+"|[^\s]+)/gi],
  ['intext', /\bintext:\s*("[^"]+"|[^\s]+)/gi],
  ['allintext', /\ballintext:\s*("[^"]+"|[^\s]+)/gi],
  ['inbody', /\binbody:\s*("[^"]+"|[^\s]+)/gi],
  ['inanchor', /\binanchor:\s*("[^"]+"|[^\s]+)/gi],
  ['allinanchor', /\ballinanchor:\s*("[^"]+"|[^\s]+)/gi],
  ['filetype', /\b(?:filetype|ext):\s*("[^"]+"|[^\s]+)/gi],
  ['related', /\brelated:\s*("[^"]+"|[^\s]+)/gi],
  ['cache', /\bcache:\s*("[^"]+"|[^\s]+)/gi],
  ['title', /\btitle:\s*("[^"]+"|[^\s]+)/gi],
  ['url', /\burl:\s*("[^"]+"|[^\s]+)/gi],
  ['mime', /\bmime:\s*("[^"]+"|[^\s]+)/gi],
  ['before', /\bbefore:\s*([0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?)/gi],
  ['after', /\bafter:\s*([0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?)/gi],
  ['define', /\bdefine:\s*("[^"]+"|[^\s]+)/gi],
  ['info', /\binfo:\s*("[^"]+"|[^\s]+)/gi],
  ['link', /\blink:\s*("[^"]+"|[^\s]+)/gi],
  ['source', /\bsource:\s*("[^"]+"|[^\s]+)/gi],
];

const GOOGLE_OPS = OPERATORS.map((row) => row[0]);

const CAPABILITY = {
  google: GOOGLE_OPS,
  google_lite: GOOGLE_OPS,
  chrome: GOOGLE_OPS,
  bing: ['site', 'intitle', 'intext', 'inbody', 'inanchor', 'filetype', 'ip', 'contains', 'url'],
  yahoo: ['site', 'intitle', 'inurl', 'filetype'],
  duckduckgo: ['site', 'intitle', 'inurl', 'filetype'],
  duckduckgo_lite: ['site', 'intitle', 'inurl', 'filetype'],
  brave: ['site', 'intitle', 'intext', 'filetype'],
  mojeek: ['site', 'intitle', 'inurl', 'filetype'],
  startpage: ['site', 'intitle', 'inurl', 'filetype', 'intext', 'allintitle', 'allinurl'],
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
  const supported = new Set(CAPABILITY[engine] || []);
  if (engine === 'google' || engine === 'google_lite' || engine === 'chrome' || engine === 'yandex') return q.replace(/\s+/g, ' ').trim();
  for (const [key] of OPERATORS) {
    if (supported.has(key)) continue;
    const re = new RegExp(`\\b${key}:\\s*("[^"]+"|[^\\s]+)`, 'gi');
    q = q.replace(re, (_, v) => unquote(v));
  }
  q = q.replace(/\bext:\s*("[^"]+"|[^\s]+)/gi, (_, v) => unquote(v));
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

function hostMatchesSite(host, target) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/^www\./, '');
  const t = String(target || '')
    .toLowerCase()
    .replace(/^www\./, '');
  if (!h || !t) return false;
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
    const filtered = out.filter((r) => {
      try {
        const path = new URL(r.url).pathname.toLowerCase();
        const blob = `${path} ${r.url} ${r.title || ''}`.toLowerCase();
        return filetypes.some((ext) => path.endsWith(`.${ext}`) || blob.includes(`.${ext}`) || blob.includes(ext));
      } catch {
        return false;
      }
    });
    if (filtered.length) out = filtered;
  }

  const inurls = []
    .concat(dorkInfo.operators && dorkInfo.operators.inurl)
    .concat(dorkInfo.operators && dorkInfo.operators.allinurl)
    .concat(dorkInfo.operators && dorkInfo.operators.url)
    .filter(Boolean);
  if (inurls.length) {
    const filtered = out.filter((r) => {
      const u = String((r && r.url) || '').toLowerCase();
      return inurls.every((tok) => u.includes(String(tok).toLowerCase()));
    });
    if (filtered.length) out = filtered;
  }

  const titles = []
    .concat(dorkInfo.operators && dorkInfo.operators.intitle)
    .concat(dorkInfo.operators && dorkInfo.operators.allintitle)
    .concat(dorkInfo.operators && dorkInfo.operators.title)
    .filter(Boolean);
  if (titles.length) {
    const filtered = out.filter((r) => {
      const t = String((r && r.title) || '').toLowerCase();
      return titles.every((tok) => t.includes(String(tok).toLowerCase()));
    });
    if (filtered.length) out = filtered;
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
  canonicalUrl,
  dedupeResults,
  enforceDork,
  hostMatchesSite,
  CAPABILITY,
};
