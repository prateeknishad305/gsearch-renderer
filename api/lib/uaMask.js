'use strict';

function chromeMajor(ua) {
  const m = String(ua || '').match(/(?:Chrome|Chromium|Edg)\/(\d+)/i);
  return m ? m[1] : '125';
}

function sanitizeUa(ua) {
  return String(ua || '').replace(/HeadlessChrome/gi, 'Chrome').replace(/\sHeadless\b/gi, '');
}

function uaDataPlatform(platform) {
  if (/Mac/i.test(platform)) return 'macOS';
  if (/iPhone|iPad|iPod/i.test(platform)) return 'iOS';
  if (/Android/i.test(platform) || /Linux arm/i.test(platform)) return 'Android';
  if (/Linux/i.test(platform)) return 'Linux';
  return 'Windows';
}

function profileFrom({ ua, flavorId, langs } = {}) {
  const raw = sanitizeUa(ua);
  const id = String(flavorId || 'chromium');
  const major = chromeMajor(raw);
  const firefox = /Firefox\//i.test(raw) && !/Chrome\//i.test(raw);
  const safari = /Safari\//i.test(raw) && !/Chrome\//i.test(raw) && !/Chromium\//i.test(raw);
  const edge = /Edg\//i.test(raw);
  const android = /Android/i.test(raw);
  const ios = /iPhone|iPad|iPod/i.test(raw);
  const mac = /Macintosh|Mac OS X/i.test(raw);
  const linux = /Linux/i.test(raw) && !android;
  const mobile = /\bMobile\b/i.test(raw) || android || ios;
  let platform = 'Win32';
  let platformVersion = '15.0.0';
  let oscpu = 'Windows NT 10.0; Win64; x64';
  let vendor = firefox ? '' : safari || ios ? 'Apple Computer, Inc.' : 'Google Inc.';
  if (mac) {
    platform = 'MacIntel';
    platformVersion = '14.5.0';
    oscpu = 'Intel Mac OS X 14_5';
  } else if (linux) {
    platform = 'Linux x86_64';
    platformVersion = '6.5.0';
    oscpu = 'Linux x86_64';
  } else if (android) {
    platform = 'Linux armv8l';
    platformVersion = '13.0.0';
    oscpu = 'Linux armv8l';
  } else if (ios) {
    platform = 'iPhone';
    platformVersion = '17.5.0';
    oscpu = 'iPhone';
  }
  const brands = [];
  if (!firefox && !safari) {
    if (edge) brands.push({ brand: 'Microsoft Edge', version: major });
    else if (id === 'brave') brands.push({ brand: 'Brave', version: major });
    else brands.push({ brand: 'Google Chrome', version: major });
    brands.push({ brand: 'Chromium', version: major });
    brands.push({ brand: 'Not.A/Brand', version: '24' });
  }
  return {
    ua: raw,
    major,
    flavorId: id,
    platform,
    platformVersion,
    architecture: 'x86',
    bitness: '64',
    model: '',
    mobile,
    vendor,
    appVersion: raw.replace(/^Mozilla\//, ''),
    oscpu,
    brands,
    langs: Array.isArray(langs) && langs.length ? langs : ['en-US', 'en'],
    hw: 8,
    memory: 8,
    maxTouch: mobile ? 5 : 0,
    uaDataPlatform: uaDataPlatform(platform),
  };
}

function chHeaders(profile) {
  if (!profile || !profile.brands || !profile.brands.length) return {};
  const brands = profile.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  const full = profile.brands.map((b) => `"${b.brand}";v="${b.version}.0.0.0"`).join(', ');
  return {
    'sec-ch-ua': brands,
    'sec-ch-ua-mobile': profile.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${profile.uaDataPlatform || 'Windows'}"`,
    'sec-ch-ua-platform-version': `"${profile.platformVersion || '15.0.0'}"`,
    'sec-ch-ua-arch': `"${profile.architecture || 'x86'}"`,
    'sec-ch-ua-bitness': `"${profile.bitness || '64'}"`,
    'sec-ch-ua-model': `"${profile.model || ''}"`,
    'sec-ch-ua-full-version': `"${profile.major}.0.0.0"`,
    'sec-ch-ua-full-version-list': full,
  };
}

function apply(profile) {
  if (!profile || !profile.ua) return;
  const root = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : null;
  if (!root) return;
  const nav = root.navigator;
  if (!nav) return;
  const gecko = /Firefox\//i.test(profile.ua) && !/Chrome\//i.test(profile.ua);
  const webkitOnly = /Safari\//i.test(profile.ua) && !/Chrome\//i.test(profile.ua) && !/Chromium\//i.test(profile.ua);

  const define = (obj, key, getter) => {
    if (!obj) return;
    try {
      Object.defineProperty(obj, key, { get: getter, configurable: true, enumerable: true });
    } catch {
      try {
        Object.defineProperty(obj, key, { get: getter });
      } catch {
        /* ignore */
      }
    }
  };

  const proto = root.Navigator ? root.Navigator.prototype : nav;

  try {
    define(proto, 'webdriver', () => undefined);
    define(nav, 'webdriver', () => undefined);
  } catch {
    /* ignore */
  }

  define(proto, 'userAgent', () => profile.ua);
  define(nav, 'userAgent', () => profile.ua);
  define(proto, 'appVersion', () => profile.appVersion);
  define(nav, 'appVersion', () => profile.appVersion);
  define(proto, 'vendor', () => profile.vendor);
  define(nav, 'vendor', () => profile.vendor);
  define(proto, 'platform', () => profile.platform);
  define(nav, 'platform', () => profile.platform);
  define(nav, 'language', () => (profile.langs && profile.langs[0]) || 'en-US');
  define(nav, 'languages', () => Object.freeze([].concat(profile.langs || ['en-US', 'en'])));
  define(nav, 'hardwareConcurrency', () => profile.hw || 8);
  define(nav, 'deviceMemory', () => profile.memory || 8);
  define(nav, 'maxTouchPoints', () => profile.maxTouch || 0);
  if (profile.oscpu) define(nav, 'oscpu', () => profile.oscpu);

  if (profile.brands && profile.brands.length) {
    const brands = profile.brands.map((b) => ({ brand: b.brand, version: String(b.version) }));
    const platform = profile.uaDataPlatform || 'Windows';
    const ual = {
      brands,
      mobile: !!profile.mobile,
      platform,
      getHighEntropyValues(hints) {
        const full = {
          architecture: profile.architecture || 'x86',
          bitness: profile.bitness || '64',
          model: profile.model || '',
          platformVersion: profile.platformVersion || '15.0.0',
          uaFullVersion: `${profile.major}.0.0.0`,
          fullVersionList: brands.map((b) => ({ brand: b.brand, version: `${b.version}.0.0.0` })),
          wow64: false,
          formFactors: profile.mobile ? ['Mobile'] : ['Desktop'],
        };
        const out = { brands, mobile: !!profile.mobile, platform };
        for (const h of hints || []) {
          if (h in full) out[h] = full[h];
        }
        return Promise.resolve(out);
      },
      toJSON() {
        return { brands, mobile: !!profile.mobile, platform };
      },
    };
    define(proto, 'userAgentData', () => ual);
    define(nav, 'userAgentData', () => ual);
  }

  if (!gecko && !webkitOnly) {
    try {
      const chromeObj = {
        runtime: {
          id: undefined,
          connect() {},
          sendMessage() {},
        },
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
        csi() {
          return { startE: Date.now(), onloadT: Date.now(), pageT: 100, tran: 15 };
        },
        loadTimes() {
          const t = Date.now() / 1000;
          return {
            requestTime: t,
            startLoadTime: t,
            commitLoadTime: t,
            finishDocumentLoadTime: t,
            finishLoadTime: t,
            firstPaintTime: t,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false,
            connectionInfo: 'h2',
          };
        },
      };
      root.chrome = root.chrome || chromeObj;
      root.chrome.runtime = root.chrome.runtime || chromeObj.runtime;
      root.chrome.app = root.chrome.app || chromeObj.app;
      if (!root.chrome.csi) root.chrome.csi = chromeObj.csi;
      if (!root.chrome.loadTimes) root.chrome.loadTimes = chromeObj.loadTimes;
    } catch {
      /* ignore */
    }

    try {
      if (!nav.plugins || !nav.plugins.length) {
        const mk = (name) => ({
          name,
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          length: 1,
        });
        const list = [
          mk('PDF Viewer'),
          mk('Chrome PDF Viewer'),
          mk('Chromium PDF Viewer'),
          mk('Microsoft Edge PDF Viewer'),
          mk('WebKit built-in PDF'),
        ];
        const fake = {
          0: list[0],
          1: list[1],
          2: list[2],
          3: list[3],
          4: list[4],
          length: 5,
          item(i) {
            return this[i] || null;
          },
          namedItem(n) {
            for (let i = 0; i < this.length; i++) if (this[i] && this[i].name === n) return this[i];
            return null;
          },
          refresh() {},
        };
        define(nav, 'plugins', () => fake);
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const orig = nav.permissions && nav.permissions.query;
    if (orig) {
      nav.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : orig.call(nav.permissions, p);
    }
  } catch {
    /* ignore */
  }

  try {
    const NativeWorker = root.Worker;
    if (NativeWorker && !root.__gsearchUaMaskWorker) {
      root.__gsearchUaMaskWorker = true;
      root.Worker = class extends NativeWorker {
        constructor(scriptURL, options) {
          if ((options && options.type === 'module') || /^(blob:|data:)/i.test(String(scriptURL))) {
            super(scriptURL, options);
            return;
          }
          let abs = String(scriptURL);
          try {
            abs = new URL(abs, location.href).href;
          } catch {
            /* keep */
          }
          const boot = `(${apply.toString()})(${JSON.stringify(profile)}); importScripts(${JSON.stringify(abs)});`;
          super(URL.createObjectURL(new Blob([boot], { type: 'text/javascript' })), options);
        }
      };
    }
  } catch {
    /* ignore */
  }
}

module.exports = { profileFrom, chHeaders, apply, sanitizeUa, chromeMajor, uaDataPlatform };
