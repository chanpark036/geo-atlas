import type { Catalog, TrackedEntity } from '@geoatlas/adapter-core';
import type { Map } from 'maplibre-gl';

export type ServiceDirection = 'N' | 'S';

/** Service direction comes from the report, not the train's geographic bearing. */
export function trainDirection(
  entity: Pick<TrackedEntity, 'layer' | 'properties'>,
): ServiceDirection | null {
  if (entity.layer !== 'subway') return null;
  switch (entity.properties.direction) {
    case 'Northbound':
    case 'Uptown':
      return 'N';
    case 'Southbound':
    case 'Downtown':
      return 'S';
    default:
      return null;
  }
}

/** Published stop suffixes establish shape order without assuming that southbound means down. */
export function routeDirection(
  route: Pick<Catalog['routes'][number], 'stops'>,
): ServiceDirection | null {
  const direction = route.stops[0]?.gtfsStopId?.slice(-1);
  if (direction !== 'N' && direction !== 'S') return null;
  return route.stops.every((stop) => stop.gtfsStopId?.endsWith(direction)) ? direction : null;
}

/** Clockwise degrees from geographic north, following the local segment in travel order. */
export function bearingAtIndex(
  coordinates: readonly [number, number][],
  index: number,
  step: 1 | -1,
): number | null {
  const lastSegment = coordinates.length - 2;
  if (lastSegment < 0 || !Number.isFinite(index)) return null;
  const segment = Math.max(
    0,
    Math.min(lastSegment, step === 1 ? Math.floor(index) : Math.ceil(index) - 1),
  );
  // Skip repeated vertices. At a terminal, use the nearest nonzero segment behind it.
  for (const scan of [step, -step]) {
    for (let i = segment; i >= 0 && i <= lastSegment; i += scan) {
      const a = coordinates[i]!;
      const b = coordinates[i + 1]!;
      const longitudeScale = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
      const east = (b[0] - a[0]) * longitudeScale * step;
      const north = (b[1] - a[1]) * step;
      if (east !== 0 || north !== 0) {
        return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
      }
    }
  }
  return null;
}

/** Local artwork also works in the route-only fallback without a glyph service. */
export function addTrainDirectionImage(map: Map): void {
  const id = 'train-arrowhead';
  if (map.hasImage(id)) return;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d');
  if (!context) return;

  context.lineJoin = 'round';
  context.lineWidth = 2.5;
  context.strokeStyle = '#10202a';
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.moveTo(16, 5);
  context.lineTo(26, 24);
  context.lineTo(16, 20);
  context.lineTo(6, 24);
  context.closePath();
  context.fill();
  context.stroke();
  map.addImage(id, context.getImageData(0, 0, 32, 32), { pixelRatio: 2 });
}
