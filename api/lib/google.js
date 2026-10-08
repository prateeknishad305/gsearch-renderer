'use strict';

const net = require('net');
const { URL } = require('url');

function envFlag(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  return raw !== '0' && String(raw).toLowerCase() !== 'false';
}

function intEnv(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function firstInt(names, dflt) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw == null || raw === '') continue;
    const v = parseInt(raw, 10);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return dflt;
}

const TZ = {
  us: 'America/New_York', gb: 'Europe/London', uk: 'Europe/London', de: 'Europe/Berlin',
  fr: 'Europe/Paris', nl: 'Europe/Amsterdam', it: 'Europe/Rome', es: 'Europe/Madrid',
  pl: 'Europe/Warsaw', se: 'Europe/Stockholm', no: 'Europe/Oslo', dk: 'Europe/Copenhagen',
  fi: 'Europe/Helsinki', at: 'Europe/Vienna', ch: 'Europe/Zurich', be: 'Europe/Brussels',
  ie: 'Europe/Dublin', pt: 'Europe/Lisbon', cz: 'Europe/Prague', ro: 'Europe/Bucharest',
  hu: 'Europe/Budapest', gr: 'Europe/Athens', tr: 'Europe/Istanbul', ru: 'Europe/Moscow',
  in: 'Asia/Kolkata', jp: 'Asia/Tokyo', kr: 'Asia/Seoul', sg: 'Asia/Singapore',
  hk: 'Asia/Hong_Kong', cn: 'Asia/Shanghai', au: 'Australia/Sydney', nz: 'Pacific/Auckland',
  br: 'America/Sao_Paulo', mx: 'America/Mexico_City', ca: 'America/Toronto',
  ar: 'America/Argentina/Buenos_Aires', cl: 'America/Santiago', za: 'Africa/Johannesburg',
  ae: 'Asia/Dubai', il: 'Asia/Jerusalem', id: 'Asia/Jakarta', th: 'Asia/Bangkok',
  vn: 'Asia/Ho_Chi_Minh', ph: 'Asia/Manila', my: 'Asia/Kuala_Lumpur', tw: 'Asia/Taipei',
};

const LANG = {
  us: 'en', gb: 'en', uk: 'en', au: 'en', nz: 'en', ca: 'en', ie: 'en', in: 'en',
  de: 'de', at: 'de', ch: 'de', fr: 'fr', be: 'fr', nl: 'nl', it: 'it', es: 'es',
  mx: 'es', ar: 'es', cl: 'es', pl: 'pl', se: 'sv', no: 'nb', dk: 'da', fi: 'fi',
  pt: 'pt', br: 'pt', cz: 'cs', ro: 'ro', hu: 'hu', gr: 'el', tr: 'tr', ru: 'ru',
  jp: 'ja', kr: 'ko', cn: 'zh-CN', tw: 'zh-TW', hk: 'zh-TW', th: 'th', vi: 'vi',
  id: 'id', my: 'ms', ph: 'en', ae: 'ar', il: 'he', za: 'en', sg: 'en',
};

const ACCEPT = {
  en: 'en-US,en;q=0.9', de: 'de-DE,de;q=0.9,en;q=0.8', fr: 'fr-FR,fr;q=0.9,en;q=0.8',
  es: 'es-ES,es;q=0.9,en;q=0.8', it: 'it-IT,it;q=0.9,en;q=0.8', nl: 'nl-NL,nl;q=0.9,en;q=0.8',
  pt: 'pt-BR,pt;q=0.9,en;q=0.8', pl: 'pl-PL,pl;q=0.9,en;q=0.8', ja: 'ja,en;q=0.8',
  ko: 'ko-KR,ko;q=0.9,en;q=0.8', ru: 'ru-RU,ru;q=0.9,en;q=0.8', zh: 'zh-CN,zh;q=0.9,en;q=0.8',
  sv: 'sv-SE,sv;q=0.9,en;q=0.8', nb: 'nb-NO,nb;q=0.9,en;q=0.8', da: 'da-DK,da;q=0.9,en;q=0.8',
  fi: 'fi-FI,fi;q=0.9,en;q=0.8', cs: 'cs-CZ,cs;q=0.9,en;q=0.8', tr: 'tr-TR,tr;q=0.9,en;q=0.8',
  ar: 'ar,en;q=0.8', he: 'he,en;q=0.8', th: 'th-TH,th;q=0.9,en;q=0.8', vi: 'vi,en;q=0.8',
  id: 'id-ID,id;q=0.9,en;q=0.8', el: 'el,en;q=0.8', hu: 'hu-HU,hu;q=0.9,en;q=0.8',
  ro: 'ro-RO,ro;q=0.9,en;q=0.8', ms: 'ms,en;q=0.8',
};

