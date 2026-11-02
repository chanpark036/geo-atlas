import { expect, it } from 'vitest';
import type { Catalog, TrackedEntity } from '@geoatlas/adapter-core';
import { filterEntities, routeFeatures, stationFeatures, networkBounds } from './layers';
const catalog: Catalog = {
  routes: [
    {
      id: 'A',
      name: 'A',
      color: '#123456',
      coordinates: [
        [-74, 40.7],
        [-73.9, 40.8],
      ],
      stops: [],
    },
    {
      id: '1',
      name: '1',
      color: '#ff0000',
      coordinates: [
        [-74.1, 40.6],
        [-73.8, 40.9],
      ],
      stops: [],
    },
  ],
  stations: [
    {
      id: 'shared',
      gtfsStationId: '001',
      name: 'Shared',
      longitude: -74,
      latitude: 40.7,
      routeIds: ['A', '1'],
    },
    {
      id: 'branch',
      gtfsStationId: '002',
      name: 'Branch',
      longitude: -74.2,
      latitude: 40.5,
      routeIds: ['A'],
    },
  ],
};
it('filters trains by route and layer while retaining independently selected vessels', () => {
  const entities = [
    { layer: 'subway', properties: { route: 'A' } },
    { layer: 'subway', properties: { route: '1' } },
    { layer: 'ship', properties: {} },
  ] as TrackedEntity[];
  expect(
    filterEntities(entities, { trains: true, ships: true, hiddenRoutes: new Set(['A']) }),
  ).toEqual([entities[1], entities[2]]);
  expect(filterEntities(entities, { trains: false, ships: true, hiddenRoutes: new Set() })).toEqual(
    [entities[2]],
  );
  expect(
    filterEntities(entities, { trains: true, ships: false, hiddenRoutes: new Set(['A', '1']) }),
  ).toEqual([]);
});
it('filters map context too, retaining shared stations and off-primary branches', () => {
  expect(
    routeFeatures(catalog, ['1']).features.map((feature) => feature.properties?.route),
  ).toEqual(['1']);
  expect(stationFeatures(catalog, ['1']).features.map((feature) => feature.properties?.id)).toEqual(
    ['shared'],
  );
  expect(stationFeatures(catalog, ['A']).features.map((feature) => feature.properties?.id)).toEqual(
    ['shared', 'branch'],
  );
  expect(stationFeatures(catalog, []).features).toEqual([]);
});
it('fits the network to global stations rather than only representative paths', () => {
  expect(networkBounds(catalog)).toEqual([
    [-74.2, 40.5],
    [-74, 40.7],
  ]);
});
it('uses route colors for numbered trains and reserves orange for vessels', async () => {
  const { entityColor } = await import('./layers');
  expect(entityColor({ layer: 'subway', properties: { route: '1' } }, catalog)).toBe('#ff0000');
  expect(entityColor({ layer: 'subway', properties: { route: 'unknown' } }, catalog)).toBe(
    '#95a6b1',
  );
  expect(entityColor({ layer: 'ship', properties: {} }, catalog)).toBe('#efbc79');
});
