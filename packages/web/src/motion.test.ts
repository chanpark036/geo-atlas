import { expect, it } from 'vitest';
import { MotionLayer } from './motion';
import type { Catalog, TrackedEntity } from '@geoatlas/adapter-core';
const catalog: Catalog = {
  routes: [
    {
      id: 'A',
      name: 'Test',
      color: '#ffffff',
      coordinates: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      stops: [
        { id: 'first', gtfsStopId: '001S', name: 'First', pathIndex: 0 },
        { id: 'bend', gtfsStopId: '002S', name: 'Bend', pathIndex: 1 },
        { id: 'last', gtfsStopId: '003S', name: 'Last', pathIndex: 2 },
      ],
    },
  ],
};
const entity = (index: number): TrackedEntity => ({
  id: 'one',
  key: 'test|a|a|one',
  adapterId: 'test',
  inputId: 'a',
  scope: 'a',
  layer: 'subway',
  longitude: catalog.routes[0]!.coordinates[index]![0],
  latitude: catalog.routes[0]!.coordinates[index]![1],
  observedAt: '2026-10-29T18:00:00Z',
  receivedAt: '2026-10-29T18:00:00Z',
  stale: false,
  missingSnapshots: 0,
  properties: { route: 'A', pathIndex: index, direction: 'Southbound' },
});
it('follows track geometry and holds indefinitely at the reported target', () => {
  const motion = new MotionLayer(catalog);
  motion.sync([entity(0)], 0);
  motion.sync([entity(2)], 100);
  expect(motion.points(850)[0]?.point).toEqual([1, 0]);
  expect(motion.points(1600)[0]?.point).toEqual([1, 1]);
  expect(motion.points(999999)[0]?.point).toEqual([1, 1]);
});
it('retargets from the displayed position instead of jumping or queueing old targets', () => {
  const motion = new MotionLayer(catalog);
  motion.sync([entity(0)], 0);
  motion.sync([entity(2)], 100);
  const before = motion.points(850)[0]?.point;
  motion.sync([entity(0)], 850);
  expect(motion.points(850)[0]?.point).toEqual(before);
  expect(motion.points(2350)[0]?.point).toEqual([0, 0]);
});
it('reconnect snapshots and reduced-motion settings place markers immediately', () => {
  const motion = new MotionLayer(catalog);
  motion.sync([entity(0)], 0);
  motion.sync([entity(2)], 100, true);
  expect(motion.points(100)[0]?.point).toEqual([1, 1]);
  expect(motion.points(100)[0]?.bearing).toBe(0);
  const reduced = new MotionLayer(catalog, true);
  reduced.sync([entity(0)], 0);
  reduced.sync([entity(2)], 100);
  expect(reduced.points(100)[0]?.point).toEqual([1, 1]);
  expect(reduced.points(100)[0]?.bearing).toBe(0);
});
it('does not restart an animation for a freshness-only update and removes vanished entities', () => {
  const motion = new MotionLayer(catalog);
  motion.sync([entity(0)], 0);
  motion.sync([entity(2)], 100);
  motion.sync([{ ...entity(2), stale: true }], 850);
  expect(motion.points(1600)[0]?.point).toEqual([1, 1]);
  motion.sync([], 1600);
  expect(motion.points(1600)).toEqual([]);
});

