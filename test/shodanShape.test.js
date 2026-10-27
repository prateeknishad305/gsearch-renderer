'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toShodanHost, isIp } = require('../api/lib/shodanShape');

test('isIp accepts dotted quads only', () => {
  assert.equal(isIp('8.8.8.8'), true);
  assert.equal(isIp('example.com'), false);
  assert.equal(isIp(''), false);
});

test('toShodanHost builds a host object from an ip/port result', () => {
  const host = toShodanHost({
    title: '45.33.32.156',
    url: 'http://45.33.32.156:80',
    ip: '45.33.32.156',
    ports: ['80', '443'],
    hostnames: ['scanme.nmap.org'],
    org: 'Linode · Fremont',
  });
  assert.equal(host.ip_str, '45.33.32.156');
  assert.equal(host.port, 80);
  assert.equal(host.transport, 'tcp');
  assert.deepEqual(host.hostnames, ['scanme.nmap.org']);
  assert.deepEqual(host.domains, ['scanme.nmap.org']);
  assert.equal(host.org, 'Linode · Fremont');
  assert.equal(host.isp, 'Linode · Fremont');
  assert.equal(host.asn, null);
  assert.equal(host.timestamp, null);
  assert.equal(host.http.host, 'scanme.nmap.org');
  assert.equal(host.ssl, null);
});

test('toShodanHost never emits http.html', () => {
  const host = toShodanHost({ title: '1.2.3.4', url: 'https://example.test', ip: '1.2.3.4' });
  assert.equal(Object.prototype.hasOwnProperty.call(host.http, 'html'), false);
  assert.equal(JSON.stringify(host).includes('html'), false);
});

test('toShodanHost falls back to url host and default port', () => {
  const host = toShodanHost({ title: 'Example', url: 'https://example.com/path' });
  assert.equal(host.ip_str, null);
  assert.equal(host.port, 443);
  assert.deepEqual(host.hostnames, ['example.com']);
});

test('toShodanHost tolerates empty input', () => {
  assert.equal(toShodanHost(null), null);
  const host = toShodanHost({});
  assert.equal(host.ip_str, null);
  assert.equal(host.port, null);
  assert.deepEqual(host.hostnames, []);
});
