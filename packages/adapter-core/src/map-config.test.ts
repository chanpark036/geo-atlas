import { expect, it } from 'vitest';
import { BASEMAP, mapResourceRequest } from './map-config.ts';
it('allows only reviewed OpenFreeMap resources without cross-origin credentials', () => {
  for (const path of [
    '/styles/dark',
    '/planet',
    '/planet/20261028/12/1205/1538.pbf',
    '/fonts/Noto%20Sans%20Regular/0-255.pbf',
    '/sprites/ofm_f384/ofm.json',
    '/natural_earth/ne2sr/0/0/0.png',
  ]) {
    expect(mapResourceRequest(BASEMAP.origin + path)).toEqual({
      url: BASEMAP.origin + path,
      credentials: 'same-origin',
    });
  }
});
it.each([
  'http://tiles.openfreemap.org/styles/dark',
  'https://tiles.openfreemap.org.evil.test/styles/dark',
  'https://user:secret@tiles.openfreemap.org/styles/dark',
  'https://tiles.openfreemap.org/private',
  'https://127.0.0.1/planet',
  'file:///etc/passwd',
  'data:application/json,{}',
])('blocks unregistered resources: %s', (url) => {
  expect(() => mapResourceRequest(url)).toThrow();
});
