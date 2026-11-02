import { expect, it } from 'vitest';
import { reportPresentation } from './report-presentation';
import type { TrackedEntity } from '@geoatlas/adapter-core';
const entity = (association: string): Pick<TrackedEntity, 'layer' | 'properties'> => ({
  layer: 'subway',
  properties: { source: 'mta', association, direction: 'Uptown', animation: 'track' },
});
it('does not relabel approaching or in-transit associations as an arrival', () => {
  expect(reportPresentation(entity('at')).heading).toBe('REPORTED AT STOP');
  expect(reportPresentation(entity('approaching')).description).toContain('approaching');
  expect(reportPresentation(entity('in_transit_to')).description).toContain('in transit');
  expect(reportPresentation(entity('associated')).description).toContain('not provided');
});
it('distinguishes publication time, stop anchors and unverified paths', () => {
  const report = entity('at');
  report.properties = { ...report.properties, animation: 'fade' };
  expect(reportPresentation(report).clock).toBe('Feed publication');
  expect(reportPresentation(report).note).toContain('not an exact train position');
  expect(reportPresentation(report).note).toContain('Path unverified');
});
