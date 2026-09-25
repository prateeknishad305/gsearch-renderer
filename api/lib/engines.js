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
  // Site-link cards put several <h3> under ONE block that carries a single
  // .VwiC3b. Only the first heading of such a card should take that snippet —
  // the rest are deep links without their own description. Tracking snippet
  // elements by identity (a DOM node is consumed once) handles any nesting.
  const usedSnippets = new WeakSet();

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
      if (s && !usedSnippets.has(s)) {
        snippet = (s.textContent || '').trim();
        usedSnippets.add(s);
      }
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
  function isBraveHost(url) {
    try {
      const h = new URL(url).hostname;
      return h === 'brave.com' || h.endsWith('.brave.com');
    } catch {
      return true;
    }
  }
  function cleanTitle(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const parts = t.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : t;
  }
  const results = [];
  const seen = new Set();
  document.querySelectorAll('.snippet, .result-wrapper').forEach((el) => {
    if (el.closest('.deep-links')) return;
    const a = el.querySelector('a.l1[href^="http"], .result-content a[href^="http"]:not(.deep-link):not(.thumbnail)');
    if (!a || a.closest('.deep-links') || a.classList.contains('deep-link') || a.classList.contains('thumbnail')) return;
    const url = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(url) || isBraveHost(url) || seen.has(url)) return;
    const titleEl = el.querySelector('.title, .snippet-title');
    const title = cleanTitle((titleEl && titleEl.textContent) || a.textContent || '');
    if (!title || title.length < 2) return;
    const d = el.querySelector('.snippet-description p, .snippet-description, .snippet-content p, p');
    seen.add(url);
    results.push({ title, url, snippet: d ? (d.textContent || '').trim() : '' });
  });
  return results;
}

function parseMojeek() {
  function isMojeekHost(url) {
    try {
      const h = new URL(url).hostname;
      return h === 'mojeek.com' || h.endsWith('.mojeek.com');
    } catch {
      return true;
    }
  }
  function push(results, seen, li, a) {
    const url = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(url) || isMojeekHost(url) || seen.has(url)) return;
    const titleEl = li.querySelector('h2 a, h2, a.ob, a.title, .title a');
    const title = ((titleEl && titleEl.textContent) || a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2) return;
    const s = li.querySelector('p.s, span.s, .s, p');
    seen.add(url);
    results.push({ title, url, snippet: s ? (s.textContent || '').trim() : '' });
  }
  const results = [];
  const seen = new Set();
  document.querySelectorAll('ul.results-standard > li, ul.results-standard li, li[data-url]').forEach((li) => {
    const a = li.querySelector('a.ob[href], h2 a[href], a.title[href], .title a[href]');
    if (a) push(results, seen, li, a);
  });
  if (results.length === 0) {
    document.querySelectorAll('a.ob[href^="http"]').forEach((a) => {
      const li = a.closest('li') || a.parentElement;
      if (li) push(results, seen, li, a);
    });
  }
  return results;
}

