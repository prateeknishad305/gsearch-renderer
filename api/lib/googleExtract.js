'use strict';

const { isGarbageUrl, isAiModeTitle } = require('./resultFilter');

const JUNK_KEY =
  /^(?:utm_[a-z0-9_]+|gclid|dclid|fbclid|yclid|msclkid|igshid|mc_cid|mc_eid|ref|ref_src|ved|usg|sa|sxsrf|ei|gs_lcp|sourceid|ie|oe)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/^https?:$/i.test(u.protocol)) return '';
    u.hash = '';
    const drop = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (JUNK_KEY.test(k)) drop.push(k);
      else if (k === 't' && UUID_RE.test(String(v))) drop.push(k);
      else if (k === 'param' && /^\d{1,6}$/.test(String(v))) drop.push(k);
    }
    for (const k of drop) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return String(url || '');
  }
}

function isGoogleHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'google.com' || h.endsWith('.google.com');
}

function unwrapGoogleHref(href) {
  let url = decodeEntities(String(href || '').trim());
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  for (let i = 0; i < 4; i++) {
    let next = '';
    try {
      const rel = url.startsWith('/url?') || url.startsWith('/goto?');
      const abs = rel ? new URL(url, 'https://www.google.com') : new URL(url);
      const path = abs.pathname || '';
      if (rel || (isGoogleHost(abs.hostname) && /^\/(?:url|goto)\/?$/i.test(path))) {
        next = abs.searchParams.get('url') || abs.searchParams.get('q') || abs.searchParams.get('u') || '';
      }
    } catch {
      break;
    }
    if (!next) break;
    try {
      next = decodeURIComponent(next);
    } catch {
      /* keep */
    }
    next = decodeEntities(next).trim();
    if (next.startsWith('//')) next = `https:${next}`;
    if (!next || next === url) break;
    url = next;
  }
  return url;
}

function decodeGoogleHref(href) {
  let url = unwrapGoogleHref(href);
  try {
    url = decodeURIComponent(url);
  } catch {
    /* keep */
  }
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const h = new URL(url).hostname;
    if (
      isGoogleHost(h) ||
      /googleusercontent\.com$|gstatic\.com$|googleadservices\.com$/i.test(h)
    ) {
      return '';
    }
  } catch {
    return '';
  }
  return cleanUrl(url);
}

function hostLooksReal(host) {
  const h = String(host || '')
    .replace(/^www\./i, '')
    .toLowerCase();
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(h) && !/\s/.test(h) && h.length < 80;
}

function indexOfPath(title) {
  const m = String(title || '').match(/^index\s+of\s+(\/[\w.~+/-]*)/i);
  if (!m) return '';
  let path = m[1].replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path;
}

function expandIndexOfUrl(url, title) {
  const path = indexOfPath(title);
  if (!url || !path) return url;
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return url;
    u.pathname = path;
    u.search = '';
    u.hash = '';
    return cleanUrl(u.toString()) || url;
  } catch {
    return url;
  }
}

function pickBestUrl(candidates) {
  let best = '';
  for (const raw of candidates || []) {
    const parts = String(raw || '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      const url = decodeGoogleHref(part);
      if (!url || skipHost(url) || isGarbageUrl(url)) continue;
      if (!best || url.length > best.length) best = url;
    }
  }
  return best;
}

function citeToUrl(cite) {
  let t = decodeEntities(stripTags(cite)).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t) && !/[›>]/.test(t)) {
    const direct = decodeGoogleHref(t) || cleanUrl(t);
    if (direct && !skipHost(direct)) return direct;
  }
  const truncated = /\.{3}|…/.test(t);
  const parts = t.split(/\s*[›>]\s*/).map((s) => s.trim()).filter((s) => s && s !== '...' && s !== '…');
  let hostPart = parts[0] || '';
  if (!hostPart) return '';
  const hostHasScheme = /^https?:\/\//i.test(hostPart);
  if (hostHasScheme && parts.length === 1) {
    const direct = decodeGoogleHref(hostPart) || cleanUrl(hostPart);
    if (direct && !skipHost(direct)) return direct;
  }
  hostPart = hostPart.replace(/^https?:\/\//i, '').split('/')[0];
  if (!hostLooksReal(hostPart)) return '';
  const pathParts = truncated ? [] : parts.slice(1).map((p) => p.replace(/^\/+/, '')).filter(Boolean);
  const path = pathParts.length ? `/${pathParts.join('/')}` : '/';
  try {
    const u = new URL(`https://${hostPart.replace(/^\/+/, '')}`);
    return cleanUrl(`${u.origin}${path}`);
  } catch {
    return '';
  }
}

