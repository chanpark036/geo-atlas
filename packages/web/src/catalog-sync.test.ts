import { afterEach, expect, it, vi } from 'vitest';
import type { Catalog, TrackedEntity } from '@geoatlas/adapter-core';
import { CatalogSynchronizer, loadCatalogForEpoch, type CatalogSyncStatus } from './catalog-sync';
import { entityColor, routeFeatures } from './layers';
import type { LiveUpdate } from './live';

const oldEpoch = 'f7df76ee-67b7-4d48-b946-8e5e26ad8eb7';
const newEpoch = '4b4ac241-ea0e-4129-9318-3c5aa1fe7c1c';
const catalog = (...ids: string[]): Catalog => ({
  routes: ids.map((id) => ({
    id,
    name: id,
    color: id === '1' ? '#d82233' : '#0062cf',
    coordinates: [
      [-74, 40.7],
      [-73.9, 40.8],
    ],
    stops: [],
  })),
});
const train = (route: string, id = route): TrackedEntity => ({
  id,
  key: `mta-subway|ace|citywide|${id}`,
  adapterId: 'mta-subway',
  inputId: 'ace',
  scope: 'citywide',
  layer: 'subway',
  longitude: -74,
  latitude: 40.7,
  observedAt: '2026-11-01T22:00:00Z',
  receivedAt: '2026-11-01T22:00:01Z',
  stale: false,
  missingSnapshots: 0,
  properties: { route, source: 'mta' },
});
const update = (epoch: string, entities: TrackedEntity[], snapshot = true): LiveUpdate => ({
  epoch,
  entities,
  snapshot,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const instances: CatalogSynchronizer[] = [];
function create(load: ConstructorParameters<typeof CatalogSynchronizer>[0]) {
  const applied: Parameters<ConstructorParameters<typeof CatalogSynchronizer>[1]>[0][] = [];
  const statuses: CatalogSyncStatus[] = [];
  const sync = new CatalogSynchronizer(
    load,
    (state) => applied.push(state),
    (state) => statuses.push(state),
  );
  instances.push(sync);
  return { sync, applied, statuses };
}
async function settle() {
  for (let count = 0; count < 6; count++) await Promise.resolve();
}
afterEach(() => {
  instances.splice(0).forEach((sync) => sync.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('replaces an A/C/E-only catalog with citywide geometry before publishing new train reports', async () => {
  const first = deferred<Catalog>(),
    second = deferred<Catalog>();
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { sync, applied } = create(load);
  sync.accept(update(oldEpoch, [train('A')]));
  first.resolve(catalog('A', 'C', 'E'));
  await settle();
  expect(applied).toHaveLength(1);
  sync.accept(update(newEpoch, [train('1')]));
  sync.accept(update(newEpoch, [train('1'), train('2')], false));
  expect(applied).toHaveLength(1); // Keep the last synchronized view while the new catalog loads.
  second.resolve(catalog('1', '2', 'A', 'C', 'E'));
  await settle();
  const result = applied.at(-1)!;
  expect(result.entities.map((entity) => entity.properties.route)).toEqual(['1', '2']);
  expect(result.reset).toBe(true);
  expect(
    routeFeatures(
      result.catalog,
      result.catalog.routes.map((route) => route.id),
    ).features,
  ).toHaveLength(5);
  expect(entityColor(result.entities[0]!, result.catalog)).toBe('#d82233');
  expect(load.mock.calls.map((call) => call[0])).toEqual([oldEpoch, newEpoch]);
});
it('refreshes on every full reconnect snapshot but preserves an unchanged catalog reference', async () => {
  const geometry = catalog('A');
  const load = vi.fn(async () => structuredClone(geometry));
  const { sync, applied } = create(load);
  sync.accept(update(oldEpoch, [train('A')]));
  await settle();
  const first = applied[0]!.catalog;
  sync.accept(update(oldEpoch, [train('A', 'new-report')], false));
  expect(load).toHaveBeenCalledTimes(1);
  expect(applied.at(-1)?.reset).toBe(false);
  sync.accept(update(oldEpoch, [train('A')]));
  await settle();
  expect(load).toHaveBeenCalledTimes(2);
  expect(applied.at(-1)?.catalog).toBe(first);
  expect(applied.at(-1)?.reset).toBe(true);
});
it('discards late catalog responses from a superseded server epoch even if abort is ignored', async () => {
  const old = deferred<Catalog>(),
    latest = deferred<Catalog>();
  const { sync, applied } = create(
    vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise),
  );
  sync.accept(update(oldEpoch, [train('A')]));
  sync.accept(update(newEpoch, [train('1')]));
  latest.resolve(catalog('1'));
  await settle();
  old.resolve(catalog('A'));
  await settle();
  expect(applied).toHaveLength(1);
  expect(applied[0]?.catalog.routes[0]?.id).toBe('1');
});
it('retries a failed refresh without publishing new reports against old routes', async () => {
  vi.useFakeTimers();
  const pending = deferred<Catalog>();
  const load = vi
    .fn()
    .mockResolvedValueOnce(catalog('A'))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(catalog('1', '2'));
  const { sync, applied, statuses } = create(load);
  sync.accept(update(oldEpoch, [train('A')]));
  await settle();
  sync.accept(update(newEpoch, [train('1')]));
  pending.reject(new Error('offline'));
  await settle();
  sync.accept(update(newEpoch, [train('1'), train('2')], false));
  expect(applied).toHaveLength(1);
  expect(statuses.at(-1)).toBe('retrying');
  await vi.advanceTimersByTimeAsync(500);
  expect(applied.at(-1)?.entities).toHaveLength(2);
  expect(statuses.at(-1)).toBe('ready');
});
it('does not publish after disposal or accept changes before a full snapshot', async () => {
  const pending = deferred<Catalog>();
  const { sync, applied } = create(() => pending.promise);
  expect(() => sync.accept(update(oldEpoch, [train('A')], false))).toThrow();
  sync.accept(update(oldEpoch, [train('A')]));
  sync.dispose();
  pending.resolve(catalog('A'));
  await settle();
  expect(applied).toEqual([]);
});
it('bypasses HTTP caches and refuses geometry from a different stream epoch', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify(catalog('A')), { headers: { 'X-GeoAtlas-Epoch': oldEpoch } }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify(catalog('1')), { headers: { 'X-GeoAtlas-Epoch': newEpoch } }),
    );
  vi.stubGlobal('fetch', fetchMock);
  const signal = new AbortController().signal;
  await expect(loadCatalogForEpoch(newEpoch, signal)).rejects.toThrow('does not match');
  expect((await loadCatalogForEpoch(newEpoch, signal)).routes[0]?.id).toBe('1');
  expect(fetchMock.mock.calls[0]?.[1].cache).toBe('no-store');
});
