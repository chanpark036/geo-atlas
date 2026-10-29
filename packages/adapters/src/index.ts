import { batchSchema, type AdapterManifest, type Catalog, type DataAdapter, type SourcePacket } from '@geoatlas/adapter-core';

// Intentionally approximate, synthetic paths. Not MTA track geometry or live locations.
const spine: [number, number][] = [
  [-73.9819,40.7681], [-73.9854,40.7590], [-73.9904,40.7505], [-73.9990,40.7410],
  [-74.0031,40.7325], [-74.0085,40.7217], [-74.0093,40.7131], [-74.0140,40.7075],
];
const names = ['Columbus Circle','50 Street','Penn Station','23 Street','West 4 Street','Canal Street','Chambers Street','World Trade Center'];
export const demoCatalog: Catalog = { routes: [
  { id: 'A', name: 'A · Manhattan local demo', color: '#7cb4ff', coordinates: spine, stops: names.map((name, pathIndex) => ({ id: `a-${pathIndex}`, name, pathIndex })) },
  { id: 'C', name: 'C · West side demo', color: '#b19bfa', coordinates: spine.map(([x,y]) => [x - .0012,y]), stops: names.map((name, pathIndex) => ({ id: `c-${pathIndex}`, name, pathIndex })) },
  { id: 'E', name: 'E · Crosstown demo', color: '#78dbc0', coordinates: [[-73.9668,40.7572],[-73.9762,40.7604],...spine.slice(1)], stops: ['Lexington Avenue','5 Avenue',...names.slice(1)].map((name, pathIndex) => ({ id: `e-${pathIndex}`, name, pathIndex })) },
] };
const decode = (packet: SourcePacket) => [batchSchema.parse(JSON.parse(typeof packet.payload === 'string' ? packet.payload : new TextDecoder('utf-8', { fatal: true }).decode(packet.payload)))];
export const transitAdapter: DataAdapter = {
  manifest: {
    id: 'demo-transit', layer: 'subway', attribution: 'GeoAtlas synthetic transit; not MTA reports', license: { name: 'Synthetic demonstration data' },
    staleAfterMs: 20_000, expireAfterMs: 90_000, snapshotGrace: 2,
    inputs: demoCatalog.routes.map(r => ({ id: r.id.toLowerCase(), endpointId: `demo-${r.id.toLowerCase()}`, scope: r.id.toLowerCase(), kind: 'poll', intervalMs: 6_000, semantics: 'snapshot' })),
  }, decode,
};
export const maritimeAdapter: DataAdapter = {
  manifest: {
    id: 'demo-maritime', layer: 'ship', attribution: 'GeoAtlas synthetic harbor traffic; not AIS reports', license: { name: 'Synthetic demonstration data' },
    staleAfterMs: 15_000, expireAfterMs: 60_000, snapshotGrace: 2,
    inputs: [{ id: 'harbor', endpointId: 'demo-harbor', scope: 'nyc', kind: 'websocket', semantics: 'delta' }],
  }, decode,
};
export const demoAdapters = [transitAdapter, maritimeAdapter];
export function transitPayload(routeId: string, now = Date.now()): string {
  const route = demoCatalog.routes.find(r => r.id === routeId)!;
  const step = Math.floor(now / 6_000), observedAt = new Date(step * 6_000).toISOString();
  const entities = [0,1].map(offset => {
    const cycle = (step + offset * 5) % ((route.coordinates.length - 1) * 2);
    const pathIndex = cycle < route.coordinates.length ? cycle : 2 * (route.coordinates.length - 1) - cycle;
    const [longitude, latitude] = route.coordinates[pathIndex]!;
    return { id: `${route.id}-${offset + 1}`, longitude, latitude, observedAt,
      properties: { label: `${route.id} ${String(offset + 1).padStart(2,'0')}`, route: route.id, stop: route.stops[pathIndex]!.name,
        pathIndex, association: 'at', kind: 'train', direction: cycle < route.coordinates.length - 1 ? 'Downtown' : 'Uptown' } };
  });
  return JSON.stringify({ inputId: routeId.toLowerCase(), scope: routeId.toLowerCase(), kind: 'snapshot', complete: true, publishedAt: observedAt, entities });
}
export function vesselPayload(now = Date.now()): string {
  const tick = Math.floor(now / 2_000), index = tick % 3;
  const phase = (Math.floor(tick / 3) % 30) / 30 * Math.PI * 2;
  return JSON.stringify({ inputId: 'harbor', scope: 'nyc', kind: 'delta', removals: [], entities: [{
    id: `vessel-${index}`, longitude: -74.026 + Math.cos(phase + index) * .008,
    latitude: 40.709 + Math.sin(phase + index) * .017, observedAt: new Date(tick * 2_000).toISOString(),
    properties: { label: ['Harbor One','North Star','Hudson Pilot'][index], kind: 'vessel', type: ['Ferry','Tug','Pilot boat'][index], synthetic: true },
  }] });
}
export function allManifests(): readonly AdapterManifest[] { return demoAdapters.map(a => a.manifest); }
