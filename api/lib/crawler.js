'use strict';

const { withBrowser, newContext } = require('./browserPool');
const { getShardPool, intEnv } = require('./proxyPool');

const MAX_PAGES = 20;
const MAX_DEPTH = 3;
const NAV_TIMEOUT_MS = 20000;

function isPrivateHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (h === 'metadata.google.internal' || h === 'metadata.google') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  const m4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m4) return false;
  const a0 = Number(m4[1]);
  const a1 = Number(m4[2]);
  if (a0 === 10 || a0 === 127 || a0 === 0) return true;
  if (a0 === 169 && a1 === 254) return true;
  if (a0 === 192 && a1 === 168) return true;
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return true;
  if (a0 === 100 && a1 >= 64 && a1 <= 127) return true;
  return false;
}

function normalizeUrl(raw, base) {
  try {
    const u = new URL(String(raw || ''), base);
    if (!/^https?:$/i.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.hostname.toLowerCase() === ub.hostname.toLowerCase();
  } catch {
    return false;
  }
}

function isAllowedUrl(raw, origin, sameOriginOnly) {
  const url = normalizeUrl(raw);
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (isPrivateHostname(host)) return null;
  if (sameOriginOnly && origin && !sameOrigin(url, origin)) return null;
  return url;
}

function pickProxy(explicit) {
  if (explicit) return explicit;
  try {
    const { getLivePool, refreshLivePool } = require('./proxyFetch');
    if (!getLivePool().length) refreshLivePool().catch(() => {});
  } catch {
    /* ignore */
  }
  const pool = getShardPool();
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function renderPage(page, url) {
  let status = 0;
  let navError = null;
  await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    .then((resp) => {
      status = (resp && resp.status()) || 0;
    })
    .catch((err) => {
      navError = err;
    });
  if (!navError) await page.waitForTimeout(400);
  const data = await page
    .evaluate(() => {
      const title = (document.title || '').trim();
      const descEl = document.querySelector('meta[name="description"], meta[property="og:description"]');
      const description = descEl ? (descEl.getAttribute('content') || '').trim() : '';
      const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      const links = [];
      const seen = new Set();
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return;
        let abs = href;
        try {
          abs = new URL(href, location.href).toString();
        } catch {
          return;
        }
        if (seen.has(abs)) return;
        seen.add(abs);
        links.push({ url: abs, text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) });
      });
      return { title, description, text, links, href: location.href };
    })
    .catch(() => ({ title: '', description: '', text: '', links: [], href: url }));
  return {
    url,
    final_url: data.href || url,
    status,
    title: data.title || '',
    description: data.description || '',
    text: data.text || '',
    links: Array.isArray(data.links) ? data.links : [],
    error: navError ? navError.message.split('\n')[0] : null,
  };
}

async function crawl(opts) {
  const url = opts && opts.url;
  const maxPages = (opts && opts.maxPages) || 8;
  const maxDepth = (opts && opts.maxDepth) || 1;
  const sameOriginOnly = opts && opts.sameOriginOnly === false ? false : true;
  const proxy = opts && opts.proxy;
  const start = normalizeUrl(url);
  if (!start) {
    const e = new Error('Invalid start URL (http/https only)');
    e.code = 'INVALID_URL';
    throw e;
  }
  if (!isAllowedUrl(start, start, false)) {
    const e = new Error('Start URL is blocked (private/local host)');
    e.code = 'BLOCKED_URL';
    throw e;
  }

  const pagesCap = Math.min(MAX_PAGES, Math.max(1, maxPages));
  const depthCap = Math.min(MAX_DEPTH, Math.max(0, maxDepth));
  const chosenProxy = pickProxy(proxy);
  const deadline = Date.now() + intEnv('CRAWL_BUDGET_MS', 50000);
  const seen = new Set([start]);
  const queue = [{ url: start, depth: 0 }];
  const pages = [];

  await withBrowser({ proxy: chosenProxy }, async (browser) => {
    const context = await newContext(browser, { proxy: chosenProxy });
    try {
      while (queue.length && pages.length < pagesCap) {
        if (Date.now() > deadline) break;
        const item = queue.shift();
        const page = await context.newPage();
        page.setDefaultTimeout(NAV_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
        let rendered;
        try {
          rendered = await renderPage(page, item.url);
        } finally {
          await page.close().catch(() => {});
        }
        const allowedLinks = [];
        for (const link of rendered.links) {
          const allowed = isAllowedUrl(link.url, start, sameOriginOnly);
          if (!allowed) continue;
          allowedLinks.push({ url: allowed, text: link.text || '' });
          if (item.depth < depthCap && pages.length + queue.length < pagesCap && !seen.has(allowed)) {
            seen.add(allowed);
            queue.push({ url: allowed, depth: item.depth + 1 });
          }
        }
        pages.push({
          url: rendered.url,
          final_url: rendered.final_url,
          depth: item.depth,
          status: rendered.status,
          title: rendered.title,
          description: rendered.description,
          text: rendered.text,
          links: allowedLinks.slice(0, 100),
          error: rendered.error,
        });
      }
    } finally {
      await context.close().catch(() => {});
    }
  });

  return {
    start_url: start,
    pages,
    crawled: pages.length,
    queued: queue.length,
    proxy: chosenProxy,
  };
}

module.exports = {
  crawl,
  normalizeUrl,
  isAllowedUrl,
  isPrivateHostname,
  sameOrigin,
  MAX_PAGES,
  MAX_DEPTH,
};
