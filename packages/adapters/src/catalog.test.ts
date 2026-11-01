import { expect, it } from 'vitest';
import { catalogSchema, batchSchema } from '@geoatlas/adapter-core';
import { demoCatalog, transitPayload } from './index.ts';

it('records the official static source, feed version and archive fingerprint', () => {
  expect(demoCatalog.source).toMatchObject({
    url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip',
    name: 'MTA New York City Transit static GTFS',
    retrievedAt: '2026-10-29',
  });
  expect(demoCatalog.source?.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
});
it('keeps known MTA station coordinates and actual express/local stop distinctions', () => {
  const a = demoCatalog.routes.find(route => route.id === 'A')!;
  const c = demoCatalog.routes.find(route => route.id === 'C')!;
  const e = demoCatalog.routes.find(route => route.id === 'E')!;
  expect(a.coordinates[a.stops.find(stop => stop.gtfsStopId === 'A24S')!.pathIndex]).toEqual([-73.981736, 40.768296]);
  expect(a.stops.some(stop => stop.gtfsStopId === 'A25S')).toBe(false);
  expect(c.stops.some(stop => stop.gtfsStopId === 'A25S')).toBe(true);
  expect(e.coordinates[e.stops.at(-1)!.pathIndex]).toEqual([-74.009781, 40.712582]);
  expect(e.stops.at(-1)?.name).toBe('World Trade Center');
});
it('visits stations rather than intermediate geometry vertices, with valid forward and reverse reports', () => {
  for (const route of demoCatalog.routes) {
    const visited = new Set<number>();
    const cycleLength = (route.stops.length - 1) * 2;
    for (let tick = 0; tick < cycleLength; tick++) {
      const batch = batchSchema.parse(JSON.parse(transitPayload(route.id, Date.parse('2026-10-29T00:00:00Z') + tick * 6_000)));
      for (const entity of batch.entities) {
        const stop = route.stops.find(item => item.id === entity.properties.stopId)!;
        expect(stop).toBeDefined();
        expect(entity.properties.pathIndex).toBe(stop.pathIndex);
        expect([entity.longitude, entity.latitude]).toEqual(route.coordinates[stop.pathIndex]);
        expect(entity.properties.stop).toBe(stop.name);
        visited.add(stop.pathIndex);
      }
    }
    expect(visited.size).toBe(route.stops.length);
  }
});
it('rejects malformed catalog relationships at the runtime boundary', () => {
  for (const corrupt of [
    (catalog: typeof demoCatalog) => { catalog.routes[0]!.stops[0]!.pathIndex = 99999; },
    (catalog: typeof demoCatalog) => { catalog.routes[0]!.stops[1]!.pathIndex = 0; },
    (catalog: typeof demoCatalog) => { catalog.routes[0]!.stops[1]!.id = catalog.routes[0]!.stops[0]!.id; },
    (catalog: typeof demoCatalog) => { catalog.routes[1]!.id = catalog.routes[0]!.id; },
  ]) {
    const catalog = structuredClone(demoCatalog); corrupt(catalog);
    expect(() => catalogSchema.parse(catalog)).toThrow();
  }
});
