'use strict';

const fs = require('fs');

const NAMES = ['chromium', 'firefox', 'edge', 'safari', 'brave', 'tor'];

const ALIAS = {
  chrome: 'chromium',
  'google-chrome': 'chromium',
  msedge: 'edge',
  'microsoft-edge': 'edge',
  webkit: 'safari',
  torbrowser: 'tor',
  'tor-browser': 'tor',
};

const BINARIES = {
  chromium: [
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ],
  firefox: [
    process.env.FIREFOX_PATH,
    process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH,
    '/usr/bin/firefox',
    '/usr/bin/firefox-esr',
    '/usr/lib/firefox/firefox',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
  ],
  edge: [
    process.env.EDGE_PATH,
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/microsoft-edge-beta',
    '/opt/microsoft/msedge/msedge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  safari: [
    process.env.WEBKIT_PATH,
    process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH,
    '/usr/bin/webkit',
  ],
  brave: [
    process.env.BRAVE_PATH,
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/opt/brave.com/brave/brave',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  tor: [
    process.env.TOR_BROWSER_PATH,
    '/usr/bin/tor-browser',
    '/usr/bin/torbrowser',
    '/opt/tor-browser/Browser/firefox',
  ],
};

function existingPath(p) {
  if (!p) return null;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch {
    try {
      fs.accessSync(p, fs.constants.F_OK);
      return p;
    } catch {
      return null;
    }
  }
}

function findBinary(id) {
  for (const candidate of BINARIES[id] || []) {
    const hit = existingPath(candidate);
    if (hit) return hit;
  }
  return null;
}

function normalizeFlavor(name) {
  const raw = String(name == null || name === '' ? process.env.BROWSER || 'chromium' : name)
    .toLowerCase()
    .trim();
  const id = ALIAS[raw] || raw;
  return NAMES.includes(id) ? id : 'chromium';
}

function uaFor(id, major) {
  const m = String(major || 125);
  if (id === 'firefox') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0`;
  }
  if (id === 'safari') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  }
  if (id === 'tor') {
    return 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';
  }
  if (id === 'edge') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36 Edg/${m}.0.0.0`;
  }
  if (id === 'brave') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36`;
}

function chUa(id, major) {
  const m = String(major || 125);
  if (id === 'edge') return `"Microsoft Edge";v="${m}", "Chromium";v="${m}", "Not.A/Brand";v="24"`;
  if (id === 'brave') return `"Brave";v="${m}", "Chromium";v="${m}", "Not.A/Brand";v="24"`;
  if (id === 'firefox' || id === 'safari' || id === 'tor') return null;
  return `"Google Chrome";v="${m}", "Chromium";v="${m}", "Not.A/Brand";v="24"`;
}

function engineFor(id, native) {
  if (native && (id === 'firefox' || id === 'tor')) return 'firefox';
  if (native && id === 'safari') return 'webkit';
  return 'chromium';
}

function resolveFlavor(name) {
  const id = normalizeFlavor(name);
  const bin = findBinary(id);
  const gecko = id === 'firefox' || id === 'tor';
  const webkit = id === 'safari';
  const native = !!(bin && (gecko || webkit || id === 'edge' || id === 'brave' || id === 'chromium'));
  const useNativeGecko = !!(bin && gecko);
  const useNativeWebkit = !!(bin && webkit);
  const engine = engineFor(id, useNativeGecko || useNativeWebkit);
  return {
    id,
    engine,
    executablePath: bin,
    native: useNativeGecko || useNativeWebkit || (id === 'edge' && !!bin) || (id === 'brave' && !!bin),
    fallback: engine === 'chromium' && (gecko || webkit || (id !== 'chromium' && !bin)),
    ua: uaFor(id, 125),
    chUa: chUa(id, 125),
  };
}

function listFlavors() {
  return NAMES.map((id) => {
    const spec = resolveFlavor(id);
    return {
      name: id,
      engine: spec.engine,
      binary: spec.executablePath || null,
      native: !!spec.native,
      fallback: !!spec.fallback,
    };
  });
}

module.exports = {
  NAMES,
  ALIAS,
  normalizeFlavor,
  resolveFlavor,
  findBinary,
  uaFor,
  chUa,
  listFlavors,
};
