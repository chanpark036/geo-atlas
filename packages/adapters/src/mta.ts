import { createHash } from 'node:crypto';
import bindings from 'gtfs-realtime-bindings';
import { z } from 'zod';
import {
  batchSchema,
  LIMITS,
  MTA_FEEDS,
  type AdapterBatch,
  type Catalog,
  type DataAdapter,
  type SourcePacket,
} from '@geoatlas/adapter-core';

const safeText = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_ .:/-]+$/);
const unixTime = z
  .string()
  .regex(/^\d{1,12}$/)
  .transform(Number)
  .refine((n) => Number.isSafeInteger(n) && n > 0 && n < 253402300800);
const serviceDate = z
  .string()
  .regex(/^\d{8}$/)
  .refine(
    (value) =>
      z.iso.date().safeParse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`)
        .success,
  );
const tripSchema = z.object({
  tripId: safeText,
  routeId: safeText,
  startDate: serviceDate,
  scheduleRelationship: z.number().int().optional(),
});
const vehicleSchema = z.object({
  trip: tripSchema,
  stopId: z.string().regex(/^[A-Z0-9]{2,8}[NS]$/),
  currentStopSequence: z.number().int().nonnegative().optional(),
  currentStatus: z.number().int().min(0).max(2).optional(),
  timestamp: unixTime.optional(),
});
const envelopeSchema = z.object({
  header: z.object({
    gtfsRealtimeVersion: z.enum(['1.0', '2.0']),
    timestamp: unixTime,
    incrementality: z.literal(0).optional(),
  }),
  entity: z
    .array(
      z.object({
        id: safeText,
        isDeleted: z.literal(false).optional(),
        vehicle: z.unknown().optional(),
      }),
    )
    .max(2_000)
    .default([]),
});

/** Read-only subway stop associations. No predictions are converted to train positions. */
export function createMtaAdapter(catalog: Catalog): DataAdapter {
  const groups = MTA_FEEDS.filter((group) =>
    catalog.routes.some((route) => (group.routes as readonly string[]).includes(route.id)),
  );
  const stations = new Map(catalog.stations?.map((station) => [station.gtfsStationId, station]));
  return {
    manifest: {
      id: 'mta-subway',
      layer: 'subway',
      attribution: 'MTA GTFS-Realtime redistributed by GeoAtlas; stop associations only',
      license: {
        name: 'MTA data feed terms',
        url: 'https://www.mta.info/developers/terms-and-conditions',
      },
      staleAfterMs: 60_000,
      expireAfterMs: 180_000,
      snapshotGrace: 2,
      inputs: groups.map((group) => ({
        id: group.id,
        scope: 'citywide',
        endpointId: `mta-${group.id}`,
        kind: 'poll' as const,
        intervalMs: 30_000,
        semantics: 'snapshot' as const,
      })),
    },
    decode(packet: SourcePacket): readonly AdapterBatch[] {
      if (typeof packet.payload === 'string' || packet.payload.byteLength > LIMITS.packetBytes)
        throw new Error('Expected bounded protobuf bytes');
      const group = groups.find((candidate) => candidate.id === packet.inputId);
      if (!group || packet.scope !== 'citywide') throw new Error('Undeclared MTA feed scope');
      const message = bindings.transit_realtime.FeedMessage.decode(packet.payload);
      const decoded = bindings.transit_realtime.FeedMessage.toObject(message, {
        longs: String,
        enums: Number,
        defaults: false,
      });
      const feed = envelopeSchema.parse(decoded);
      const publishedMs = feed.header.timestamp * 1_000;
      if (
        Math.abs(Date.parse(packet.receivedAt) - publishedMs) > 120_000 ||
        publishedMs > Date.parse(packet.receivedAt) + LIMITS.futureSkewMs
      )
        throw new Error('Invalid or old MTA publication');
      if (new Set(feed.entity.map((e) => e.id)).size !== feed.entity.length)
        throw new Error('Duplicate feed identity');
      const publishedAt = new Date(publishedMs).toISOString();
      const entities: AdapterBatch['entities'] = [];
      for (const record of feed.entity) {
        // TripUpdates and alerts are not vehicle associations and cannot position a train.
        if (record.vehicle === undefined) continue;
        const raw = z.object({ trip: z.object({ routeId: z.string() }) }).parse(record.vehicle);
        if (!(group.routes as readonly string[]).includes(raw.trip.routeId)) continue;
        const route = catalog.routes.find((candidate) => candidate.id === raw.trip.routeId);
        if (!route) continue;
        const vehicle = vehicleSchema.parse(record.vehicle);
        if (vehicle.trip.scheduleRelationship === 3 || vehicle.trip.scheduleRelationship === 7)
          continue;
        const stationId = vehicle.stopId.slice(0, -1);
        const primaryStop = route.stops.find(
          (candidate) => candidate.gtfsStopId?.slice(0, -1) === stationId,
        );
        const station = stations.get(stationId);
        if (!station && !primaryStop) continue;
        const stopName = station?.name ?? primaryStop!.name;
        const stopId = station?.id ?? primaryStop!.id;
        let movementMs = vehicle.timestamp === undefined ? null : vehicle.timestamp * 1_000;
        // Some otherwise current MTA feeds contain future last-movement clocks.
        // This optional diagnostic never orders state: omit it rather than advancing a clock.
        if (movementMs !== null && movementMs > publishedMs + LIMITS.futureSkewMs)
          movementMs = null;
        const directionCode = vehicle.stopId.slice(-1);
        const direction = directionCode === 'N' ? 'Northbound' : 'Southbound';
        // NYCT documents start-time_shape-id. Path identifiers may change mid-trip.
        const match = /^(-?\d+)_(.*)$/.exec(vehicle.trip.tripId);
        const origin = match?.[1] ?? vehicle.trip.tripId;
        const pattern = match?.[2] ?? '';
        const identity = `${vehicle.trip.routeId}|${vehicle.trip.startDate}|${origin}|${directionCode}`;
        const id = `train-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
        const [longitude, latitude] = station
          ? [station.longitude, station.latitude]
          : route.coordinates[primaryStop!.pathIndex]!;
        const association =
          vehicle.currentStopSequence === undefined
            ? 'associated'
            : ['approaching', 'at', 'in_transit_to'][vehicle.currentStatus ?? 2]!;
        entities.push({
          id,
          longitude,
          latitude,
          observedAt: publishedAt,
          properties: {
            label: `${route.id} ${origin}`,
            route: route.id,
            stop: stopName,
            stopId,
            gtfsStopId: vehicle.stopId,
            pathIndex: primaryStop?.pathIndex ?? null,
            association,
            kind: 'train',
            direction,
            source: 'mta',
            tripId: vehicle.trip.tripId,
            serviceDate: vehicle.trip.startDate,
            lastMovementAt: movementMs === null ? null : new Date(movementMs).toISOString(),
            animation:
              primaryStop && route.compatibleShapeIds?.includes(pattern) ? 'track' : 'fade',
          },
        });
      }
      return [
        batchSchema.parse({
          kind: 'snapshot',
          complete: true,
          inputId: packet.inputId,
          scope: packet.scope,
          publishedAt,
          entities,
        }),
      ];
    },
  };
}
