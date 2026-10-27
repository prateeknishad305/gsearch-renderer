'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  fetchHost,
  enrichShodanHosts,
  mergeInternetDb,
  parseCpe,
  _reset,
} = require('../api/lib/internetdb');

test.beforeEach(() => _reset());

test('parseCpe handles 2.3 and legacy formats', () => {
  assert.deepEqual(parseCpe('cpe:2.3:a:nginx:nginx:1.18.0:*:*:*:*:*:*:*'), {
    vendor: 'nginx',
    product: 'nginx',
    version: '1.18.0',
  });
  assert.deepEqual(parseCpe('cpe:/a:openbsd:openssh:8.9'), {
    vendor: 'openbsd',
    product: 'openssh',
    version: '8.9',
  });
  assert.equal(parseCpe(''), null);
  assert.equal(parseCpe('nonsense'), null);
});

test('mergeInternetDb fills host fields and derives product/version', () => {
  const host = { ip_str: '1.2.3.4', port: null, ports: [], hostnames: [], domains: [] };
  const merged = mergeInternetDb(host, {
    ip: '1.2.3.4',
    ports: [80, 443],
    hostnames: ['example.com', '1.2.3.4'],
    cpes: ['cpe:2.3:a:nginx:nginx:1.18.0:*:*:*:*:*:*:*'],
    tags: ['web'],
    vulns: ['CVE-2021-1234'],
  });
  assert.deepEqual(merged.ports, [80, 443]);
  assert.equal(merged.port, 80);
  assert.deepEqual(merged.hostnames, ['example.com']);
  assert.deepEqual(merged.domains, ['example.com']);
  assert.equal(merged.product, 'nginx');
  assert.equal(merged.version, '1.18.0');
  assert.equal(merged.vendor, 'nginx');
  assert.deepEqual(merged.tags, ['web']);
  assert.deepEqual(merged.vulns, ['CVE-2021-1234']);
});

test('fetchHost returns null for non-ip without calling fetch', async () => {
  let calls = 0;
  const out = await fetchHost('example.com', {
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(out, null);
  assert.equal(calls, 0);
});

test('fetchHost caches successful lookups', async () => {
  let calls = 0;
  const data = { ip: '1.2.3.4', ports: [22], hostnames: [], cpes: [], tags: [], vulns: [] };
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => data };
  };
  const a = await fetchHost('1.2.3.4', { fetchImpl });
  const b = await fetchHost('1.2.3.4', { fetchImpl });
  assert.equal(calls, 1);
  assert.deepEqual(a, data);
  assert.deepEqual(b, data);
});

test('fetchHost caches failures briefly', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false };
  };
  assert.equal(await fetchHost('1.2.3.5', { fetchImpl }), null);
  assert.equal(await fetchHost('1.2.3.5', { fetchImpl }), null);
  assert.equal(calls, 1);
});

test('enrichShodanHosts merges only real IPs', async () => {
  const results = [
    { host: { ip_str: '1.2.3.4', port: null, ports: [], hostnames: [], domains: [] } },
    { host: { ip_str: 'not-an-ip', port: null, ports: [], hostnames: [], domains: [] } },
  ];
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      ip: '1.2.3.4',
      ports: [8080],
      hostnames: ['a.example'],
      cpes: ['cpe:/a:apache:http_server:2.4.1'],
      tags: [],
      vulns: [],
    }),
  });
  await enrichShodanHosts(results, { fetchImpl });
  assert.deepEqual(results[0].host.ports, [8080]);
  assert.equal(results[0].host.product, 'http_server');
  assert.equal(results[0].host.version, '2.4.1');
  assert.deepEqual(results[1].host.ports, []);
});
