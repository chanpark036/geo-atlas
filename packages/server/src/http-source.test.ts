import { expect, it } from 'vitest';
import { LIMITS } from '@geoatlas/adapter-core';
import {
  MTA_ENDPOINT,
  isPublicIpv4,
  validateAddresses,
  validateHeaders,
  readBoundedBody,
} from './http-source.ts';

it('keeps the approved MTA source fixed and HTTPS-only', () => {
  const url = new URL(MTA_ENDPOINT.url);
  expect(url.protocol).toBe('https:');
  expect(url.hostname).toBe('api-endpoint.mta.info');
  expect(url.pathname).toBe('/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace');
});
it.each([
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '224.0.0.1',
  '198.18.0.1',
  '192.0.2.1',
  '203.0.113.1',
  '::1',
  '::ffff:127.0.0.1',
  '1.2.3.999',
  'example.com',
])('rejects nonpublic connection addresses: %s', (address) => {
  expect(isPublicIpv4(address)).toBe(false);
  expect(() => validateAddresses([address])).toThrow();
});
it('rejects mixed public/private DNS results rather than selecting a convenient address', () => {
  expect(() => validateAddresses(['8.8.8.8', '127.0.0.1'])).toThrow();
  expect(() => validateAddresses([])).toThrow();
  expect(() => validateAddresses(['8.8.8.8', '1.1.1.1'])).not.toThrow();
});
it('rejects redirects, error responses, non-protobuf types, compression and excessive lengths', () => {
  for (const status of [301, 302, 307, 308, 401, 429, 500])
    expect(() => validateHeaders(status, { 'content-type': 'application/x-protobuf' })).toThrow();
  for (const headers of [
    { 'content-type': 'text/html' },
    { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' },
    { 'content-type': 'application/x-protobuf', 'content-length': String(LIMITS.packetBytes + 1) },
    { 'content-type': 'application/x-protobuf', 'content-length': 'garbage' },
  ])
    expect(() => validateHeaders(200, headers)).toThrow();
  expect(() =>
    validateHeaders(200, { 'content-type': 'application/x-protobuf; charset=binary' }),
  ).not.toThrow();
});
it('bounds streamed bytes even without content-length and honors abort', async () => {
  const signal = new AbortController().signal;
  async function* valid() {
    yield new Uint8Array([1, 2]);
    yield new Uint8Array([3]);
  }
  expect([...(await readBoundedBody(valid(), signal))]).toEqual([1, 2, 3]);
  async function* oversized() {
    yield new Uint8Array(LIMITS.packetBytes);
    yield new Uint8Array([1]);
  }
  await expect(readBoundedBody(oversized(), signal)).rejects.toThrow('too large');
  async function* empty() {
    /* no data */
  }
  await expect(readBoundedBody(empty(), signal)).rejects.toThrow('Empty');
  const controller = new AbortController();
  controller.abort();
  await expect(readBoundedBody(valid(), controller.signal)).rejects.toThrow();
});