it('moves by distance rather than vertex count on unevenly sampled paths', () => {
  const dense: Catalog = {
    routes: [
      {
        id: 'A',
        name: 'Test',
        color: '#ffffff',
        coordinates: [
          [0, 0],
          [0.1, 0],
          [0.2, 0],
          [10, 0],
        ],
        stops: [],
      },
    ],
  };
  const start = { ...entity(0), longitude: 0, latitude: 0 };
  const end = {
    ...entity(0),
    longitude: 10,
    latitude: 0,
    properties: { route: 'A', pathIndex: 3 },
  };
  const motion = new MotionLayer(dense);
  motion.sync([start], 0);
  motion.sync([end], 100);
  expect(motion.points(850)[0]?.point[0]).toBeCloseTo(5);
  expect(motion.points(1600)[0]?.point).toEqual([10, 0]);
});
it('does not jump to a route vertex when persisted coordinates belong to an older geometry', () => {
  const old = { ...entity(0), longitude: -5, latitude: -5 };
  const motion = new MotionLayer(catalog);
  motion.sync([old], 0);
  motion.sync([entity(2)], 100);
  expect(motion.points(100)[0]?.point).toEqual([-5, -5]);
  expect(motion.points(1600)[0]?.point).toEqual([1, 1]);
});
it('resumes route-following after a transition from older geometry reaches a valid stop', () => {
  const motion = new MotionLayer(catalog);
  motion.sync([{ ...entity(0), longitude: -5, latitude: -5 }], 0);
  motion.sync([entity(0)], 100);
  motion.sync([entity(2)], 1700);
  expect(motion.points(2450)[0]?.point).toEqual([1, 0]);
});
it('transitions vessel reports without a route and holds at the target', () => {
  const start = {
    ...entity(0),
    layer: 'ship',
    longitude: -74.02,
    latitude: 40.7,
    properties: { kind: 'vessel' },
  };
  const end = { ...start, longitude: -74.0, latitude: 40.72 };
  const motion = new MotionLayer(catalog);
  motion.sync([start], 0);
  motion.sync([end], 100);
  expect(motion.points(100)[0]?.point).toEqual([-74.02, 40.7]);
  expect(motion.points(850)[0]?.point[0]).toBeCloseTo(-74.01);
  expect(motion.points(850)[0]?.point[1]).toBeCloseTo(40.71);
  expect(motion.points(9999)[0]?.point).toEqual([-74.0, 40.72]);
  expect(motion.points(850)[0]?.bearing).toBeNull();
});
it('fades unverified MTA paths between station anchors without drawing a fictitious route', () => {
  const motion = new MotionLayer(catalog);
  const start = {
    ...entity(0),
    properties: { ...entity(0).properties, source: 'mta', animation: 'fade' },
  };
  const end = {
    ...entity(2),
    properties: { ...entity(2).properties, source: 'mta', animation: 'fade' },
  };
  motion.sync([start], 0);
  motion.sync([end], 100);
  expect(motion.points(400)[0]?.point).toEqual([0, 0]);
  expect(motion.points(850)[0]?.opacity).toBe(0);
  expect(motion.points(1000)[0]?.point).toEqual([1, 1]);
  expect(motion.points(1600)[0]).toMatchObject({ point: [1, 1], opacity: 1 });
  expect(motion.points(100)[0]?.bearing).toBeNull();
  expect(motion.points(1600)[0]?.bearing).toBeNull();
});

it('turns arrowheads with the displayed track and holds their heading at the target', () => {
  const motion = new MotionLayer(catalog);
  motion.sync([entity(0)], 0);
  expect(motion.points(0)[0]?.bearing).toBe(90);
  motion.sync([entity(2)], 100);
  expect(motion.points(400)[0]?.bearing).toBe(90);
  expect(motion.points(1300)[0]?.bearing).toBe(0);
  expect(motion.points(999999)[0]?.bearing).toBe(0);
});

it('turns in reverse travel order for the opposite service direction', () => {
  const motion = new MotionLayer(catalog);
  const northbound = (index: number) => ({
    ...entity(index),
    properties: { ...entity(index).properties, direction: 'Northbound' },
  });
  motion.sync([northbound(2)], 0);
  motion.sync([northbound(0)], 100);
  expect(motion.points(400)[0]?.bearing).toBe(180);
  expect(motion.points(1300)[0]?.bearing).toBe(270);
  expect(motion.points(999999)[0]?.bearing).toBe(270);
});

