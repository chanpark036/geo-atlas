import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { LookupFunction } from 'node:net';
import { LIMITS } from '@geoatlas/adapter-core';
import type { Endpoint } from './runtime.ts';

/** Reviewed server-side registry. Adapters and environment variables cannot supply URLs. */
export const MTA_ENDPOINT = Object.freeze({
  id: 'mta-ace',
  url: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  hostname: 'api-endpoint.mta.info',
  timeoutMs: 20_000,
});

export function isPublicIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return false;
  const [a, b, c] = parts.map(Number) as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function validateAddresses(addresses: readonly string[]): void {
  if (!addresses.length || addresses.some((address) => !isPublicIpv4(address)))
    throw new Error('Unapproved network destination');
}
const publicLookup: LookupFunction = (hostname, options, callback) => {
  if (hostname !== MTA_ENDPOINT.hostname) {
    callback(new Error('Unapproved endpoint'), '', 4);
    return;
  }
  // Resolve once, validate the exact connection addresses, then hand them to TLS.
  // IPv4 only for this first reviewed source; IPv6 needs an equivalent destination policy.
  void lookup(hostname, { family: 4, all: true })
    .then((records) => {
      validateAddresses(records.map((record) => record.address));
      if (options.all) callback(null, records);
      else callback(null, records[0]!.address, 4);
    })
    .catch(() => callback(new Error('Source DNS rejected'), '', 4));
};
export function validateHeaders(status: number | undefined, headers: IncomingHttpHeaders): void {
  if (status !== 200) throw new Error('Source HTTP status rejected'); // No redirect following or error-body logging.
  const contentType = String(headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (
    ![
      'application/x-protobuf',
      'application/octet-stream',
      'application/vnd.google.protobuf',
      'application/x-google-protobuf',
    ].includes(contentType)
  )
    throw new Error('Unexpected source content type');
  const encoding = headers['content-encoding'];
  if (encoding && encoding !== 'identity') throw new Error('Compressed source response rejected');
  const length = headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > LIMITS.packetBytes))
    throw new Error('Source response too large');
}
export async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    length += chunk.byteLength;
    if (length > LIMITS.packetBytes) throw new Error('Source response too large');
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  if (!length) throw new Error('Empty source response');
  return Buffer.concat(chunks, length);
}
export function mtaEndpoint(): Endpoint {
  return {
    kind: 'poll',
    timeoutMs: MTA_ENDPOINT.timeoutMs,
    read(signal) {
      return new Promise<Uint8Array>((resolve, reject) => {
        const upstream = request(
          MTA_ENDPOINT.url,
          {
            method: 'GET',
            agent: false,
            lookup: publicLookup,
            signal,
            headers: {
              accept: 'application/x-protobuf, application/octet-stream',
              'accept-encoding': 'identity',
              'user-agent': 'GeoAtlas/0.1 (+https://github.com/chanpark036/geo-atlas)',
            },
          },
          (response) => {
            void (async () => {
              try {
                validateHeaders(response.statusCode, response.headers);
                const result = await readBoundedBody(response, signal);
                const declaredLength = response.headers['content-length'];
                if (declaredLength !== undefined && result.byteLength !== Number(declaredLength))
                  throw new Error('Truncated source response');
                resolve(result);
              } catch {
                response.destroy();
                reject(new Error('Source response rejected'));
              }
            })();
          },
        );
        upstream.setTimeout(MTA_ENDPOINT.timeoutMs, () =>
          upstream.destroy(new Error('Source timed out')),
        );
        upstream.on('error', () => reject(new Error('Source request failed')));
        upstream.end();
      });
    },
  };
}
