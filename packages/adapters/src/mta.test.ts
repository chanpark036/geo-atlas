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
  scope: 'manhattan',
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
    scope: 'manhattan',
    publishedAt: '2026-11-01T17:00:00.000Z',
  });
  expect(batch.entities[0]).toMatchObject({
    longitude: -73.981736,
    latitude: 40.768296,
    observedAt: '2026-11-01T17:00:00.000Z',
    properties: {
      source: 'mta',
      association: 'at',
      direction: 'Downtown',
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
    properties: { direction: 'Uptown', gtfsStopId: 'A24N', animation: 'track' },
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
