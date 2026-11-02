import { expect, it } from 'vitest';
import { StationHeadings } from './station-headings.ts';
import artifact from './data/subway-headings.json' with { type: 'json' };
import { networkCatalog } from './index.ts';
import { MTA_ROUTE_IDS } from '@geoatlas/adapter-core';

const fingerprint = 'a'.repeat(64);
const fixture = () => ({
  source: {
    url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip',
    retrievedAt: '2026-10-29',
    archiveSha256: fingerprint,
    feedVersion: 'fixture',
  },
  stations: [
    ['001', -74, 40.7],
    ['002', -73.9, 40.8],
  ],
  patterns: [
    {
      routeId: 'A',
      shapeId: 'first',
      headings: [
        ['001S', 90],
        ['002S', 0],
      ],
    },
    {
      routeId: 'A',
      shapeId: 'second',
      headings: [
        ['001S', 95],
        ['002S', 180],
      ],
    },
    { routeId: 'A', shapeId: 'north', headings: [['001N', 270]] },
  ],
});

it('uses exact trip-pattern headings, including zero degrees', () => {
  const lookup = new StationHeadings(fixture());
  expect(lookup.get(fingerprint, 'A', 'first', '001S', -74, 40.7)).toBe(90);
  expect(lookup.get(fingerprint, 'A', 'first', '002S', -73.9, 40.8)).toBe(0);
  expect(lookup.get(fingerprint, 'A', 'north', '001N', -74, 40.7)).toBe(270);
});

it('allows a missing pattern only where all static variants agree locally', () => {
  const lookup = new StationHeadings(fixture());
  expect(lookup.get(fingerprint, 'A', 'unknown', '001S', -74, 40.7)).toBeCloseTo(92.5);
  expect(lookup.get(fingerprint, 'A', 'unknown', '002S', -73.9, 40.8)).toBeNull();
  expect(lookup.get(fingerprint, 'A', 'unknown', '001N', -74, 40.7)).toBe(270);
});

it('handles circular agreement across north', () => {
  const data = fixture();
  data.patterns = [
    { routeId: 'A', shapeId: 'first', headings: [['001S', 359]] },
    { routeId: 'A', shapeId: 'second', headings: [['001S', 1]] },
  ];
  const angle = new StationHeadings(data).get(fingerprint, 'A', 'unknown', '001S', -74, 40.7)!;
  expect(Math.min(angle, 360 - angle)).toBeCloseTo(0);
});

it('does not discard an ambiguous variant when deciding whether a missing shape can use a fallback', () => {
  const data = fixture();
  const input = {
    ...data,
    patterns: [
      ...data.patterns,
      { routeId: 'A', shapeId: 'ambiguous', headings: [['001S', null]] },
    ],
  };
  const lookup = new StationHeadings(input);
  expect(lookup.get(fingerprint, 'A', 'unknown', '001S', -74, 40.7)).toBeNull();
  expect(lookup.get(fingerprint, 'A', 'first', '001S', -74, 40.7)).toBe(90);
});

it('rejects a known pattern with an unrelated stop, detours, changed geography and mismatched provenance', () => {
  const lookup = new StationHeadings(fixture());
  expect(lookup.get(fingerprint, 'A', 'first', '001N', -74, 40.7)).toBeNull();
  expect(lookup.get(fingerprint, 'B', 'first', '001S', -74, 40.7)).toBeNull();
  expect(lookup.get(fingerprint, 'A', 'unknown', '003S', -74, 40.7)).toBeNull();
  expect(lookup.get(fingerprint, 'A', 'first', '001S', -73, 40.7)).toBeNull();
  expect(lookup.get(undefined, 'A', 'first', '001S', -74, 40.7)).toBeNull();
  expect(lookup.get('b'.repeat(64), 'A', 'first', '001S', -74, 40.7)).toBeNull();
});

it('validates bounded headings and unique station relationships', () => {
  const invalidAngle = fixture();
  invalidAngle.patterns[0]!.headings[0]![1] = 360;
  expect(() => new StationHeadings(invalidAngle)).toThrow();
  const duplicate = fixture();
  duplicate.patterns.push(duplicate.patterns[0]!);
  expect(() => new StationHeadings(duplicate)).toThrow();
  const unknownStation = fixture();
  unknownStation.patterns[0]!.headings.push(['999S', 90]);
  expect(() => new StationHeadings(unknownStation)).toThrow();
});

it('keeps the generated artifact aligned with the reviewed archive and every subway route', () => {
  expect(artifact.source.archiveSha256).toBe(networkCatalog.source?.archiveSha256);
  expect(artifact.source.feedVersion).toBe(networkCatalog.source?.feedVersion);
  expect([...new Set(artifact.patterns.map((pattern) => pattern.routeId))].sort()).toEqual(
    [...MTA_ROUTE_IDS].sort(),
  );
  for (const [id, longitude, latitude] of artifact.stations) {
    const station = networkCatalog.stations!.find((item) => item.gtfsStationId === id)!;
    expect([station.longitude, station.latitude]).toEqual([longitude, latitude]);
  }
});
