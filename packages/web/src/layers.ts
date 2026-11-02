import type { Catalog, TrackedEntity } from '@geoatlas/adapter-core';
import type { FeatureCollection, LineString, Point } from 'geojson';

export interface LayerSelection {
  trains: boolean;
  ships: boolean;
  hiddenRoutes: ReadonlySet<string>;
}
export function filterEntities(
  entities: readonly TrackedEntity[],
  selection: LayerSelection,
): TrackedEntity[] {
  return entities.filter((entity) =>
    entity.layer === 'subway'
      ? selection.trains && !selection.hiddenRoutes.has(String(entity.properties.route))
      : selection.ships,
  );
}
export function routeFeatures(
  catalog: Catalog,
  visible: readonly string[],
): FeatureCollection<LineString> {
  const ids = new Set(visible);
  return {
    type: 'FeatureCollection',
    features: catalog.routes.flatMap((route, index) =>
      ids.has(route.id)
        ? [
            {
              type: 'Feature' as const,
              properties: { route: route.id, color: route.color, offset: ((index % 3) - 1) * 2 },
              geometry: { type: 'LineString' as const, coordinates: route.coordinates },
            },
          ]
        : [],
    ),
  };
}
export function stationFeatures(
  catalog: Catalog,
  visible: readonly string[],
): FeatureCollection<Point> {
  const ids = new Set(visible);
  const stations = catalog.stations ?? [
    ...new Map(
      catalog.routes.flatMap((route) =>
        route.stops.map((stop) => {
          const [longitude, latitude] = route.coordinates[stop.pathIndex]!;
          return [
            `${longitude},${latitude}`,
            {
              id: stop.id,
              name: stop.name,
              longitude,
              latitude,
              routeIds: catalog.routes
                .filter((candidate) =>
                  candidate.stops.some((s) => s.gtfsStopId === stop.gtfsStopId),
                )
                .map((candidate) => candidate.id),
            },
          ] as const;
        }),
      ),
    ).values(),
  ];
  return {
    type: 'FeatureCollection',
    features: stations
      .filter((station) => station.routeIds.some((id) => ids.has(id)))
      .map((station) => ({
        type: 'Feature',
        properties: { id: station.id, name: station.name },
        geometry: { type: 'Point', coordinates: [station.longitude, station.latitude] },
      })),
  };
}
export function networkBounds(catalog: Catalog): [[number, number], [number, number]] {
  const points =
    catalog.stations?.map((station) => [station.longitude, station.latitude] as const) ??
    catalog.routes.flatMap((route) => route.coordinates);
  if (!points.length)
    return [
      [-74.26, 40.49],
      [-73.7, 40.92],
    ];
  const longitudes = points.map((point) => point[0]),
    latitudes = points.map((point) => point[1]);
  return [
    [Math.min(...longitudes), Math.min(...latitudes)],
    [Math.max(...longitudes), Math.max(...latitudes)],
  ];
}

/** Unknown train routes stay neutral instead of inheriting the synthetic-vessel color. */
export function entityColor(
  entity: Pick<TrackedEntity, 'layer' | 'properties'>,
  catalog: Catalog,
): string {
  if (entity.layer === 'ship') return '#efbc79';
  return catalog.routes.find((route) => route.id === entity.properties.route)?.color ?? '#95a6b1';
}
