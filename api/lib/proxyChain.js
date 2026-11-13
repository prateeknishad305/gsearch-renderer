'use strict';

const { normalizeProxy } = require('./proxyPool');

function splitHops(raw) {
  return String(raw || '')
    .split(/\s*(?:,|\||->|=>|;)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseChain(raw) {
  const hops = splitHops(raw)
    .map(normalizeProxy)
    .filter(Boolean);
  if (!hops.length) return null;
  return {
    hops,
    egress: hops[hops.length - 1],
    ingress: hops[0],
    length: hops.length,
  };
}

function chromiumProxy(chainOrRaw) {
  if (!chainOrRaw) return null;
  const chain = typeof chainOrRaw === 'string' ? parseChain(chainOrRaw) : chainOrRaw;
  if (!chain) return null;
  return chain.egress;
}

function describe(chain) {
  if (!chain || !chain.hops) return null;
  return {
    hops: chain.hops.length,
    egress: String(chain.egress || '').replace(/\/\/[^@/]*@/, '//***@'),
    chained: chain.hops.length > 1,
  };
}

module.exports = { parseChain, chromiumProxy, describe, splitHops };