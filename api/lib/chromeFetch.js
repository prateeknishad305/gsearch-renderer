'use strict';

const { getBrowser } = require('./browserPool');
const { parseProxy } = require('./browser');
const g = require('./google');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function fetchOn() {
  return String(process.env.CHROME_FETCH || '1') !== '0';
}

function proxyKey(proxy) {
  if (!proxy) return 'direct';
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.hostname}:${u.port || ''}`;
  } catch {
    return String(proxy);
  }
}

const sessions = new Map();
const creating = new Map();

async function makeSession(proxy) {
  if (!proxy) {
    const e = new Error('no proxy');
    e.code = 'NO_PROXY';
    throw e;
  }
  const browser = await getBrowser({ disableHttp2: true });
  const opts = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366, height: 768 },
    colorScheme: 'light',
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not.A/Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
    proxy: parseProxy(proxy),
  };
  const context = await browser.newContext(opts);
  await context.addCookies(g.cookiesFor()).catch(() => {});
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });
  await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (/\/sorry\//i.test(page.url())) {
    await context.close().catch(() => {});
    const e = new Error('sorry');
    e.code = 'BLOCKED';
    throw e;
  }
  return { browser, context, page, chain: Promise.resolve() };
}

function sessionAlive(s) {
  return s && s.page && !s.page.isClosed() && s.browser && s.browser.isConnected();
}

async function dropSession(proxy) {
  const key = proxyKey(proxy);
  const s = sessions.get(key);
  sessions.delete(key);
  if (s && s.context) await s.context.close().catch(() => {});
}

async function getSession(proxy) {
  const key = proxyKey(proxy);
  const hit = sessions.get(key);
  if (sessionAlive(hit)) return hit;
  sessions.delete(key);
  if (creating.has(key)) return creating.get(key);
  const p = makeSession(proxy)
    .then((s) => {
      sessions.set(key, s);
      creating.delete(key);
      return s;
    })
    .catch((err) => {
      creating.delete(key);
      throw err;
    });
  creating.set(key, p);
  return p;
}

async function extract(page) {
  return page
    .evaluate(() => {
      const out = [];
      const seen = new Set();
      const nodes = document.querySelectorAll('h3, [role="heading"][aria-level="3"]');
      for (const h of nodes) {
        const title = (h.textContent || '').trim();
        if (!title || title.length < 3) continue;
        const wrap =
          h.closest('div.g, div.MjjYud, div.yuRUbf, div[data-sokoban-container], div[jscontroller], div[data-hveid]') ||
          h.parentElement;
        const a = h.closest('a[href]') || (wrap && wrap.querySelector('a[href]'));
        const cite = wrap && wrap.querySelector('cite');
        let url = '';
        if (cite) {
          const raw = (cite.textContent || '').split(/\s*›\s*/)[0].trim();
          if (raw) url = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
        }
        const href = a ? a.getAttribute('href') || '' : '';
        if (!url && /^https?:\/\//i.test(href) && !/google\.com/i.test(href)) url = href;
        if (!title || !url || seen.has(url)) continue;
        seen.add(url);
        out.push({ title, url });
      }
      return out;
    })
    .catch(() => []);
}

async function runSearch(s, url, timeout) {
  const resp = await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await s.page.waitForSelector('h3, cite', { timeout: Math.min(8000, timeout) }).catch(() => {});
  const status = (resp && resp.status()) || 0;
  const loc = s.page.url();
  if (/\/sorry\//i.test(loc)) {
    const e = new Error('sorry');
    e.code = 'BLOCKED';
    throw e;
  }
  const items = await extract(s.page);
  if (items && items.length) {
    const html = items
      .map((i) => `<h3>${String(i.title).replace(/</g, '')}</h3><cite>${String(i.url).replace(/</g, '')}</cite>`)
      .join('');
    return { status: status || 200, html, finalUrl: loc };
  }
  let html = '';
  try {
    html = await s.page.content();
  } catch {
    html = '';
  }
  return { status, html, finalUrl: loc };
}

async function fetchHtml(url, { proxy, timeoutMs } = {}) {
  if (!fetchOn()) {
    const e = new Error('chrome fetch off');
    e.code = 'SKIP';
    throw e;
  }
  if (!proxy) {
    const e = new Error('no proxy');
    e.code = 'NO_PROXY';
    throw e;
  }
  const timeout = Math.max(12000, timeoutMs || intEnv('CHROME_FETCH_MS', 8000));
  const attempt = async (fresh) => {
    if (fresh) await dropSession(proxy);
    const s = await getSession(proxy);
    const p = s.chain.then(
      () => runSearch(s, url, timeout),
      () => runSearch(s, url, timeout)
    );
    s.chain = p.then(
      () => {},
      () => {}
    );
    return p;
  };
  try {
    const r = await attempt(false);
    if (r && r.html && (/<h3/i.test(r.html) || /<cite/i.test(r.html))) return r;
  } catch {
    /* retry */
  }
  return attempt(true);
}

module.exports = { fetchHtml, fetchOn };
