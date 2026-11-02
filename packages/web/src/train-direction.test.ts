import { expect, it } from 'vitest';
import { bearingAtIndex, routeDirection, trainDirection } from './train-direction';

it.each([
  ['Northbound', 'N'],
  ['Southbound', 'S'],
  ['Uptown', 'N'],
  ['Downtown', 'S'],
])('labels the reported %s service direction as %s', (direction, expected) => {
  expect(trainDirection({ layer: 'subway', properties: { direction } })).toBe(expected);
});

it.each([undefined, null, '', 'Unknown', 'Eastbound', 0])(
  'marks unavailable or unsupported direction %s as unknown',
  (direction) => {
    const properties = direction === undefined ? {} : { direction };
    expect(trainDirection({ layer: 'subway', properties })).toBeNull();
  },
);

it('keeps service-direction labels exclusive to subway trains', () => {
  expect(trainDirection({ layer: 'ship', properties: { direction: 'Northbound' } })).toBeNull();
});

const stop = (gtfsStopId: string) => ({
  id: gtfsStopId.toLowerCase(),
  gtfsStopId,
  name: 'Stop',
  pathIndex: 0,
});

it('reads shape travel order from consistent published stop suffixes', () => {
  expect(routeDirection({ stops: [stop('001S'), stop('002S')] })).toBe('S');
  expect(routeDirection({ stops: [stop('001N'), stop('002N')] })).toBe('N');
  expect(routeDirection({ stops: [] })).toBeNull();
  expect(routeDirection({ stops: [stop('001S'), stop('002N')] })).toBeNull();
  expect(routeDirection({ stops: [stop('001')] })).toBeNull();
});

it.each([
  [[1, 0], 90],
  [[0, 1], 0],
  [[-1, 0], 270],
  [[0, -1], 180],
] as const)('points along the track toward %s', (destination, expected) => {
  const coordinates: [number, number][] = [[0, 0], [...destination]];
  expect(bearingAtIndex(coordinates, 0.5, 1)).toBe(expected);
  expect(bearingAtIndex(coordinates, 0.5, -1)).toBe((expected + 180) % 360);
});

it('uses diagonal angles with longitude scaled to the map latitude', () => {
  expect(
    bearingAtIndex(
      [
        [0, 0],
        [1, 1],
      ],
      0.5,
      1,
    ),
  ).toBeCloseTo(45, 2);
  expect(
    bearingAtIndex(
      [
        [0, 60],
        [2, 61],
      ],
      0.5,
      1,
    ),
  ).toBeCloseTo(44.56, 2);
});

it('takes the outgoing segment at a bend in either travel direction', () => {
  const coordinates: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
  ];
  expect(bearingAtIndex(coordinates, 1, 1)).toBe(0);
  expect(bearingAtIndex(coordinates, 1, -1)).toBe(270);
  expect(bearingAtIndex(coordinates, 2, 1)).toBe(0);
  expect(bearingAtIndex(coordinates, 0, -1)).toBe(270);
});

it('skips duplicate vertices and has no bearing for an empty or zero-length path', () => {
  const coordinates: [number, number][] = [
    [0, 0],
    [0, 0],
    [1, 0],
    [1, 0],
  ];
  expect(bearingAtIndex(coordinates, 0, 1)).toBe(90);
  expect(bearingAtIndex(coordinates, 3, 1)).toBe(90);
  expect(bearingAtIndex(coordinates, 0, -1)).toBe(270);
  expect(
    bearingAtIndex(
      [
        [0, 0],
        [0, 0],
      ],
      0,
      1,
    ),
  ).toBeNull();
  expect(bearingAtIndex([], 0, 1)).toBeNull();
});