function parseStartpage() {
  function isStartpageHost(url) {
    try {
      const h = new URL(url).hostname;
      return h === 'startpage.com' || h.endsWith('.startpage.com');
    } catch {
      return true;
    }
  }
  function stripTags(s) {
    return String(s || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
  function cleanTitle(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('style, script, svg, img, noscript').forEach((n) => n.remove());
    let t = ((clone.innerText || clone.textContent || '')).replace(/\s+/g, ' ').trim();
    if (!t || t.startsWith('.css-') || t.includes('{display:') || t.includes('flex-shrink')) return '';
    return t;
  }
  const results = [];
  const seen = new Set();
  function add(url, title, snippet) {
    if (!/^https?:\/\//i.test(url) || isStartpageHost(url) || seen.has(url)) return;
    const t = stripTags(title);
    if (!t || t.length < 2 || t.startsWith('.css-')) return;
    seen.add(url);
    results.push({ title: t, url, snippet: stripTags(snippet) });
  }
  document.querySelectorAll('.w-gl__result, .result, [data-testid="result"]').forEach((el) => {
    const a = el.querySelector('a.w-gl__result-title, a.result-title, h2 a, h3 a, a[href^="http"]');
    if (!a) return;
    const title = cleanTitle(el.querySelector('h2, h3, a.w-gl__result-title, a.result-title')) || cleanTitle(a);
    const s = el.querySelector('p.w-gl__description, .result-description, p');
    add(a.getAttribute('href') || '', title, s ? s.innerText || s.textContent || '' : '');
  });
  if (results.length === 0) {
    try {
      const html = document.documentElement.innerHTML;
      const marker = 'React.createElement(UIStartpage.AppSerpWeb, {';
      const i = html.indexOf(marker);
      if (i >= 0) {
        const chunk = html.slice(i + marker.length - 1);
        const end = chunk.indexOf('}})');
        if (end > 0) {
          const obj = JSON.parse(chunk.slice(0, end + 1) + '}');
          const mainline = (((obj.render || {}).presenter || {}).regions || {}).mainline || [];
          for (const cat of mainline) {
            if (cat.display_type && cat.display_type !== 'web-google') continue;
            for (const item of cat.results || []) {
              add(item.clickUrl || item.url || '', item.title || '', item.description || '');
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return results;
}

function parseYahoo() {
  function decodeHref(href) {
    const raw = String(href || '');
    if (raw.includes('/RU=')) {
      try {
        const m = raw.match(/\/RU=([^/]+)/);
        if (m) {
          const dec = decodeURIComponent(m[1]);
          if (/^https?:\/\//i.test(dec)) return dec;
        }
      } catch {
        /* ignore */
      }
    }
    try {
      const u = new URL(raw, 'https://search.yahoo.com');
      const nested = u.searchParams.get('RU') || u.searchParams.get('u');
      if (nested && /^https?:\/\//i.test(nested)) return nested;
    } catch {
      /* ignore */
    }
    return raw;
  }
  function isYahooHost(url) {
    try {
      const h = new URL(url).hostname;
      return h === 'yahoo.com' || h.endsWith('.yahoo.com') || h.endsWith('.yimg.com');
    } catch {
      return true;
    }
  }
  const results = [];
  const seen = new Set();
  document.querySelectorAll('div.algo, li.algo, .algo-sr').forEach((block) => {
    const h3 = block.querySelector('h3');
    const a =
      (h3 && (h3.closest('a[href]') || h3.querySelector('a[href]'))) ||
      block.querySelector('.compTitle a[href], h3 a[href]');
    if (!a) return;
    const title = ((h3 && h3.textContent) || a.textContent || '').trim();
    const url = decodeHref(a.getAttribute('href') || '');
    if (!title || title.length < 2 || !/^https?:\/\//i.test(url) || isYahooHost(url) || seen.has(url)) return;
    const s = block.querySelector('.compText, div.compText');
    seen.add(url);
    results.push({ title, url, snippet: s ? (s.textContent || '').trim() : '' });
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
  function isQwantHost(url) {
    try {
      const h = new URL(url).hostname;
      return h === 'qwant.com' || h.endsWith('.qwant.com') || h.endsWith('.qwantjunior.com');
    } catch {
      return true;
    }
  }
  const NAV_EXCLUDE = new Set([
    'home', 'search', 'news', 'images', 'videos', 'maps', 'settings', 'privacy',
    'privacy policy', 'about', 'about us', 'contact', 'help', 'sign in', 'login',
    'explore', 'apps', 'terms', 'terms of service', 'legal', 'imprint', 'cookies',
    'manage cookies', 'facebook', 'twitter', 'instagram', 'youtube', 'linkedin',
    'add to chrome', 'join us', 'nous rejoindre', 'junior', 'filters', 'shopping',
  ]);
  const results = [];
  const seen = new Set();
  const cards = document.querySelectorAll('[data-testid*="web-result"], article, [class*="webResult"], [class*="WebResult"]');
  const nodes = cards.length ? cards : document.querySelectorAll('a[href^="http"]');
  nodes.forEach((el) => {
    const a = el.tagName === 'A' ? el : el.querySelector('a[href^="http"]');
    if (!a) return;
    if (a.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')) return;
    const url = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(url) || isQwantHost(url) || seen.has(url)) return;
    const titleEl = el.querySelector('h2, h3, [class*="title"]');
    const title = ((titleEl && titleEl.textContent) || a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 8 || NAV_EXCLUDE.has(title.toLowerCase())) return;
    const s = el.querySelector('p, [class*="snippet"], [class*="desc"]');
    seen.add(url);
    results.push({ title, url, snippet: s ? (s.textContent || '').trim() : '' });
  });
  return results;
}

const ENGINES = {
  google: {
    url: ({ q, num, start, hl, gl }) => {
      const p = new URLSearchParams({ q, start: String(start || 0), hl, gl });
      const n = Math.min(10, Math.max(1, Number(num) || 10));
      if (n !== 10) p.set('num', String(n));
      return `https://www.google.com/search?${p.toString()}`;
    },
    cookies: () => {
      const stamp = Date.now().toString(36);
      return [
        { name: 'CONSENT', value: `YES+cb.20210328-17-p0.en+FX+${stamp}`, domain: '.google.com', path: '/' },
        // SOCS=CAI opts out of the EU consent wall in a Google-issued format.
        { name: 'SOCS', value: 'CAI', domain: '.google.com', path: '/' },
      ];
    },
    ready: 'h3',
    scroll: 0,
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
    ready: '.snippet a.l1, .result-wrapper a.l1, .snippet a[href^="http"]',
    parse: parseBrave,
  },
  mojeek: {
    url: ({ q, start }) => {
      const p = new URLSearchParams({ q });
      if (start > 0) p.set('s', String(start));
      return `https://www.mojeek.com/search?${p.toString()}`;
    },
    cookies: ({ hl, gl }) => [
      { name: 'lb', value: String(hl || 'en').slice(0, 8), domain: '.mojeek.com', path: '/' },
      { name: 'arc', value: String(gl || 'US').toUpperCase().slice(0, 8), domain: '.mojeek.com', path: '/' },
    ],
    ready: 'ul.results-standard li a.ob, ul.results-standard li h2 a, a.ob[href^="http"]',
    parse: parseMojeek,
  },
  startpage: {
    url: ({ q, start }) => {
      const p = new URLSearchParams({ query: q });
      if (start > 0) p.set('page', String(Math.floor(start / 10) + 1));
      return `https://www.startpage.com/sp/search?${p.toString()}`;
    },
    ready: '.w-gl__result a[href^="http"], .result a[href^="http"], [data-testid="result"] a[href^="http"]',
    parse: parseStartpage,
  },
  yahoo: {
    url: ({ q, num, start }) => {
      const n = Math.min(10, Math.max(1, Number(num) || 10));
      const p = new URLSearchParams({ p: q, n: String(n) });
      if (start > 0) p.set('b', String(start + 1));
      return `https://search.yahoo.com/search?${p.toString()}`;
    },
    ready: 'div.algo, li.algo, .algo-sr, .compTitle',
    parse: parseYahoo,
  },
  duckduckgo: {
    url: ({ q, start, hl, gl }) => {
      const p = new URLSearchParams({ q, kl: gl ? `${gl}-${hl}` : 'us-en' });
      if (start > 0) p.set('s', String(start));
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
    url: ({ q, start, hl, gl }) => {
      const localeMap = { fr: 'fr_FR', de: 'de_DE', en: 'en_GB', us: 'en_GB' };
      const locale = localeMap[(hl || '').toLowerCase()] || localeMap[(gl || '').toLowerCase()] || 'fr_FR';
      const p = new URLSearchParams({ q, t: 'web', locale, safesearch: 0 });
      if (start > 0) p.set('offset', String(start));
      return `https://www.qwant.com/?${p.toString()}`;
    },
    ready: '[data-testid*="web-result"] a[href^="http"], article a[href^="http"], main a[href^="http"]',
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
    brave: '.snippet a.l1, .result-wrapper a.l1, .snippet a[href^="http"]',
     mojeek: 'ul.results-standard li a.ob, ul.results-standard li h2 a, a.ob[href^="http"]',
     startpage: '.w-gl__result a[href^="http"], .result a[href^="http"], [data-testid="result"] a[href^="http"]',
    yahoo: 'div.algo, li.algo, .algo-sr',
    duckduckgo: '#links .result',
    duckduckgo_lite: 'a.result-link',
    qwant: '[data-testid*="web-result"] a[href^="http"], article a[href^="http"]',
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
    "verifying you're not a bot",
    'drag the slider',
     'not yet available in your country',
     'temporarily unavailable',
     'http 403',
     'service unavailable',
     'service indisponible',
     'verification required',
     "i'm not a robot",
     'protected by altcha',
     'waiting for verification',
     'verifying your request',
     'something went wrong during verification',
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
     if (/^captcha$/i.test(title) || /altcha/i.test(low)) {
       return `${store} served an ALTCHA / captcha challenge.`;
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
