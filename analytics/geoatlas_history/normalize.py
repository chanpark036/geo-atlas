"""Historical observations preserve predictions; they do not assert actual arrivals."""

from datetime import datetime, timezone
import hashlib
import re

from google.transit import gtfs_realtime_pb2 as gtfs

from .captures import MAX_HISTORICAL_PACKET, MAX_PACKET


def identity(*parts):
    return hashlib.sha256('|'.join(str(part) for part in parts).encode()).hexdigest()


def instant(seconds):
    if not isinstance(seconds, int) or seconds <= 0 or seconds >= 253402300800:
        raise ValueError('Invalid provider timestamp')
    return datetime.fromtimestamp(seconds, timezone.utc)


def text(value, maximum=128):
    if not value or len(value) > maximum or not re.fullmatch(r'[a-zA-Z0-9_ .:/-]+', value):
        raise ValueError('Invalid provider identifier')
    return value


def normalize(capture):
    if capture.payload is None:
        return None, [], []
    limit = MAX_HISTORICAL_PACKET if capture.source_kind == 'subwaydata.nyc' else MAX_PACKET
    if len(capture.payload) > limit:
        raise ValueError('Oversize packet')
    message = gtfs.FeedMessage()
    message.ParseFromString(capture.payload)
    if not message.IsInitialized() or message.header.gtfs_realtime_version not in {'1.0', '2.0'}:
        raise ValueError('Invalid GTFS envelope')
    if message.header.incrementality != gtfs.FeedHeader.FULL_DATASET or len(message.entity) > 2000:
        raise ValueError('Unsupported snapshot')
    published = instant(message.header.timestamp)
    publication = identity(
        capture.feed_id, message.header.timestamp, hashlib.sha256(capture.payload).hexdigest()
    )
    predictions, vehicles = [], []
    ids = set()
    for entity in message.entity:
        entity_id = text(entity.id)
        if entity_id in ids:
            raise ValueError('Duplicate provider identity')
        ids.add(entity_id)
        if entity.is_deleted:
            raise ValueError('Unexpected deletion in a full snapshot')
        update = entity.trip_update if entity.HasField('trip_update') else None
        vehicle = entity.vehicle if entity.HasField('vehicle') else None
        if update is None and vehicle is None:
            continue
        trip = update.trip if update is not None else vehicle.trip
        route, trip_id = text(trip.route_id, 32), text(trip.trip_id)
        service_date = None
        if trip.start_date:
            if not re.fullmatch(r'\d{8}', trip.start_date):
                raise ValueError('Invalid service date')
            service_date = datetime.strptime(trip.start_date, '%Y%m%d').date()
        first_stop = (
            update.stop_time_update[0].stop_id
            if update is not None and update.stop_time_update
            else (vehicle.stop_id if vehicle is not None else '')
        )
        direction = first_stop[-1:] if first_stop[-1:] in {'N', 'S'} else trip_id
        origin = re.match(r'^(-?\d+)_', trip_id)
        trip_key = identity(route, service_date, origin[1] if origin else trip_id, direction)
        common = [
            publication,
            capture.capture_id,
            capture.feed_id,
            route,
            trip_key,
            trip_id,
            service_date,
        ]
        if update is not None:
            for index, stop in enumerate(update.stop_time_update):
                stop_id = text(stop.stop_id, 64)
                for kind in ('arrival', 'departure'):
                    event = getattr(stop, kind)
                    if stop.HasField(kind) and event.HasField('time'):
                        predicted = instant(event.time)
                        predictions.append(
                            [
                                identity(publication, entity_id, index, kind),
                                *common,
                                stop_id,
                                stop.stop_sequence if stop.HasField('stop_sequence') else None,
                                kind,
                                published,
                                predicted,
                                capture.captured_at.date(),
                                capture.captured_at,
                            ]
                        )
        if vehicle is not None:
            stop_id = text(vehicle.stop_id, 64) if vehicle.stop_id else None
            movement = instant(vehicle.timestamp) if vehicle.HasField('timestamp') else None
            vehicles.append(
                [
                    identity(publication, entity_id, 'vehicle'),
                    *common,
                    stop_id,
                    vehicle.current_status if vehicle.HasField('current_stop_sequence') else None,
                    published,
                    movement,
                    capture.captured_at.date(),
                    capture.captured_at,
                ]
            )
        if len(predictions) + len(vehicles) > 50_000:
            raise ValueError('Observation count exceeds bounds')
    return published, predictions, vehicles
