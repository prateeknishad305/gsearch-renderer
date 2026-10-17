'use strict';

// Query-time shaping for the shodan engine. Works on result.host objects that
// runner.js already enriched (Shodan search + InternetDB).
//
// Supported params:
//   min_ports=<n>      keep hosts with at least n open ports
//   has_vulns=1        keep hosts with at least one known vuln
//   sort=ports|vulns|ip
//   fields=a,b,c       project host down to the named fields

const SORTS = new Set(['ports', 'vulns', 'ip']);

function parseShodanOptions(query = {}) {
  const opts = {};
  const minPorts = parseInt(query.min_ports, 10);
  if (Number.isFinite(minPorts) && minPorts > 0) opts.min_ports = minPorts;
  if (query.has_vulns === '1' || query.has_vulns === 'true') opts.has_vulns = true;
  const sort = String(query.sort || '').toLowerCase();
  if (SORTS.has(sort)) opts.sort = sort;
  const fields = String(query.fields || '').trim();
  if (fields) {
    opts.fields = fields
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 32);
  }
  return opts;
}

function active(opts) {
  return !!(
    opts &&
    (opts.min_ports || opts.has_vulns || opts.sort || (opts.fields && opts.fields.length))
  );
}

function ipValue(ip) {
  const m = String(ip || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  return ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4];
}

function applyShodanOptions(results, opts) {
  if (!Array.isArray(results) || !active(opts)) return results;
  let out = results.slice();

  if (opts.min_ports) {
    out = out.filter(
      (r) => r && r.host && Array.isArray(r.host.ports) && r.host.ports.length >= opts.min_ports
    );
  }
  if (opts.has_vulns) {
    out = out.filter(
      (r) => r && r.host && Array.isArray(r.host.vulns) && r.host.vulns.length > 0
    );
  }

  if (opts.sort === 'ports') {
    out.sort((a, b) => (b.host.ports?.length || 0) - (a.host.ports?.length || 0));
  } else if (opts.sort === 'vulns') {
    out.sort((a, b) => (b.host.vulns?.length || 0) - (a.host.vulns?.length || 0));
  } else if (opts.sort === 'ip') {
    out.sort((a, b) => {
      const x = ipValue(a.host?.ip_str);
      const y = ipValue(b.host?.ip_str);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return x - y;
    });
  }

  if (opts.fields && opts.fields.length) {
    out = out.map((r) => {
      if (!r || !r.host) return r;
      const host = {};
      for (const key of opts.fields) {
        if (Object.prototype.hasOwnProperty.call(r.host, key)) host[key] = r.host[key];
      }
      return { ...r, host };
    });
  }
  return out;
}

module.exports = { parseShodanOptions, applyShodanOptions, active, SORTS };
