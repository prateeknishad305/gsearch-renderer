'use strict';

// Per-engine configuration for the headless browser renderer.
// Each `parse` function runs inside the page via page.evaluate() and must
// be fully self-contained (no references to module scope).

function parseGoogle() {
  function resolveUrl(href) {
    let url = href;
    if (href.startsWith('/url?q=')) {
      try {
        const u = new URL(href, 'https://www.google.com');
        url = u.searchParams.get('q') || href;
      } catch {
        /* ignore */
      }
    }
    return url;
  }
  // "/goto?url=..." links carry a signed token (no plaintext destination) and
  // resolve server-side via a 302. parseGoogle keeps them as-is and a Node-side
  // step follows the redirect to recover the real URL. "/url?q=..." links are
  // decoded immediately.
  const isGoogleRel = (href) => /^\/(?:goto|url)\?/.test(href);
  const NAV_TOKENS = new Set([
    'ai mode', 'all', 'images', 'videos', 'news', 'shopping', 'maps', 'books',
    'forums', 'more', 'tools', 'settings', 'privacy', 'sign in', 'sign out',
    'web result', 'search results', 'learn more', 'help', 'terms', 'about',
    'advertising', 'business', 'feedback', 'cookies', 'search settings',
    'how search works', 'your data in search', 'see more',
    'claim this knowledge panel', 'sign in to customize',
  ]);
  const isGoogleHost = (url) => {
    try {
      const h = new URL(url).hostname;
      return h === 'google.com' || h.endsWith('.google.com');
    } catch {
      return false;
    }
  };
  const region = document.querySelector('#search, #main, #rso') || document;
  const results = [];
  const seen = new Set();

  // Primary: heading nodes (h3 / aria-level=3), current and classic layouts.
  for (const h of region.querySelectorAll('h3, [role="heading"][aria-level="3"]')) {
    const title = (h.textContent || '').trim();
    if (!title || title.length < 3 || NAV_TOKENS.has(title.toLowerCase())) continue;
    const a = h.closest('a[href]') || (h.parentElement && h.parentElement.querySelector('a[href]'));
    if (!a) continue;
    const rawHref = a.getAttribute('href') || '';
    const url = resolveUrl(rawHref);
    if (!isGoogleRel(rawHref) && (!/^https?:\/\//i.test(url) || isGoogleHost(url))) continue;
    const key = url || rawHref;
    if (seen.has(key)) continue;
    let snippet = '';
    const container = h.closest('div.g, div[data-sncf], div[jscontroller], div[data-hveid], li') || a.parentElement;
    if (container) {
      const s = container.querySelector('div.VwiC3b, div[data-sncf], span.aCOpRe, div.MUxGbd, div[data-content-feature="1"]');
      if (s) snippet = (s.textContent || '').trim();
    }
    seen.add(key);
    results.push({ title, url, snippet });
  }

  // Fallback: layouts that render titles without h3/role=heading (new UI).
  if (results.length === 0) {
    for (const a of region.querySelectorAll('a[href]')) {
      const rawHref = a.getAttribute('href') || '';
      const url = resolveUrl(rawHref);
      if (!isGoogleRel(rawHref) && (!/^https?:\/\//i.test(url) || isGoogleHost(url))) continue;
      const key = url || rawHref;
      if (seen.has(key)) continue;
      const title = (a.textContent || '').trim();
      if (!title || title.length < 3 || title.length > 200 || NAV_TOKENS.has(title.toLowerCase())) continue;
      if (a.closest('nav, header, form, [role="navigation"], [role="banner"]')) continue;
      seen.add(key);
      results.push({ title, url, snippet: '' });
    }
  }
  return results;
}

function parseBing() {
  function decodeHref(href) {
    if (href.includes('/ck/a') && href.includes('&u=')) {
      try {
        const params = new URLSearchParams(href.slice(href.indexOf('?') + 1));
        let enc = params.get('u');
        if (enc) {
          enc = enc.replace(/^a[13]/, '');
          const dec = atob(enc.replace(/-/g, '+').replace(/_/g, '/'));
          if (/^https?:\/\//i.test(dec)) return dec;
        }
      } catch {
        /* ignore */
      }
    }
    return href;
  }
  const results = [];
  const seen = new Set();
  document.querySelectorAll('li.b_algo').forEach((li) => {
    const a = li.querySelector('h2 a');
    if (!a) return;
    const title = (a.textContent || '').trim();
    const url = decodeHref(a.getAttribute('href') || '');
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    const cap = li.querySelector('.b_caption p, p');
    const snippet = cap ? (cap.textContent || '').trim() : '';
    seen.add(url);
    results.push({ title, url, snippet });
  });
  return results;
}

function parseBrave() {
  const results = [];
  const seen = new Set();
  document.querySelectorAll('.snippet').forEach((el) => {
    const a = el.querySelector('a[href^="http"]');
    if (!a || a.closest('.deep-links') || a.classList.contains('deep-link')) return;
    const title = (a.textContent || '').trim();
    const url = a.getAttribute('href') || '';
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    const d = el.querySelector('.snippet-description p, .snippet-description, p');
    const snippet = d ? (d.textContent || '').trim() : '';
    seen.add(url);
    results.push({ title, url, snippet });
  });
  return results;
}

function parseMojeek() {
  const results = [];
  const seen = new Set();
  document.querySelectorAll('ul.results-standard li, li[data-url]').forEach((li) => {
    const a = li.querySelector('.title a, a.title, h2 a');
    if (!a) return;
    const title = (a.textContent || '').trim();
    const url = a.getAttribute('href') || '';
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    const s = li.querySelector('p.s, .s, p');
    const snippet = s ? (s.textContent || '').trim() : '';
    seen.add(url);
    results.push({ title, url, snippet });
  });
  return results;
}

function parseStartpage() {
  const results = [];
  const seen = new Set();
  document.querySelectorAll('.w-gl__result, .result').forEach((el) => {
    const a = el.querySelector('a.w-gl__result-title, a.result-title, h2 a, a[href]');
    if (!a) return;
    const title = (a.textContent || '').trim();
    const url = a.getAttribute('href') || '';
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    const s = el.querySelector('p.w-gl__description, .result-description, p');
    const snippet = s ? (s.textContent || '').trim() : '';
    seen.add(url);
    results.push({ title, url, snippet });
  });
  return results;
}

function parseYahoo() {
  function decodeHref(href) {
    if (href.includes('/RU=')) {
      try {
        const m = href.match(/\/RU=([^/]+)/);
        if (m) {
          const dec = decodeURIComponent(m[1]);
          if (/^https?:\/\//i.test(dec)) return dec;
        }
      } catch {
        /* ignore */
      }
    }
    return href;
  }
  const results = [];
  const seen = new Set();
  document.querySelectorAll('ol.reg > li.first, ol.reg li.first').forEach((li) => {
    const h3 = li.querySelector('h3, div.compTitle');
    if (!h3) return;
    const a = h3.querySelector('a[href]') || li.querySelector('a[href^="http"]');
    if (!a) return;
    const title = (a.textContent || '').trim();
    const url = decodeHref(a.getAttribute('href') || '');
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    const s = li.querySelector('.compText, div.compText, p');
    const snippet = s ? (s.textContent || '').trim() : '';
    seen.add(url);
    results.push({ title, url, snippet });
  });
  return results;
}

function parseDuckDuckGo() {
  function decodeHref(href) {
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
      if (href.startsWith('//')) return 'https:' + href;
    } catch {
      /* ignore */
    }
    return href;
  }
  const results = [];
  const seen = new Set();
  document.querySelectorAll('#links .result').forEach((el) => {
    const a = el.querySelector('a.result__a');
    if (!a) return;
    const title = (a.textContent || '').trim();
    const url = decodeHref(a.getAttribute('href') || '');
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    const s = el.querySelector('a.result__snippet');
    const snippet = s ? (s.textContent || '').trim() : '';
    seen.add(url);
    results.push({ title, url, snippet });
  });
  return results;
}

function parseDuckDuckGoLite() {
  function decodeHref(href) {
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
      if (href.startsWith('//')) return 'https:' + href;
    } catch {
      /* ignore */
    }
    return href;
  }
  const results = [];
  const seen = new Set();
  document.querySelectorAll('a.result-link').forEach((a) => {
    const title = (a.textContent || '').trim();
    const url = decodeHref(a.getAttribute('href') || '');
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    let snippet = '';
    const row = a.closest('tr');
    if (row) {
      const s = row.querySelector('td.result-snippet');
      if (s) snippet = (s.textContent || '').trim();
    }
    seen.add(url);
    results.push({ title, url, snippet });
  });
  return results;
}

function parseQwant() {
  const NAV_EXCLUDE = new Set([
    'home', 'search', 'news', 'images', 'videos', 'maps', 'settings', 'privacy',
    'about', 'contact', 'help', 'sign in', 'login', 'explore', 'apps',
  ]);
  const results = [];
  const seen = new Set();
  document.querySelectorAll('a[href]').forEach((a) => {
    const url = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    const title = (a.textContent || '').trim();
    if (!title || title.length < 3 || NAV_EXCLUDE.has(title.toLowerCase())) return;
    seen.add(url);
    results.push({ title, url, snippet: '' });
  });
  return results;
}

const ENGINES = {
  google: {
    url: ({ q, num, start, hl, gl }) =>
      `https://www.google.com/search?${new URLSearchParams({ q, num: String(num), start: String(start), hl, gl }).toString()}`,
    cookies: () => {
      const stamp = Date.now().toString(36);
      return [
        { name: 'CONSENT', value: `YES+cb.20210328-17-p0.en+FX+${stamp}`, domain: '.google.com', path: '/' },
        // SOCS=CAI opts out of the EU consent wall in a Google-issued format.
        { name: 'SOCS', value: 'CAI', domain: '.google.com', path: '/' },
      ];
    },
    ready: 'h3',
    // Google lazy-renders more results on scroll; do a scroll-and-reparse pass
    // when the first pass comes back empty.
    scroll: 2,
    parse: parseGoogle,
  },
  bing: {
    url: ({ q, num, start, gl }) => {
      const p = new URLSearchParams({ q, count: String(num) });
      if (gl) p.set('cc', gl);
      if (start > 0) p.set('first', String(start + 1));
      return `https://www.bing.com/search?${p.toString()}`;
    },
    ready: 'li.b_algo h2 a',
    parse: parseBing,
  },
  brave: {
    url: ({ q, num, start, gl }) => {
      const p = new URLSearchParams({ q, source: 'web' });
      if (gl) p.set('country', gl);
      if (start > 0) p.set('offset', String(start));
      return `https://search.brave.com/search?${p.toString()}`;
    },
    ready: '.snippet',
    parse: parseBrave,
  },
  mojeek: {
    url: ({ q }) => `https://www.mojeek.com/search?${new URLSearchParams({ q }).toString()}`,
    ready: 'ul.results-standard li',
    parse: parseMojeek,
  },
  startpage: {
    url: ({ q }) => `https://www.startpage.com/sp/search?${new URLSearchParams({ query: q }).toString()}`,
    ready: '.w-gl__result, .result',
    parse: parseStartpage,
  },
  yahoo: {
    url: ({ q, num, start }) => {
      const p = new URLSearchParams({ p: q, n: String(num) });
      if (start > 0) p.set('b', String(start + 1));
      return `https://search.yahoo.com/search?${p.toString()}`;
    },
    ready: 'div.algo, li.algo',
    parse: parseYahoo,
  },
  duckduckgo: {
    url: ({ q, hl, gl }) => {
      const p = new URLSearchParams({ q, kl: gl ? `${gl}-${hl}` : 'us-en' });
      return `https://html.duckduckgo.com/html/?${p.toString()}`;
    },
    ready: '#links .result',
    parse: parseDuckDuckGo,
  },
  duckduckgo_lite: {
    url: ({ q, start }) => {
      const p = new URLSearchParams({ q });
      if (start > 0) p.set('s', String(start));
      return `https://lite.duckduckgo.com/lite/?${p.toString()}`;
    },
    ready: 'a.result-link',
    parse: parseDuckDuckGoLite,
  },
  qwant: {
    url: ({ q, hl, gl }) => {
      const locale = `${gl || 'us'}_${hl === 'fr' ? 'FR' : hl === 'de' ? 'DE' : 'US'}`;
      return `https://www.qwant.com/?${new URLSearchParams({ q, locale, safesearch: 0 }).toString()}`;
    },
    ready: 'a[href^="http"]',
    parse: parseQwant,
  },
};

function names() {
  return Object.keys(ENGINES);
}

// Runs inside the page. Returns a short human-readable block reason, or null
// when the page looks like a real SERP (no block detected). The caller maps a
// non-null result to code BLOCKED and a null + zero results to EMPTY_RESULTS.
function detectBlock(engine) {
  const raw = (document.body ? document.body.innerText : '') || '';
  const norm = raw.replace(/\s+/g, ' ').trim();
  const low = norm.toLowerCase();
  const url = location.href;
  const title = (document.title || '').trim();

  const resultSelectors = {
    google: 'h3',
    bing: 'li.b_algo',
    brave: '.snippet',
    mojeek: 'ul.results-standard li',
    startpage: '.w-gl__result, .result',
    yahoo: 'ol.reg li.first',
    duckduckgo: '#links .result',
    duckduckgo_lite: 'a.result-link',
    qwant: 'a[href^="http"]',
  };
  const hasResults = !!document.querySelector(resultSelectors[engine] || 'html');

  const STORE_NAME = {
    google: 'Google', bing: 'Bing', brave: 'Brave', mojeek: 'Mojeek',
    startpage: 'Startpage', yahoo: 'Yahoo', duckduckgo: 'DuckDuckGo',
    duckduckgo_lite: 'DuckDuckGo', qwant: 'Qwant',
  };
  const store = STORE_NAME[engine] || engine;

  // 1) URL-level hard signals.
  if (url.includes('/sorry/')) return `${store} is showing its "unusual traffic" interstitial for this IP.`;
  if (/\/(captcha|recaptcha|challenge|sorry)\//i.test(url)) return `${store} redirected to an anti-bot challenge (${url.split('?')[0]}).`;

  // 2) Strong anti-automation phrases — decisive whenever they appear.
  const STRONG = [
    'unusual traffic',
    'automated queries',
    'access denied',
    'you do not have permission',
    '403 - forbidden',
    'enablejs',
    'prove you are human',
    'verify you are human',
    'request has been blocked',
    'went wrong during verification',
    'cannot process your search',
    'blocked your request',
  ];
  for (const phrase of STRONG) {
    if (low.includes(phrase)) return `${store} served an anti-bot block ("${phrase}").`;
  }

  // 3) Medium signals — only trusted when organic results are absent.
  if (!hasResults) {
    const MEDIUM = [
      'captcha',
      'challenge',
      'robot',
      'anomaly',
      'verification',
      'blocked',
      'consent',
      'before you continue',
      'email us',
      'persists',
      'forbidden',
    ];
    for (const phrase of MEDIUM) {
      if (low.includes(phrase)) return `${store} served a challenge/consent/block page ("${phrase}").`;
    }
    if (title.length === 0 && norm.length < 300) {
      return `${store} returned an empty or script-only page.`;
    }
  }

  return null;
}

// Follows Google "/goto?url=..." redirect links server-side to recover the real
// destination URL. /goto is a plain 302 chain, so no JS is required — but the
// browser context's own cookies/UA are used so the redirect behaves like the
// page's real click. Items whose URL is already absolute are left untouched.
async function resolveGoogleRedirects(context, results, limit = 20) {
  const pending = (Array.isArray(results) ? results : [])
    .filter((r) => r && /^\/(?:goto|url)\?/.test(r.url || ''))
    .slice(0, limit);
  if (pending.length === 0) return results;

  const resolved = new Map();
  await Promise.all(
    pending.map(async (r, i) => {
      const href = r.url;
      try {
        const resp = await context.request.get(`https://www.google.com${href}`, {
          maxRedirects: 5,
          timeout: 10000,
        });
        const finalUrl = resp.url();
        if (/^https?:\/\//i.test(finalUrl)) resolved.set(href, finalUrl);
      } catch {
        // Fall through; item dropped by caller when no URL was resolved.
      }
    })
  );

  return results
    .map((r) => {
      if (!r || !/^\/(?:goto|url)\?/.test(r.url || '')) return r;
      const real = resolved.get(r.url);
      return real ? { ...r, url: real } : null;
    })
    .filter(Boolean);
}

module.exports = { ENGINES, names, detectBlock, resolveGoogleRedirects };
