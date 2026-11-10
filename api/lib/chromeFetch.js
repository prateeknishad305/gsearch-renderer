'use strict';

const { withPage } = require('./browserPool');
const g = require('./google');
const challenge = require('./challenge');
const { applyRoute } = require('./mediaBlock');

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function fetchOn() {
  return String(process.env.CHROME_FETCH || '1') !== '0';
}

function siteOf(engine) {
  return engine === 'mojeek' ? 'mojeek' : 'google';
}

function withTimeout(promise, ms, code) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const e = new Error(code || 'timeout');
      e.code = code || 'TIMEOUT';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function extractGoogle(page) {
  const { pagePack } = require('./googleExtract');
  const ms = Math.max(2000, Math.min(6000, intEnv('CHROME_EXTRACT_MS', 4000)));
  try {
    return await withTimeout(page.evaluate(pagePack), ms, 'EXTRACT_TIMEOUT');
  } catch (err) {
    if (err && err.code === 'EXTRACT_TIMEOUT') throw err;
    return { results: [], extras: null };
  }
}

async function extractMojeek(page) {
  return page
    .evaluate(() => {
      if (/^captcha$/i.test(document.title || '')) return [];
      if (document.querySelector('[class*="altcha"], script[src*="altcha"]')) return [];
      const out = [];
      const seen = new Set();
      const push = (title, href) => {
        title = String(title || '').replace(/\s+/g, ' ').trim();
        href = String(href || '').trim();
        if (!/^https?:\/\//i.test(href) || !title || title.length < 2) return;
        let host = '';
        try {
          host = new URL(href).hostname;
        } catch {
          return;
        }
        if (host === 'mojeek.com' || host.endsWith('.mojeek.com') || /altcha\.org$/i.test(host)) return;
        if (seen.has(href)) return;
        seen.add(href);
        out.push({ title, url: href });
      };
      document.querySelectorAll('ul.results-standard li').forEach((li) => {
        const a = li.querySelector('a.ob[href], h2 a[href], a.title[href]');
        if (a) push(a.textContent, a.getAttribute('href'));
      });
      return out;
    })
    .catch(() => []);
}

function itemsToHtml(site, items) {
  if (site === 'mojeek') {
    return `<ul class="results-standard">${items
      .map(
        (i) =>
          `<li><h2><a class="ob" href="${String(i.url).replace(/"/g, '')}">${String(i.title).replace(/</g, '')}</a></h2></li>`
      )
      .join('')}</ul>`;
  }
  return items
    .map((i) => `<h3>${String(i.title).replace(/</g, '')}</h3><cite>${String(i.url).replace(/</g, '')}</cite>`)
    .join('');
}

function isBlocked(site, page, html) {
  const loc = page.url() || '';
  if (challenge.detectChallenge({ url: loc, html, title: page._lastTitle })) return true;
  if (site === 'google') return /\/sorry\//i.test(loc);
  const low = String(html || '').toLowerCase();
  if (/^captcha$/i.test((page._lastTitle || ''))) return true;
  if (/<title>\s*captcha\s*<\/title>/i.test(html || '')) return true;
  if (/altcha\.js|data-altcha|protected by altcha|cf-turnstile|h-captcha|g-recaptcha/i.test(low)) return true;
  if (/503 service not available/i.test(low)) return true;
  return false;
}

async function runSearch(page, site, url, timeout) {
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'font') return route.abort();
    return applyRoute(route);
  }).catch(() => {});
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  const ready = site === 'mojeek' ? 'ul.results-standard li a.ob, ul.results-standard li h2 a' : 'h3, cite';
  await page.waitForSelector(ready, { timeout: Math.min(8000, timeout) }).catch(() => {});
  const status = (resp && resp.status()) || 0;
  const loc = page.url();
  const title = await page.title().catch(() => '');
  page._lastTitle = title;
  if (site === 'google' && /\/sorry\//i.test(loc)) {
    const e = new Error('sorry');
    e.code = 'BLOCKED';
    throw e;
  }
  if (site === 'mojeek' && (/^captcha$/i.test(title) || /altcha/i.test(title))) {
    const e = new Error('captcha');
    e.code = 'BLOCKED';
    throw e;
  }
  if (site === 'mojeek') {
    const items = await extractMojeek(page);
    if (items && items.length) {
      return { status: status || 200, html: itemsToHtml(site, items), finalUrl: loc };
    }
  } else {
    const pack = await extractGoogle(page);
    const items = (pack && pack.results) || [];
    if (items.length) {
      const { itemsToHtml: toHtml, extrasComment } = require('./googleExtract');
      return {
        status: status || 200,
        html: toHtml(items) + extrasComment(pack.extras),
        finalUrl: loc,
        extras: pack.extras || null,
        results: items,
      };
    }
  }
  let html = '';
  try {
    html = await Promise.race([
      page.content(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('content timeout')), 4000)),
    ]);
  } catch {
    html = '';
  }
  if (isBlocked(site, page, html)) {
    const e = new Error(site === 'mojeek' ? 'captcha' : 'sorry');
    e.code = 'BLOCKED';
    throw e;
  }
  return { status, html, finalUrl: loc };
}

function hasHits(html, engine) {
  if (!html) return false;
  if (siteOf(engine) === 'mojeek') {
    return /results-standard/i.test(html) && /class="ob"|<h2/i.test(html) && !/<title>\s*captcha/i.test(html);
  }
  return /<h3/i.test(html) || /<cite/i.test(html);
}

async function fetchHtml(url, { proxy, timeoutMs, engine } = {}) {
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
  const timeout = Math.max(8000, timeoutMs || intEnv('CHROME_FETCH_MS', 8000));
  const site = siteOf(engine);
  const r = await withPage(
    { proxy, google: site === 'google', hl: 'en', gl: 'us', navMs: timeout },
    async (page, context) => {
      if (site === 'google') {
        await context.addCookies(g.cookiesFor()).catch(() => {});
      } else {
        await context
          .addCookies([
            { name: 'lb', value: 'en', domain: '.mojeek.com', path: '/' },
            { name: 'arc', value: 'US', domain: '.mojeek.com', path: '/' },
          ])
          .catch(() => {});
      }
      return withTimeout(runSearch(page, site, url, timeout), timeout + 3000, 'TIMEOUT');
    }
  );
  if (r && (hasHits(r.html, engine) || (r.results && r.results.length))) return r;
  return r;
}

module.exports = { fetchHtml, fetchOn };