const HOSTS = {
  us: 'www.google.com', uk: 'www.google.co.uk', gb: 'www.google.co.uk', de: 'www.google.de',
  fr: 'www.google.fr', jp: 'www.google.co.jp', in: 'www.google.co.in', au: 'www.google.com.au',
  ca: 'www.google.ca', br: 'www.google.com.br', it: 'www.google.it', es: 'www.google.es',
  nl: 'www.google.nl', pl: 'www.google.pl', ru: 'www.google.ru', kr: 'www.google.co.kr',
  mx: 'www.google.com.mx', ar: 'www.google.com.ar', tr: 'www.google.com.tr', se: 'www.google.se',
  ch: 'www.google.ch', at: 'www.google.at', be: 'www.google.be', ie: 'www.google.ie',
  nz: 'www.google.co.nz', za: 'www.google.co.za', sg: 'www.google.com.sg',
};

function countryFromProxy(proxy) {
  const s = String(proxy || '');
  const m = s.match(/country=([a-z]{2})/i) || s.match(/[?&]cc=([a-z]{2})/i);
  if (m) return m[1].toLowerCase();
  return null;
}

function normalizeGl(gl) {
  const g = String(gl || 'us').toLowerCase().slice(0, 8);
  if (g === 'uk') return 'gb';
  return g || 'us';
}

function resolveGeo({ gl, hl, proxy } = {}) {
  const fromProxy = envFlag('GOOGLE_GEO_FROM_PROXY', true) ? countryFromProxy(proxy) : null;
  const g = normalizeGl(fromProxy || gl || process.env.GOOGLE_GL || 'us');
  const mapped = LANG[g] || 'en';
  const lang = String(
    fromProxy && envFlag('GOOGLE_HL_FROM_PROXY', true) ? mapped : hl || mapped || process.env.GOOGLE_HL || 'en'
  ).slice(0, 8);
  return {
    gl: g,
    hl: lang,
    tz: TZ[g] || TZ.us,
    locale: lang.includes('-') ? lang : `${lang}-${g.toUpperCase()}`,
    acceptLanguage: ACCEPT[lang] || ACCEPT[lang.slice(0, 2)] || ACCEPT.en,
    host: envFlag('GOOGLE_NCR', true) ? 'www.google.com' : HOSTS[g] || 'www.google.com',
  };
}

function normalizeQuery(q) {
  return String(q || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, intEnv('GOOGLE_Q_MAX', 512));
}

function buildSearchUrl({ q, num, start, hl, gl, proxy, viewport }) {
  const geo = resolveGeo({ gl, hl, proxy });
  const query = normalizeQuery(q);
  const p = new URLSearchParams();
  p.set('q', query);
  p.set('hl', geo.hl);
  p.set('gl', geo.gl);
  const st = Math.max(0, Number(start) || 0);
  p.set('start', String(st));
  const n = Math.min(10, Math.max(1, Number(num) || 10));
  if (n !== 10) p.set('num', String(n));
  if (envFlag('GOOGLE_UDM', true)) p.set('udm', String(process.env.GOOGLE_UDM_VALUE || '14'));
  if (envFlag('GOOGLE_SOURCEID', true)) p.set('sourceid', 'chrome');
  if (envFlag('GOOGLE_IE', true)) {
    p.set('ie', 'UTF-8');
    p.set('oe', 'UTF-8');
  }
  if (envFlag('GOOGLE_PWS', true)) p.set('pws', '0');
  if (envFlag('GOOGLE_NFPR', true)) p.set('nfpr', '1');
  if (envFlag('GOOGLE_COMPLETE_OFF', true)) p.set('complete', '0');
  if (envFlag('GOOGLE_FILTER_OFF', true)) p.set('filter', '0');
  const safe = String(process.env.GOOGLE_SAFE || '').trim();
  if (safe) p.set('safe', safe);
  if (envFlag('GOOGLE_GBV', false)) p.set('gbv', '2');
  const vw = (viewport && viewport.width) || 1366;
  const vh = (viewport && viewport.height) || 768;
  if (envFlag('GOOGLE_VIEWPORT_QS', true)) {
    p.set('biw', String(vw));
    p.set('bih', String(vh));
  }
  if (envFlag('GOOGLE_DPR', true)) p.set('dpr', '1');
  if (envFlag('GOOGLE_SCLIENT', false)) p.set('sclient', 'gws-wiz-serp');
  return `https://${geo.host}/search?${p.toString()}`;
}

