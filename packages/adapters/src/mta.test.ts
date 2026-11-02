import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import bindings from 'gtfs-realtime-bindings';
import { StateManager, type SourcePacket } from '@geoatlas/adapter-core';
import { createMtaAdapter } from './mta.ts';
import { demoCatalog } from './index.ts';
const { FeedMessage } = bindings.transit_realtime;
type Feed = bindings.transit_realtime.IFeedMessage;
type Vehicle = bindings.transit_realtime.IVehiclePosition;
const seconds = Date.parse('2026-11-01T17:00:00Z') / 1000;
const vehicle = (patch: Partial<Vehicle> = {}): Vehicle => ({
  trip: { tripId: '090000_A..S58R', routeId: 'A', startDate: '20261101' },
  stopId: 'A24S',
  currentStopSequence: 1,
  currentStatus: 1,
  timestamp: seconds - 10,
  ...patch,
});
const encode = (feed: Feed) => FeedMessage.encode(FeedMessage.create(feed)).finish();
const feed = (vehicles: Vehicle[] = [vehicle()], timestamp = seconds): Feed => ({
  header: { gtfsRealtimeVersion: '1.0', timestamp },
  entity: vehicles.map((item, index) => ({ id: `vehicle-${index}`, vehicle: item })),
});
const packet = (data: Feed = feed(), received = seconds + 5): SourcePacket => ({
  adapterId: 'mta-subway',
  inputId: 'ace',
  scope: 'citywide',
  receivedAt: new Date(received * 1000).toISOString(),
  payload: encode(data),
});
const adapter = createMtaAdapter(demoCatalog);
const decode = (data: Feed = feed()) => adapter.decode(packet(data))[0]!;
it('decodes actual protobuf bytes into complete, scoped stop associations', () => {
  const batch = decode();
  expect(batch).toMatchObject({
    kind: 'snapshot',
    complete: true,
    inputId: 'ace',
    scope: 'citywide',
    publishedAt: '2026-11-01T17:00:00.000Z',
  });
  expect(batch.entities[0]).toMatchObject({
    longitude: -73.981736,
    latitude: 40.768296,
    observedAt: '2026-11-01T17:00:00.000Z',
    properties: {
      source: 'mta',
      association: 'at',
      direction: 'Southbound',
      stop: '59 St-Columbus Circle',
      lastMovementAt: '2026-11-01T16:59:50.000Z',
      animation: 'track',
    },
  });
});
it.each([
  [0, 'approaching'],
  [1, 'at'],
  [2, 'in_transit_to'],
] as const)('preserves vehicle status %s as %s', (currentStatus, association) => {
  expect(decode(feed([vehicle({ currentStatus })])).entities[0]?.properties.association).toBe(
    association,
  );
});
it('does not claim an arrival when status or sequence is missing', () => {
  const noStatus = vehicle();
  delete noStatus.currentStatus;
  expect(decode(feed([noStatus])).entities[0]?.properties.association).toBe('in_transit_to');
  const noSequence = vehicle();
  delete noSequence.currentStopSequence;
  expect(decode(feed([noSequence])).entities[0]?.properties.association).toBe('associated');
});
it('maps northbound platform IDs without shifting their station coordinates', () => {
  const north = vehicle({
    stopId: 'A24N',
    trip: { tripId: '090000_A..N54R', routeId: 'A', startDate: '20261101' },
  });
  expect(decode(feed([north])).entities[0]).toMatchObject({
    longitude: -73.981736,
    properties: { direction: 'Northbound', gtfsStopId: 'A24N', animation: 'track' },
  });
});
it('keeps trip identity stable when NYCT changes the pattern suffix, and uses fade for unverified paths', () => {
  const first = decode().entities[0]!;
  const updated = decode(
    feed([vehicle({ trip: { tripId: '090000_A..S58X004', routeId: 'A', startDate: '20261101' } })]),
  ).entities[0]!;
  expect(updated.id).toBe(first.id);
  expect(updated.properties.animation).toBe('fade');
  const nextDay = decode(
    feed([vehicle({ trip: { tripId: '090000_A..S58R', routeId: 'A', startDate: '20261102' } })]),
  ).entities[0]!;
  expect(nextDay.id).not.toBe(first.id);
});
it('ignores unsupported routes, out-of-coverage stations, and canceled trips without inventing coordinates', () => {
  const result = decode(
    feed([
      vehicle({ trip: { routeId: 'H' } }),
      vehicle({ stopId: 'A02S' }),
      vehicle({
        trip: {
          tripId: '090001_A..S58R',
          routeId: 'A',
          startDate: '20261101',
          scheduleRelationship: 3,
        },
      }),
    ]),
  );
  expect(result.entities).toEqual([]);
});
it('does not convert trip predictions into train locations', () => {
  const data: Feed = {
    header: { gtfsRealtimeVersion: '1.0', timestamp: seconds },
    entity: [
      {
        id: 'prediction',
        tripUpdate: {
          trip: { routeId: 'A', tripId: 'predicted' },
          stopTimeUpdate: [{ stopId: 'A24S', arrival: { time: seconds + 600 } }],
        },
      },
    ],
  };
  expect(decode(data).entities).toEqual([]);
});
it('rejects differential, malformed, duplicate, stale, future, or partially usable snapshots atomically', () => {
  const malformed = feed([vehicle()]);
  malformed.header!.incrementality = 1;
  const duplicate = feed([vehicle(), vehicle()]);
  duplicate.entity![1]!.id = duplicate.entity![0]!.id;
  const invalidDate = feed([
    vehicle({ trip: { tripId: '090000_A..S58R', routeId: 'A', startDate: '20261340' } }),
  ]);
  const partial = feed([vehicle(), vehicle({ trip: { routeId: 'A' } })]);
  for (const data of [
    malformed,
    duplicate,
    invalidDate,
    partial,
    feed([vehicle()], seconds - 300),
    feed([vehicle()], seconds + 70),
  ]) {
    const state = new StateManager([adapter], randomUUID());
    state.ingest(packet(), (seconds + 5) * 1000);
    const before = state.checkpoint();
    expect(() => state.ingest(packet(data), (seconds + 5) * 1000)).toThrow();
    expect(state.checkpoint()).toEqual(before);
  }
  const p = packet();
  p.payload = (p.payload as Uint8Array).slice(0, -2);
  expect(() => adapter.decode(p)).toThrow();
  p.payload = 'not protobuf';
  expect(() => adapter.decode(p)).toThrow();
});
it('replayed publications do not advance absence grace across the A/C/E group', () => {
  const state = new StateManager([adapter], randomUUID());
  state.ingest(packet(), (seconds + 5) * 1000);
  const absent = packet(feed([], seconds + 30), seconds + 35);
  state.ingest(absent, (seconds + 35) * 1000);
  state.ingest(absent, (seconds + 40) * 1000);
  expect(state.snapshot().entities).toHaveLength(1);
  state.ingest(packet(feed([], seconds + 60), seconds + 65), (seconds + 65) * 1000);
  expect(state.snapshot().entities).toEqual([]);
});
it('omits a future optional last-movement clock without using it as observation time', () => {
  const result = decode(feed([vehicle({ timestamp: seconds + 3600 })])).entities[0]!;
  expect(result.observedAt).toBe('2026-11-01T17:00:00.000Z');
  expect(result.properties.lastMovementAt).toBeNull();
});