function displayedFromCite(cite) {
  return decodeEntities(stripTags(cite)).replace(/\s+/g, ' ').trim();
}

function skipHost(url) {
  try {
    const h = new URL(url).hostname;
    return (
      h === 'google.com' ||
      h.endsWith('.google.com') ||
      /googleusercontent\.com$|gstatic\.com$|googleadservices\.com$/i.test(h)
    );
  } catch {
    return true;
  }
}

function extractFromHtml(html) {
  const raw = String(html || '');
  const results = [];
  const seen = new Set();
  function sitelinksFrom(html) {
    const out = [];
    const seenSl = new Set();
    const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let sm;
    while ((sm = re.exec(html || ''))) {
      const link = decodeGoogleHref(sm[1]);
      const title = decodeEntities(stripTags(sm[2]));
      if (!link || !title || seenSl.has(link)) continue;
      seenSl.add(link);
      out.push({ title, link });
    }
    return out.slice(0, 6);
  }
  function attrOf(tag, name) {
    const re = new RegExp('\\b' + name + '="([^"]+)"', 'i');
    const m = String(tag || '').match(re);
    return m ? m[1] : '';
  }
  function push(title, href, snippet, cite, date, slHtml, extraHrefs) {
    title = decodeEntities(stripTags(title));
    if (!title || title.length < 3 || title.length > 200) return;
    if (isAiModeTitle(title)) return;
    const displayedLink = displayedFromCite(cite);
    let url = pickBestUrl([href].concat(extraHrefs || []));
    if (!url && displayedLink) url = citeToUrl(displayedLink);
    url = expandIndexOfUrl(url, title) || url;
    if (!url || isGarbageUrl(url) || skipHost(url) || seen.has(url)) return;
    seen.add(url);
    const item = { title, url, snippet: decodeEntities(stripTags(snippet || '')) };
    if (displayedLink) item.displayedLink = displayedLink;
    const dt = decodeEntities(stripTags(date || ''));
    if (dt && dt.length > 2 && dt.length < 40) item.date = dt;
    const sl = sitelinksFrom(slHtml);
    if (sl.length) item.sitelinks = sl;
    results.push(item);
  }
  const blockRe =
    /<div[^>]*class="[^"]*\bg\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bg\b|$)/gi;
  let bm;
  let usedBlock = false;
  while ((bm = blockRe.exec(raw))) {
    const block = bm[1];
    const a = block.match(/<(a\b[^>]*href="([^"]+)"[^>]*)>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i)
      || block.match(/<h3[^>]*>[\s\S]*?<(a\b[^>]*href="([^"]+)"[^>]*)>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    usedBlock = true;
    const cite = ((block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i) || [])[1]) || '';
    const sn = ((block.match(/<(?:div|span)[^>]*class="[^"]*(?:VwiC3b|aCOpRe|MUxGbd|IsZvec)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i) || [])[1]) || '';
    const date = ((block.match(/<span[^>]*class="[^"]*LEwnzc[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]) || '';
    const slHtml = ((block.match(/<div class="HiHjCd">([\s\S]*?)<\/div>/i) || [])[1]) || '';
    const tag = a[1];
    push(a[3], a[2], sn, cite, date, slHtml, [
      attrOf(tag, 'ping'),
      attrOf(tag, 'data-href'),
      attrOf(tag, 'data-url'),
      attrOf(tag, 'data-lpage'),
    ]);
  }
  if (!usedBlock) {
    const re =
      /<h3[^>]*>[\s\S]*?<(a\b[^>]*href="([^"]+)"[^>]*)>([\s\S]*?)<\/a>|<(a\b[^>]*href="([^"]+)"[^>]*)>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    let m;
    while ((m = re.exec(raw))) {
      const tag = m[1] || m[4] || '';
      const href = m[2] || m[5] || '';
      const title = m[3] || m[6] || '';
      const after = raw.slice(m.index, m.index + 2200);
      const cite = ((after.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i) || [])[1]) || '';
      const sn = ((after.match(/<(?:div|span)[^>]*class="[^"]*(?:VwiC3b|aCOpRe|MUxGbd|IsZvec)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i) || [])[1]) || '';
      const date = ((after.match(/<span[^>]*class="[^"]*LEwnzc[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]) || '';
      const slHtml = ((after.match(/<div class="HiHjCd">([\s\S]*?)<\/div>/i) || [])[1]) || '';
      push(title, href, sn, cite, date, slHtml, [
        attrOf(tag, 'ping'),
        attrOf(tag, 'data-href'),
        attrOf(tag, 'data-url'),
        attrOf(tag, 'data-lpage'),
      ]);
    }
  }
  if (results.length === 0) {
    const h3re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    let m;
    while ((m = h3re.exec(raw))) {
      const after = raw.slice(m.index, m.index + 1800);
      const href = ((after.match(/href="([^"]+)"/i) || [])[1]) || '';
      const cite = ((after.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i) || [])[1]) || '';
      push(m[1], href, '', cite);
    }
  }
  return results;
}