function cookiesFor({ sticky } = {}) {
  if (sticky && !envFlag('GOOGLE_FAKE_CONSENT', false)) return [];
  if (!envFlag('GOOGLE_FAKE_CONSENT', false)) {
    return [{ name: 'SOCS', value: 'CAI', domain: '.google.com', path: '/' }];
  }
  const stamp = Date.now().toString(36);
  return [
    { name: 'CONSENT', value: `YES+cb.20210328-17-p0.en+FX+${stamp}`, domain: '.google.com', path: '/' },
    { name: 'SOCS', value: 'CAI', domain: '.google.com', path: '/' },
  ];
}

function decodeHref(href) {
  let url = String(href || '').trim();
  if (!url) return '';
  if (url.startsWith('/url?') || url.startsWith('/url?')) {
    try {
      const u = new URL(url, 'https://www.google.com');
      url = u.searchParams.get('q') || u.searchParams.get('url') || url;
    } catch {
      /* keep */
    }
  }
  return url;
}

function isGoogleRel(url) {
  return /^\/(?:goto|url)\?/i.test(String(url || ''));
}

function isJunkUrl(url) {
  const u = String(url || '');
  if (!u) return true;
  if (isGoogleRel(u)) return false;
  if (/^\/(?:sorry|imgres|aclk|setprefs|search)\b/i.test(u)) return true;
  try {
    const parsed = new URL(u, 'https://www.google.com');
    const h = parsed.hostname;
    if (/webcache\.googleusercontent\.com$/i.test(h)) return true;
    if (/(?:^|\.)gstatic\.com$|(?:^|\.)googleadservices\.com$|(?:^|\.)googleusercontent\.com$/i.test(h)) return true;
    if (envFlag('GOOGLE_DROP_YOUTUBE', false) && /(?:^|\.)youtube\.com$/i.test(h)) return true;
    if (/(?:^|\.)google\.com$/i.test(h) && !/\/(?:url|goto)\?/i.test(u + parsed.pathname + parsed.search)) return true;
  } catch {
    return true;
  }
  return false;
}

function preferHttp(proxy) {
  const p = String(proxy || '');
  if (/^socks5h?:\/\//i.test(p) && envFlag('GOOGLE_PREFER_HTTP', true)) {
    return p.replace(/^socks5h?:/i, 'http:');
  }
  return p;
}

