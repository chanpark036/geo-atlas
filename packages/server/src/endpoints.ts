import { setTimeout as delay } from 'node:timers/promises';
import { demoCatalog, transitPayload, vesselPayload } from '@geoatlas/adapters';
import type { Endpoint } from './runtime.ts';

export function demoEndpoints(): ReadonlyMap<string, Endpoint> {
  const endpoints = new Map<string, Endpoint>();
  for (const route of demoCatalog.routes) endpoints.set(`demo-${route.id.toLowerCase()}`, {
    kind: 'poll', timeoutMs: 2_000, async read(signal) { signal.throwIfAborted(); return transitPayload(route.id); },
  });
  endpoints.set('demo-harbor', {
    kind: 'websocket', idleTimeoutMs: 10_000,
    async *open(signal) {
      while (!signal.aborted) {
        yield vesselPayload();
        await delay(2_000, undefined, { signal });
      }
    },
  });
  return endpoints;
}