function parseExtras(html) {
  const m = String(html || '').match(/<!--gsearch-extras:([\s\S]*?)-->/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extrasComment(extras) {
  if (!extras || typeof extras !== 'object') return '';
  try {
    return `<!--gsearch-extras:${JSON.stringify(extras)}-->`;
  } catch {
    return '';
  }
}

function itemsToHtml(items) {
  return (items || [])
    .map((i) => {
      const href = String(i.url || '').replace(/"/g, '');
      const title = String(i.title || '').replace(/</g, '');
      const sn = i.snippet
        ? `<div class="VwiC3b">${String(i.snippet).replace(/</g, '')}</div>`
        : '';
      const cite = `<cite>${String(i.displayedLink || i.url || '').replace(/</g, '')}</cite>`;
      const date = i.date ? `<span class="LEwnzc">${String(i.date).replace(/</g, '')}</span>` : '';
      const sl = Array.isArray(i.sitelinks) && i.sitelinks.length
        ? `<div class="HiHjCd">${i.sitelinks
            .map((s) => `<a href="${String(s.link || s.url || '').replace(/"/g, '')}">${String(s.title || '').replace(/</g, '')}</a>`)
            .join('')}</div>`
        : '';
      return `<div class="g"><a href="${href}"><h3>${title}</h3></a>${cite}${date}${sn}${sl}</div>`;
    })
    .join('');
}

function pagePack() {
  const VIDEO_HOST =
    /(?:^|\.)(?:youtube\.com|youtu\.be|ytimg\.com|googlevideo\.com|ggpht\.com|youtube-nocookie\.com)$/i;
  const AI_PREFIX = /^(?:ai\s+(?:mode|overview)\b|try\s+ai\s+mode\b)/i;
  const NAV = new Set([
    'ai mode',
    'ai overview',
    'ai overviews',
    'try ai mode',
    'search labs',
    'show more',
    'show all',
    'all',
    'images',
    'videos',
    'news',
    'web',
    'maps',
    'shopping',
    'more',
    'tools',
    'settings',
    'sign in',
  ]);
  const JUNK =
    /^(?:utm_[a-z0-9_]+|gclid|dclid|fbclid|yclid|msclkid|igshid|mc_cid|mc_eid|ref|ref_src|ved|usg|sa|sxsrf|ei|gs_lcp|sourceid|ie|oe)$/i;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function clean(url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/i.test(u.protocol)) return '';
      u.hash = '';
      const drop = [];
      for (const [k, v] of u.searchParams.entries()) {
        if (JUNK.test(k)) drop.push(k);
        else if (k === 't' && UUID.test(String(v))) drop.push(k);
        else if (k === 'param' && /^\d{1,6}$/.test(String(v))) drop.push(k);
      }
      for (const k of drop) u.searchParams.delete(k);
      return u.toString();
    } catch {
      return url || '';
    }
  }

  function decodeHref(href) {
    let url = String(href || '').trim().replace(/&amp;/g, '&');
    if (url.startsWith('//')) url = `https:${url}`;
    for (let i = 0; i < 4; i++) {
      let next = '';
      try {
        const rel = url.startsWith('/url?') || url.startsWith('/goto?');
        const abs = rel ? new URL(url, 'https://www.google.com') : new URL(url);
        const path = abs.pathname || '';
        const host = String(abs.hostname || '').toLowerCase();
        const google = host === 'google.com' || host.endsWith('.google.com');
        if (rel || (google && /^\/(?:url|goto)\/?$/i.test(path))) {
          next = abs.searchParams.get('url') || abs.searchParams.get('q') || abs.searchParams.get('u') || '';
        }
      } catch {
        break;
      }
      if (!next) break;
      try {
        next = decodeURIComponent(next);
      } catch {
        /* keep */
      }
      next = String(next || '').trim().replace(/&amp;/g, '&');
      if (next.startsWith('//')) next = `https:${next}`;
      if (!next || next === url) break;
      url = next;
    }
    try {
      url = decodeURIComponent(url);
    } catch {
      /* keep */
    }
    if (!/^https?:\/\//i.test(url)) return '';
    try {
      const h = new URL(url).hostname;
      if (
        h === 'google.com' ||
        h.endsWith('.google.com') ||
        /googleusercontent\.com$|gstatic\.com$|googleadservices\.com$/i.test(h) ||
        VIDEO_HOST.test(h)
      ) {
        return '';
      }
    } catch {
      return '';
    }
    return clean(url);
  }

  function hostLooksReal(host) {
    const h = String(host || '').replace(/^www\./i, '').toLowerCase();
    return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(h) && !/\s/.test(h) && h.length < 80;
  }

  function citeToUrl(cite) {
    const t = String(cite || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (/^https?:\/\//i.test(t) && !/[›>]/.test(t)) {
      const direct = decodeHref(t) || clean(t);
      if (direct) return direct;
    }
    const truncated = /\.{3}|…/.test(t);
    const parts = t.split(/\s*[›>]\s*/).map((s) => s.trim()).filter((s) => s && s !== '...' && s !== '…');
    if (!parts[0]) return '';
    if (/^https?:\/\//i.test(parts[0]) && parts.length === 1) {
      const direct = decodeHref(parts[0]) || clean(parts[0]);
      if (direct) return direct;
    }
    const host = parts[0].replace(/^https?:\/\//i, '').split('/')[0];
    if (!hostLooksReal(host)) return '';
    const path = truncated ? [] : parts.slice(1).map((p) => p.replace(/^\/+/, '')).filter(Boolean);
    try {
      const u = new URL(`https://${host}`);
      return clean(`${u.origin}${path.length ? `/${path.join('/')}` : '/'}`);
    } catch {
      return '';
    }
  }

  function expandIndexOf(url, title) {
    const m = String(title || '').match(/^index\s+of\s+(\/[\w.~+/-]*)/i);
    if (!url || !m) return url;
    try {
      const u = new URL(url);
      u.pathname = m[1].replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
      u.search = '';
      u.hash = '';
      return clean(u.toString()) || url;
    } catch {
      return url;
    }
  }

  function pickUrl(cands) {
    let best = '';
    for (const raw of cands || []) {
      String(raw || '').split(/\s+/).forEach((part) => {
        const url = decodeHref(part);
        if (url && url.length > best.length) best = url;
      });
    }
    return best;
  }

  function snippetOf(container) {
    if (!container) return '';
    const s = container.querySelector(
      'div.VwiC3b, span.aCOpRe, div.IsZvec, span.st, div[data-sncf], div[data-content-feature="1"]'
    );
    if (!s) return '';
    const t = (s.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 12 ? t.slice(0, 400) : '';
  }

  function dateOf(container) {
    if (!container) return '';
    const s = container.querySelector('span.LEwnzc, span.MUxGbd.wuQ4Ob, span.YrbPuc');
    const t = s ? (s.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return t.length > 2 && t.length < 40 ? t : '';
  }

  function sitelinksOf(container) {
    if (!container) return [];
    const out = [];
    const seen = new Set();
    container.querySelectorAll('.HiHjCd a[href], .St0YAf a[href], div.O1MEtf a[href], a.fl[href]').forEach((a) => {
      const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const url = decodeHref(a.getAttribute('href') || '');
      if (!title || title.length < 2 || !url || seen.has(url)) return;
      seen.add(url);
      out.push({ title, link: url });
    });
    return out.slice(0, 6);
  }

  const region = document.querySelector('#search, #rso, #center_col, #res, #main') || document;
  const results = [];
  const seen = new Set();
  const nodes = region.querySelectorAll('h3');
  for (const h of nodes) {
    const title = (h.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 3 || title.length > 200) continue;
    if (NAV.has(title.toLowerCase()) || AI_PREFIX.test(title)) continue;
    if (h.closest('.HiHjCd, .St0YAf, div.O1MEtf, .related-question-pair, nav, header')) continue;
    const wrap = h.closest('div.g, div.MjjYud, div[data-sokoban-container]') || h.closest('div.yuRUbf') || h.parentElement;
    const citeEl = wrap && wrap.querySelector('cite, span.qLRx3b, cite.tjvcx, span.ylcaW');
    const a =
      h.closest('a[href]') ||
      (wrap && wrap.querySelector('div.yuRUbf > a[href], a[jsname="UWckNb"], a[jsname][href], a[data-ved][href]'));
    const href = a ? a.getAttribute('href') || '' : '';
    const ping = a ? a.getAttribute('ping') || '' : '';
    const dataHref = a
      ? a.getAttribute('data-href') || a.getAttribute('data-url') || a.getAttribute('data-lpage') || ''
      : '';
    const displayedLink = citeEl ? (citeEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
    let url = pickUrl([href, ping, dataHref]);
    if (!url && displayedLink) url = citeToUrl(displayedLink);
    url = expandIndexOf(url, title) || url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const card = h.closest('div.g, div.MjjYud') || wrap;
    const item = { title, url, snippet: snippetOf(card) || snippetOf(wrap) };
    if (displayedLink) item.displayedLink = displayedLink;
    const dt = dateOf(card) || dateOf(wrap);
    if (dt) item.date = dt;
    const sl = sitelinksOf(card);
    if (sl.length) item.sitelinks = sl;
    results.push(item);
  }

  const extras = {};
  const kg = {};
  const kgTitle = document.querySelector('[data-attrid="title"] span, [data-attrid="title"], .qrShPb span');
  if (kgTitle) kg.title = (kgTitle.textContent || '').replace(/\s+/g, ' ').trim();
  const kgType = document.querySelector('[data-attrid="subtitle"] span, .wwUB2c span');
  if (kgType) kg.type = (kgType.textContent || '').replace(/\s+/g, ' ').trim();
  const kgDesc = document.querySelector('.kno-rdesc span, [data-attrid="description"] span');
  if (kgDesc) kg.description = (kgDesc.textContent || '').replace(/\s+/g, ' ').trim();
  const kgImg = document.querySelector('#rhs img[src^="http"], .kp-wholepage img[src^="http"]');
  if (kgImg && kgImg.src) kg.imageUrl = kgImg.src;
  const attributes = {};
  document.querySelectorAll('.rVusze, [data-attrid^="kc:/"], [data-attrid^="hw:/"]').forEach((el) => {
    const label = (el.querySelector('.w8qArf') || el.querySelector('.TQkS9') || {}).textContent || '';
    const val = (el.querySelector('.LrzXr') || el.querySelector('.kno-fv') || el.querySelector('.Z0LcW') || {}).textContent || '';
    const k = label.replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim();
    const v = val.replace(/\s+/g, ' ').trim();
    if (k && v && k.length < 60 && v.length < 200) attributes[k] = v;
  });
  if (Object.keys(attributes).length) kg.attributes = attributes;
  if (kg.title) extras.knowledgeGraph = kg;

  const ab =
    document.querySelector('.IZ6rdc') ||
    document.querySelector('.hgKElc') ||
    document.querySelector('[data-attrid="wa:/description"] .Z0LcW') ||
    document.querySelector('.vk_bk.doxD0d') ||
    document.querySelector('.kp-header .Z0LcW');
  if (ab) {
    const answer = (ab.textContent || '').replace(/\s+/g, ' ').trim();
    if (answer && answer.length > 2 && answer.length < 800) {
      const answerBox = { answer };
      const abTitle = document.querySelector('.kp-header [data-attrid="title"] span, .dI3qF');
      if (abTitle) answerBox.title = (abTitle.textContent || '').replace(/\s+/g, ' ').trim();
      extras.answerBox = answerBox;
    }
  }

  const paa = [];
  const paaSeen = new Set();
  document.querySelectorAll('.related-question-pair, [jsname="yEVEwb"], div.wQiwMc').forEach((el) => {
    const q = (el.getAttribute('data-q') || (el.querySelector('span') && el.querySelector('span').textContent) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!q || q.length < 8 || q.length > 180 || paaSeen.has(q.toLowerCase())) return;
    paaSeen.add(q.toLowerCase());
    paa.push({ question: q });
  });
  if (paa.length) extras.peopleAlsoAsk = paa.slice(0, 8);

  const related = [];
  const relSeen = new Set();
  document.querySelectorAll('#botstuff a[href*="/search?"], a.k8XOCe, div.s75CSd a, div.y6Uyqe a').forEach((a) => {
    if (a.closest('nav, header, [role="navigation"]')) return;
    const q = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!q || q.length < 2 || q.length > 80 || relSeen.has(q.toLowerCase())) return;
    if (NAV.has(q.toLowerCase())) return;
    relSeen.add(q.toLowerCase());
    related.push({ query: q });
  });
  if (related.length) extras.relatedSearches = related.slice(0, 12);

  const maps = [];
  document.querySelectorAll('[data-local-attribute], .VkpGBb, .rllt__link, a[href*="/maps/place"]').forEach((el) => {
    const title = ((el.querySelector('.dbg0pd, .OSrXXb, .qBF1Pd') && el.querySelector('.dbg0pd, .OSrXXb, .qBF1Pd').textContent) || el.getAttribute('aria-label') || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const href = el.getAttribute('href') || (el.querySelector('a[href]') && el.querySelector('a[href]').getAttribute('href')) || '';
    if (!title || title.length < 2 || title.length > 120) return;
    maps.push({ title, url: href || '' });
  });
  if (maps.length) extras.maps = maps.slice(0, 8);

  const shopping = [];
  document.querySelectorAll('.sh-dgr__content, .pla-unit, [data-dtld], a[href*="shopping/product"]').forEach((el) => {
    const title = ((el.querySelector('h3, .tAxDx, .pymv4e') && el.querySelector('h3, .tAxDx, .pymv4e').textContent) || '')
      .replace(/\s+/g, ' ')
      .trim();
    const price = ((el.querySelector('.a8Pemb, .T4OwTb, .e10twf') && el.querySelector('.a8Pemb, .T4OwTb, .e10twf').textContent) || '')
      .replace(/\s+/g, ' ')
      .trim();
    const href = el.getAttribute('href') || (el.querySelector('a[href]') && el.querySelector('a[href]').getAttribute('href')) || '';
    if (!title || title.length < 2) return;
    shopping.push({ title, price, url: href || '' });
  });
  if (shopping.length) extras.shopping = shopping.slice(0, 8);

  return { results, extras: Object.keys(extras).length ? extras : null };
}

function formatTbsDate(raw) {
  const s = String(raw || '').trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(4, 6)}/${s.slice(6, 8)}/${s.slice(0, 4)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${m}/${d}/${y}`;
  }
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-');
    return `${m}/01/${y}`;
  }
  if (/^\d{4}$/.test(s)) return `01/01/${s}`;
  return '';
}

function buildTbs({ tbs, before, after } = {}) {
  const given = String(tbs || '').trim();
  if (given) return given.slice(0, 120);
  const a = formatTbsDate(after);
  const b = formatTbsDate(before);
  if (!a && !b) return '';
  const parts = ['cdr:1'];
  if (a) parts.push(`cd_min:${a}`);
  if (b) parts.push(`cd_max:${b}`);
  return parts.join(',');
}

module.exports = {
  cleanUrl,
  unwrapGoogleHref,
  decodeGoogleHref,
  citeToUrl,
  extractFromHtml,
  parseExtras,
  extrasComment,
  itemsToHtml,
  pagePack,
  buildTbs,
  formatTbsDate,
};