function proxyKey(proxy) {
  if (!proxy) return 'direct';
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.hostname}:${u.port || ''}`;
  } catch {
    return String(proxy).replace(/\/\/[^@/]*@/, '//***@');
  }
}

function extraHeaders(geo, chromeMajor) {
  const major = String(chromeMajor || 125);
  const out = {
    'Accept-Language': geo.acceptLanguage,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
  };
  if (envFlag('GOOGLE_CH_UA', true)) {
    out['sec-ch-ua'] = `"Chromium";v="${major}", "Not.A/Brand";v="24", "Google Chrome";v="${major}"`;
    out['sec-ch-ua-mobile'] = '?0';
    out['sec-ch-ua-platform'] = '"Windows"';
  }
  return out;
}

function viewport() {
  return { width: intEnv('GOOGLE_VW', 1366), height: intEnv('GOOGLE_VH', 768) };
}

function contextOptions({ proxy, hl, gl, chromeMajor } = {}) {
  const geo = resolveGeo({ gl, hl, proxy });
  return {
    locale: geo.locale.replace('_', '-'),
    timezoneId: geo.tz,
    viewport: viewport(),
    colorScheme: 'light',
    extraHTTPHeaders: extraHeaders(geo, chromeMajor),
    geolocation: undefined,
    hasTouch: false,
    isMobile: false,
    javaScriptEnabled: true,
    geo,
  };
}

function chromiumArgs() {
  const args = [
    '--disable-features=TranslateUI,AutomationControlled,MediaRouter',
    '--lang=en-US',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-client-side-phishing-detection',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--safebrowsing-disable-auto-update',
  ];
  return args;
}

const BLOCK_HOST =
  /(?:^|\.)(?:doubleclick\.net|googleadservices\.com|googlesyndication\.com|googletagmanager\.com|google-analytics\.com|facebook\.com|scorecardresearch\.com|adservice\.google\.com)$/i;
const BLOCK_TYPE = new Set(['image', 'media', 'font', 'imageset']);

function shouldBlockRequest(url, resourceType) {
  if (!envFlag('GOOGLE_BLOCK_ASSETS', true)) return false;
  const type = String(resourceType || '');
  if (BLOCK_TYPE.has(type)) return true;
  try {
    const h = new URL(url).hostname;
    if (BLOCK_HOST.test(h)) return true;
    if (envFlag('GOOGLE_BLOCK_FONTS', true) && /fonts\.gstatic\.com$|fonts\.googleapis\.com$/i.test(h)) return true;
  } catch {
    return false;
  }
  return false;
}

async function attachRoutes(page) {
  if (!envFlag('GOOGLE_BLOCK_ASSETS', true)) return;
  await page.route('**/*', (route) => {
    const req = route.request();
    if (shouldBlockRequest(req.url(), req.resourceType())) return route.abort();
    return route.continue();
  });
}

function navWaitUntil() {
  return envFlag('GOOGLE_NAV_COMMIT', false) ? 'commit' : 'domcontentloaded';
}

function navTimeoutMs() {
  return firstInt(['GOOGLE_NAV_MS', 'NAVIGATION_TIMEOUT'], 12000);
}

function readyTimeoutMs() {
  return firstInt(['GOOGLE_READY_MS', 'RESULT_TIMEOUT'], 8000);
}

function postReadyDelayMs(hasH3) {
  if (hasH3) return 0;
  return intEnv('GOOGLE_POST_DELAY_MS', 80);
}

function pageParallel() {
  return envFlag('GOOGLE_PAGE_PARALLEL', false);
}

function skipSocksAlt() {
  return envFlag('GOOGLE_SKIP_SOCKS', true);
}

function followGoto() {
  return envFlag('GOOGLE_FOLLOW_GOTO', true);
}

function stickyEnabled() {
  return envFlag('GOOGLE_STICKY', true);
}

function stickyLimit() {
  return Math.max(1, intEnv('GOOGLE_STICKY_N', 15));
}

function mintEnabled() {
  return envFlag('GOOGLE_MINT', false);
}

function jitterMs() {
  const max = intEnv('GOOGLE_JITTER_MS', 0);
  if (max <= 0) return 0;
  return Math.floor(Math.random() * max);
}

function probeMs() {
  return intEnv('GOOGLE_PROBE_MS', 400);
}

function probeProxy(proxy, timeoutMs) {
  const t = timeoutMs == null ? probeMs() : timeoutMs;
  if (!proxy || t <= 0) return Promise.resolve(true);
  let u;
  try {
    u = new URL(proxy);
  } catch {
    return Promise.resolve(false);
  }
  if (/^socks/i.test(u.protocol)) {
    const host = u.hostname;
    const port = Number(u.port) || 1080;
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (ok) => {
        sock.removeAllListeners();
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(t);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  }
  const host = u.hostname;
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const auth =
    u.username || u.password
      ? Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')
      : '';
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let buf = '';
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(t);
    sock.once('connect', () => {
      const hdrs = [
        'CONNECT www.google.com:443 HTTP/1.1',
        'Host: www.google.com:443',
      ];
      if (auth) hdrs.push(`Proxy-Authorization: Basic ${auth}`);
      hdrs.push('Proxy-Connection: close', '', '');
      sock.write(hdrs.join('\r\n'));
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      done(/^HTTP\/\d(?:\.\d)?\s+200\b/.test(buf.slice(0, nl)));
    });
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.once('end', () => done(/^HTTP\/\d(?:\.\d)?\s+200\b/.test(buf)));
  });
}

function isSorryUrl(url) {
  return /\/sorry\b|\/recaptcha\b|unusual.?traffic/i.test(String(url || ''));
}

function isSoftBlock({ navStatus, h3, textLen, url }) {
  if (isSorryUrl(url)) return true;
  if (navStatus === 429 || navStatus === 403) return true;
  if (!h3 && (textLen || 0) < 80) return true;
  return false;
}

async function dismissConsent(page) {
  if (!envFlag('GOOGLE_CONSENT_CLICK', true)) return false;
  const clicked = await page
    .evaluate(() => {
      const sels = [
        '#L2AGLb',
        '#W0wltc',
        'button#L2AGLb',
        'button[id="L2AGLb"]',
        'form[action*="consent"] button',
        'button[aria-label*="Accept"]',
        'button[aria-label*="accept"]',
        'button[aria-label*="Agree"]',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) {
          el.click();
          return true;
        }
      }
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      for (const b of buttons) {
        const t = ((b.textContent || b.value || '') + '').trim().toLowerCase();
        if (/^(accept all|i agree|agree|accept|akzeptieren|alle akzeptieren)$/i.test(t)) {
          b.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
  if (clicked) await page.waitForTimeout(600);
  return clicked;
}

function languageList(geo) {
  const lang = (geo && geo.acceptLanguage) || 'en-US,en;q=0.9';
  return lang.split(',').map((s) => s.split(';')[0].trim()).filter(Boolean);
}

function googleInitScript(arg) {
  const langs = (arg && arg.langs && arg.langs.length) ? arg.langs : ['en-US', 'en'];
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => langs });
  } catch {}
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  } catch {}
  try {
    window.chrome = window.chrome || { runtime: {}, app: { isInstalled: false } };
  } catch {}
}

function filterResults(results) {
  const out = [];
  const seen = new Set();
  for (const r of results || []) {
    if (!r || !(r.title || '').trim()) continue;
    const raw = String(r.url || '');
    if (isJunkUrl(raw)) continue;
    const url = isGoogleRel(raw) ? raw : decodeHref(raw);
    if (!url || seen.has(url)) continue;
    if (!isGoogleRel(url) && !/^https?:\/\//i.test(url)) continue;
    seen.add(url);
    out.push({ title: String(r.title).trim(), url, snippet: r.snippet ? String(r.snippet).trim() : '' });
  }
  return out;
}

const FIXES = [
  'udm14', 'sourceid_chrome', 'ie_utf8', 'oe_utf8', 'pws0', 'nfpr', 'complete0', 'filter0',
  'safe_env', 'gbv_opt', 'biw_bih', 'dpr1', 'sclient_opt', 'omit_num10', 'keep_start',
  'ncr_host', 'geo_from_proxy', 'gl_uk_gb', 'tz_map', 'locale_map', 'accept_language',
  'query_zwsp', 'query_spaces', 'query_trim', 'query_cap', 'https_only', 'www_host',
  'search_path', 'no_tbm', 'no_ved', 'no_amp', 'socs_cai', 'no_random_consent_sticky',
  'sticky_nid', 'sticky_limit_15', 'mint_opt', 'prefer_http', 'skip_socks_alt',
  'probe_400ms', 'per_ip_circuit', 'sorry_url', 'soft_block', 'no_engine_global',
  'one_nav_lock', 'page_parallel_off', 'jitter', 'commit_nav', 'ready_8s',
  'no_sleep_if_h3', 'block_images', 'block_media', 'block_fonts', 'block_gtm',
  'block_ads',   'allow_js', 'allow_css', 'follow_goto', 'decode_url_q', 'decode_url_url', 'keep_goto',
  'consent_click', 'domcontent_wait', 'classic_serp_retry', 'cite_parser', 'yurubf_parser',
  'drop_imgres', 'drop_aclk', 'drop_webcache', 'ch_ua', 'ch_mobile0', 'ch_platform',
  'upgrade_insecure', 'accept_html', 'viewport_1366x768', 'light_scheme', 'no_touch',
  'js_on', 'webrtc_proxy_only', 'translate_off', 'no_sync', 'no_bg_net',
  'no_component_update', 'no_default_apps', 'no_hang_monitor', 'metrics_only',
  'no_phishing', 'no_safebrowse_update', 'hw_concurrency', 'device_memory',
  'max_touch_0', 'platform_win32', 'chrome_runtime', 'webdriver_undef',
  'languages_geo', 'referer_page2', 'cache_ok', 'nav_12s', 'post_delay_80',
  'sticky_cookies_skip', 'country_plus_param', 'cc_param', 'filter_youtube_host',
  'filter_gstatic', 'filter_adsvc', '429_block', '403_block', 'empty_h3_soft',
  'hl_from_proxy',
];

module.exports = {
  envFlag,
  intEnv,
  firstInt,
  countryFromProxy,
  normalizeGl,
  resolveGeo,
  normalizeQuery,
  buildSearchUrl,
  cookiesFor,
  decodeHref,
  isJunkUrl,
  preferHttp,
  proxyKey,
  extraHeaders,
  viewport,
  contextOptions,
  chromiumArgs,
  shouldBlockRequest,
  attachRoutes,
  navWaitUntil,
  navTimeoutMs,
  readyTimeoutMs,
  postReadyDelayMs,
  pageParallel,
  skipSocksAlt,
  followGoto,
  stickyEnabled,
  stickyLimit,
  mintEnabled,
  jitterMs,
  probeMs,
  probeProxy,
  isSorryUrl,
  isSoftBlock,
  dismissConsent,
  googleInitScript,
  languageList,
  filterResults,
  FIXES,
  TZ,
  LANG,
  HOSTS,
};
