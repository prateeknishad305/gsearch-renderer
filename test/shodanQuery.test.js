'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseShodanOptions,
  applyShodanOptions,
  active,
} = require('../api/lib/shodanQuery');

function row(ip, ports, vulns) {
  return {
    title: ip,
    url: `http://${ip}`,
    host: { ip_str: ip, port: ports[0] || null, ports, vulns, hostnames: [] },
  };
}

const rows = [
  row('10.0.0.3', [80], []),
  row('10.0.0.1', [80, 443, 8080], ['CVE-2024-1']),
  row('10.0.0.2', [22, 80], ['CVE-2024-1', 'CVE-2024-2']),
];

test('parseShodanOptions reads all supported params', () => {
  assert.deepEqual(
    parseShodanOptions({ min_ports: '2', has_vulns: '1', sort: 'ports', fields: 'ip_str,ports' }),
    { min_ports: 2, has_vulns: true, sort: 'ports', fields: ['ip_str', 'ports'] }
  );
  assert.deepEqual(parseShodanOptions({ min_ports: 'x', sort: 'nope' }), {});
  assert.equal(active({}), false);
  assert.equal(active({ sort: 'ip' }), true);
});

test('min_ports filters hosts below threshold', () => {
  const out = applyShodanOptions(rows, { min_ports: 2 });
  assert.deepEqual(out.map((r) => r.host.ip_str), ['10.0.0.1', '10.0.0.2']);
});

test('has_vulns keeps only hosts with vulns', () => {
  const out = applyShodanOptions(rows, { has_vulns: true });
  assert.deepEqual(out.map((r) => r.host.ip_str), ['10.0.0.1', '10.0.0.2']);
});

test('sort=ports orders by open port count desc', () => {
  const out = applyShodanOptions(rows, { sort: 'ports' });
  assert.deepEqual(out.map((r) => r.host.ports.length), [3, 2, 1]);
});

test('sort=vulns orders by vuln count desc', () => {
  const out = applyShodanOptions(rows, { sort: 'vulns' });
  assert.equal(out[0].host.ip_str, '10.0.0.2');
});

test('sort=ip orders numerically, not lexically', () => {
  const out = applyShodanOptions(rows, { sort: 'ip' });
  assert.deepEqual(out.map((r) => r.host.ip_str), ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
});

test('fields projects host down to the requested keys', () => {
  const out = applyShodanOptions(rows, { fields: ['ip_str', 'ports'] });
  assert.deepEqual(Object.keys(out[0].host).sort(), ['ip_str', 'ports']);
  assert.equal(out[0].title, '10.0.0.3');
});

test('no options returns the same results untouched', () => {
  const out = applyShodanOptions(rows, {});
  assert.equal(out, rows);
});

test('items without host survive projection but not host filters', () => {
  const mixed = [rows[0], { title: 'x', url: 'http://x' }];
  assert.equal(applyShodanOptions(mixed, { fields: ['ip_str'] }).length, 2);
  assert.equal(applyShodanOptions(mixed, { min_ports: 1 }).length, 1);
});