it('uses reported service direction on reconnect and updates reversals without moving the dot', () => {
  const motion = new MotionLayer(catalog);
  motion.sync([entity(1)], 0, true);
  expect(motion.points(0)[0]?.bearing).toBe(0);
  const reversed = {
    ...entity(1),
    properties: { ...entity(1).properties, direction: 'Northbound' },
  };
  motion.sync([reversed], 100);
  expect(motion.points(100)[0]).toMatchObject({ point: [1, 0], bearing: 270 });
  expect(motion.moving(100)).toBe(false);
});

it('does not guess a heading from stale coordinates, missing direction or unverified route order', () => {
  const old = new MotionLayer(catalog);
  old.sync([{ ...entity(0), longitude: -5, latitude: -5 }], 0);
  expect(old.points(0)[0]?.bearing).toBeNull();
  const unknown = new MotionLayer(catalog);
  unknown.sync([{ ...entity(0), properties: { route: 'A', pathIndex: 0 } }], 0);
  expect(unknown.points(0)[0]?.bearing).toBeNull();
  const unordered = new MotionLayer({ routes: [{ ...catalog.routes[0]!, stops: [] }] });
  unordered.sync([entity(0)], 0);
  expect(unordered.points(0)[0]?.bearing).toBeNull();
});

it('fades away the old heading when a same-station report changes to an unverified pattern', () => {
  const motion = new MotionLayer(catalog);
  const verified = {
    ...entity(0),
    properties: { ...entity(0).properties, source: 'mta', animation: 'track' },
  };
  motion.sync([verified], 0);
  expect(motion.points(0)[0]?.bearing).toBe(90);
  motion.sync([{ ...verified, properties: { ...verified.properties, animation: 'fade' } }], 100);
  expect(motion.points(100)[0]?.bearing).toBe(90);
  expect(motion.points(1700)[0]?.bearing).toBeNull();
});

it('restores a verified heading only after fading to the newly matched station', () => {
  const motion = new MotionLayer(catalog);
  motion.sync(
    [{ ...entity(0), properties: { ...entity(0).properties, source: 'mta', animation: 'fade' } }],
    0,
  );
  motion.sync(
    [{ ...entity(1), properties: { ...entity(1).properties, source: 'mta', animation: 'track' } }],
    100,
  );
  expect(motion.points(400)[0]?.bearing).toBeNull();
  expect(motion.points(1300)[0]?.bearing).toBeNull();
  expect(motion.points(1600)[0]?.bearing).toBe(0);
});

it('shows station headings on reconnect even for variants with no representative path index', () => {
  const motion = new MotionLayer(catalog);
  const report = {
    ...entity(0),
    properties: { source: 'mta', animation: 'fade', pathIndex: null, bearing: 75 },
  };
  motion.sync([report], 0, true);
  expect(motion.points(0)[0]?.bearing).toBe(75);
  expect(motion.points(999999)[0]?.bearing).toBe(75);
});

it('keeps each faded anchor paired with its own station heading through a retarget', () => {
  const report = (index: number, bearing: number) => ({
    ...entity(index),
    properties: { source: 'mta', animation: 'fade', pathIndex: null, bearing },
  });
  const motion = new MotionLayer(catalog);
  motion.sync([report(0, 90)], 0);
  motion.sync([report(2, 180)], 100);
  expect(motion.points(400)[0]).toMatchObject({ point: [0, 0], bearing: 90 });
  expect(motion.points(1300)[0]).toMatchObject({ point: [1, 1], bearing: 180 });
  motion.sync([report(1, 270)], 1300);
  expect(motion.points(1300)[0]).toMatchObject({ point: [1, 1], bearing: 180 });
  expect(motion.points(2500)[0]).toMatchObject({ point: [1, 0], bearing: 270 });
  expect(motion.points(999999)[0]).toMatchObject({ point: [1, 0], bearing: 270 });
});

it.each([-1, 360, Number.NaN, Number.POSITIVE_INFINITY, '90', null])(
  'does not render invalid station bearing %s',
  (bearing) => {
    const motion = new MotionLayer(catalog);
    motion.sync([{ ...entity(0), properties: { bearing } }], 0);
    expect(motion.points(0)[0]?.bearing).toBeNull();
  },
);
