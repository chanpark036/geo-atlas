import { batchSchema, type AdapterManifest, type Catalog, type DataAdapter, type SourcePacket } from '@geoatlas/adapter-core';

import { catalogSchema } from '@geoatlas/adapter-core';
import manhattan from './data/manhattan.json' with { type: 'json' };

// Official static GTFS subset; trains and their schedules remain entirely synthetic.
export const demoCatalog: Catalog = catalogSchema.parse(manhattan);
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
    const cycle = (step + offset * 5) % ((route.stops.length - 1) * 2);
    const stopIndex = cycle < route.stops.length ? cycle : 2 * (route.stops.length - 1) - cycle;
    const stop = route.stops[stopIndex]!, pathIndex = stop.pathIndex;
    const [longitude, latitude] = route.coordinates[pathIndex]!;
    return { id: `${route.id}-${offset + 1}`, longitude, latitude, observedAt,
      properties: { label: `${route.id} ${String(offset + 1).padStart(2,'0')}`, route: route.id, stop: stop.name, stopId: stop.id, gtfsStopId: stop.gtfsStopId!,
        pathIndex, association: 'at', kind: 'train', direction: cycle < route.stops.length - 1 ? 'Downtown' : 'Uptown' } };
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
