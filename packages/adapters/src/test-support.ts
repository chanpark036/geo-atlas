/** Synthetic protobuf fixture generator for offline integration tests; not a live provider. */
import bindings from 'gtfs-realtime-bindings';
export function mtaFixtureBytes(timestampSeconds: number): Uint8Array {
  const { FeedMessage } = bindings.transit_realtime;
  return FeedMessage.encode(
    FeedMessage.create({
      header: { gtfsRealtimeVersion: '1.0', timestamp: timestampSeconds },
      entity: [
        {
          id: 'fixture-train',
          vehicle: {
            trip: { routeId: 'A', tripId: '090000_A..S58R', startDate: '20261101' },
            stopId: 'A24S',
            currentStatus: 1,
            currentStopSequence: 1,
            timestamp: timestampSeconds - 10,
          },
        },
      ],
    }),
  ).finish();
}