it('registers all eight feed groups and decodes stations beyond Manhattan', async () => {
  const { networkCatalog } = await import('./index.ts');
  const { MTA_FEEDS } = await import('@geoatlas/adapter-core');
  const network = createMtaAdapter(networkCatalog);
  expect(network.manifest.inputs.map((input) => input.id)).toEqual(
    MTA_FEEDS.map((group) => group.id),
  );
  for (const group of MTA_FEEDS) {
    const routeId = group.routes[0];
    const station = networkCatalog.stations!.find((item) => item.routeIds.includes(routeId))!;
    const route = networkCatalog.routes.find((item) => item.id === routeId)!;
    const p = packet(
      feed([
        vehicle({
          stopId: station.gtfsStationId + 'S',
          trip: { routeId, tripId: `090000_${route.sourceShapeId}`, startDate: '20261101' },
        }),
      ]),
    );
    p.inputId = group.id;
    const normalized = network.decode(p)[0]!.entities[0]!;
    expect(normalized.properties.route).toBe(routeId);
    expect([normalized.longitude, normalized.latitude]).toEqual([
      station.longitude,
      station.latitude,
    ]);
  }
});
it('places branch or shape-mismatched stations at their real coordinates and uses a fade', async () => {
  const { networkCatalog } = await import('./index.ts');
  const network = createMtaAdapter(networkCatalog),
    route = networkCatalog.routes.find((item) => item.id === 'A')!;
  const branch = networkCatalog.stations!.find(
    (station) =>
      station.routeIds.includes('A') &&
      !route.stops.some((stop) => stop.gtfsStopId!.slice(0, -1) === station.gtfsStationId),
  )!;
  const entity = network.decode(packet(feed([vehicle({ stopId: branch.gtfsStationId + 'S' })])))[0]!
    .entities[0]!;
  expect([entity.longitude, entity.latitude]).toEqual([branch.longitude, branch.latitude]);
  expect(entity.properties.pathIndex).toBeNull();
  expect(entity.properties.animation).toBe('fade');
});
it('isolates disappearance reconciliation across feed groups', async () => {
  const { networkCatalog } = await import('./index.ts');
  const network = createMtaAdapter(networkCatalog),
    state = new StateManager([network], randomUUID());
  const a = packet();
  state.ingest(a, (seconds + 5) * 1000);
  const one = packet(
    feed([
      vehicle({
        stopId: '101S',
        trip: { routeId: '1', tripId: '090000_1..S03R', startDate: '20261101' },
      }),
    ]),
  );
  one.inputId = 'numbered';
  state.ingest(one, (seconds + 5) * 1000);
  for (const offset of [30, 60])
    state.ingest(
      packet(feed([], seconds + offset), seconds + offset + 5),
      (seconds + offset + 5) * 1000,
    );
  expect(state.snapshot().entities).toHaveLength(1);
  expect(state.snapshot().entities[0]?.properties.route).toBe('1');
  const invalid = { ...one, payload: new Uint8Array([255]) };
  expect(() => state.ingest(invalid, (seconds + 70) * 1000)).toThrow();
  expect(state.snapshot().entities).toHaveLength(1);
});
it('cannot write another group through a valid feed envelope', async () => {
  const { networkCatalog } = await import('./index.ts');
  const p = packet();
  p.inputId = 'numbered';
  expect(createMtaAdapter(networkCatalog).decode(p)[0]?.entities).toEqual([]);
});
it('retains detoured trains at a known station outside their static route membership', async () => {
  const { networkCatalog } = await import('./index.ts');
  const station = networkCatalog.stations!.find(
    (item) => item.routeIds.includes('1') && !item.routeIds.includes('A'),
  )!;
  const p = packet(feed([vehicle({ stopId: station.gtfsStationId + 'S' })]));
  const entity = createMtaAdapter(networkCatalog).decode(p)[0]!.entities[0]!;
  expect(entity.properties.route).toBe('A');
  expect(entity.properties.animation).toBe('fade');
  expect([entity.longitude, entity.latitude]).toEqual([station.longitude, station.latitude]);
});
