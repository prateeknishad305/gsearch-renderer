'use strict';

// Normalises a parsed Shodan search card into a Shodan-style host object.
// Only fields the public search page actually exposes are filled; everything
// that requires the paid Shodan API (product/version/asn/timestamp/ssl) stays
// null rather than being guessed. Raw page bodies (`http.html`) are never
// captured: they can contain secrets (API keys, tokens) and must not be
// republished by this API.

function isIp(v) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(v || '').trim());
}

function ipOf(v) {
  const m = String(v || '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : null;
}

function toShodanHost(r) {
  if (!r) return null;
  let hostname = null;
  let port = null;
  let protocol = null;
  try {
    const raw = /^https?:\/\//i.test(r.url || '') ? r.url : `http://${r.url || ''}`;
    const u = new URL(raw);
    hostname = u.hostname || null;
    protocol = u.protocol.replace(':', '') || null;
    if (u.port) port = Number(u.port);
  } catch {
    /* keep nulls */
  }

  const ports = (Array.isArray(r.ports) ? r.ports : [])
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p) && p > 0);
  if (port == null && ports.length) port = ports[0];
  if (port == null && protocol === 'https') port = 443;
  if (port == null && protocol === 'http') port = 80;

  const ip =
    (r.ip && isIp(r.ip) ? String(r.ip).trim() : null) ||
    (isIp(hostname) ? hostname : null) ||
    ipOf(r.url) ||
    ipOf(r.title);

  const hostnames = (Array.isArray(r.hostnames) ? r.hostnames : [])
    .map((h) => String(h || '').trim())
    .filter((h) => h && !isIp(h));
  if (hostname && !isIp(hostname) && !hostnames.includes(hostname)) hostnames.unshift(hostname);

  const org = r.org ? String(r.org).trim() : null;

  return {
    ip_str: ip,
    port,
    transport: 'tcp',
    product: null,
    version: null,
    vendor: null,
    hostnames,
    domains: hostnames.slice(),
    org,
    isp: org,
    asn: null,
    timestamp: null,
    ports: [],
    cpes: [],
    tags: [],
    vulns: [],
    http: {
      host: hostnames[0] || hostname || null,
      location: null,
      title: null,
      status: null,
      component: [],
    },
    ssl: null,
    // `html` is intentionally omitted (never captured).
  };
}

module.exports = { toShodanHost, isIp, ipOf };
