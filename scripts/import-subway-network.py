#!/usr/bin/env python3
"""Extract all subway route IDs and station memberships from an official local GTFS ZIP.

Representative shapes are display context; all stop memberships are collected across
trips, including branches absent from a representative shape. No network access.
"""

import argparse
import collections
import csv
from datetime import date
import hashlib
import io
import json
from pathlib import Path
import zipfile

SOURCE_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip'
ORDER = [
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '6X',
    '7',
    '7X',
    'A',
    'C',
    'E',
    'B',
    'D',
    'F',
    'FX',
    'M',
    'G',
    'J',
    'Z',
    'L',
    'N',
    'Q',
    'R',
    'W',
    'GS',
    'FS',
    'H',
    'SI',
]
NAMES = {
    'GS': '42 St Shuttle',
    'FS': 'Franklin Av Shuttle',
    'H': 'Rockaway Park Shuttle',
    'SI': 'Staten Island Railway',
    '6X': '6 Express',
    '7X': '7 Express',
    'FX': 'F Express',
}


def extract_network(archive_path: Path, retrieved_at: str) -> dict:
    if archive_path.stat().st_size > 30 * 1024 * 1024:
        raise ValueError('GTFS archive exceeds size limit')
    with zipfile.ZipFile(archive_path) as archive:

        def read(name):
            info = archive.getinfo(name)
            if info.file_size > 100 * 1024 * 1024:
                raise ValueError(f'{name} exceeds decompressed size limit')
            with archive.open(info) as stream:
                yield from csv.DictReader(io.TextIOWrapper(stream, encoding='utf-8-sig'))

        routes = {row['route_id']: row for row in read('routes.txt')}
        if set(routes) != set(ORDER):
            raise ValueError(f'Review changed route registry: {sorted(routes)}')
        stops = {row['stop_id']: row for row in read('stops.txt')}
        trips = {row['trip_id']: row for row in read('trips.txt') if row['route_id'] in routes}
        chosen = {}
        for route_id in ORDER:
            candidates = [
                trip
                for trip in trips.values()
                if trip['route_id'] == route_id and trip['direction_id'] == '1'
            ]
            if not candidates:
                candidates = [trip for trip in trips.values() if trip['route_id'] == route_id]
            frequencies = collections.Counter(trip['shape_id'] for trip in candidates)
            shape = min(frequencies, key=lambda key: (-frequencies[key], key))
            chosen[route_id] = min(
                (trip for trip in candidates if trip['shape_id'] == shape),
                key=lambda trip: trip['trip_id'],
            )
        selected_ids = {trip['trip_id'] for trip in chosen.values()}
        selected_times = collections.defaultdict(list)
        membership = collections.defaultdict(set)
        for record in read('stop_times.txt'):
            trip = trips.get(record['trip_id'])
            if trip is None:
                continue
            stop = stops[record['stop_id']]
            parent = stop['parent_station'] or stop['stop_id']
            membership[parent].add(trip['route_id'])
            if record['trip_id'] in selected_ids:
                selected_times[record['trip_id']].append(record)
        shape_ids = {trip['shape_id'] for trip in trips.values()}
        shapes = collections.defaultdict(list)
        for record in read('shapes.txt'):
            if record['shape_id'] in shape_ids:
                shapes[record['shape_id']].append(
                    (
                        int(record['shape_pt_sequence']),
                        [float(record['shape_pt_lon']), float(record['shape_pt_lat'])],
                    )
                )
        points_by_shape = {
            key: [point for _, point in sorted(points)] for key, points in shapes.items()
        }
        result = []
        for route_id in ORDER:
            trip = chosen[route_id]
            coordinates = points_by_shape[trip['shape_id']]
            if not 2 <= len(coordinates) <= 2000:
                raise ValueError(f'{route_id}: representative shape exceeds bounds')
            last_index = -1
            route_stops = []
            unmapped_stops = []
            for record in sorted(
                selected_times[trip['trip_id']], key=lambda row: int(row['stop_sequence'])
            ):
                stop = stops[record['stop_id']]
                point = [float(stop['stop_lon']), float(stop['stop_lat'])]
                index = next(
                    (i for i in range(last_index + 1, len(coordinates)) if coordinates[i] == point),
                    None,
                )
                if index is None:
                    unmapped_stops.append(stop['stop_id'])
                    continue
                last_index = index
                route_stops.append(
                    {
                        'id': stop['stop_id'].lower(),
                        'gtfsStopId': stop['stop_id'],
                        'name': stop['stop_name'],
                        'pathIndex': index,
                    }
                )
            compatible = []
            for shape in sorted(
                {row['shape_id'] for row in trips.values() if row['route_id'] == route_id}
            ):
                points = points_by_shape[shape]
                if points == coordinates or list(reversed(points)) == coordinates:
                    compatible.append(shape)
            source = routes[route_id]
            result.append(
                {
                    'id': route_id,
                    'name': NAMES.get(route_id, source['route_long_name']),
                    'color': '#' + source['route_color'],
                    'sourceShapeId': trip['shape_id'],
                    'sourceTripId': trip['trip_id'],
                    'compatibleShapeIds': compatible,
                    'unmappedStopIds': unmapped_stops,
                    'coordinates': coordinates,
                    'stops': route_stops,
                }
            )
        stations = []
        for parent, route_ids in sorted(membership.items()):
            stop = stops[parent]
            stations.append(
                {
                    'id': parent.lower(),
                    'gtfsStationId': parent,
                    'name': stop['stop_name'],
                    'longitude': float(stop['stop_lon']),
                    'latitude': float(stop['stop_lat']),
                    'routeIds': sorted(route_ids, key=ORDER.index),
                }
            )
        if len(stations) > 1000:
            raise ValueError('Station catalog exceeds bounds')
        feed = next(read('feed_info.txt'))
    return {
        'routes': result,
        'stations': stations,
        'source': {
            'name': 'MTA New York City Transit static GTFS',
            'url': SOURCE_URL,
            'termsUrl': 'https://www.mta.info/developers/terms-and-conditions',
            'retrievedAt': retrieved_at,
            'archiveSha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
            'feedVersion': feed['feed_version'],
            'feedStartDate': feed['feed_start_date'],
            'feedEndDate': feed['feed_end_date'],
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--retrieved-at', required=True)
    parser.add_argument(
        '--output',
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / 'packages/adapters/src/data/subway-network.json',
    )
    args = parser.parse_args()
    date.fromisoformat(args.retrieved_at)
    catalog = extract_network(args.archive, args.retrieved_at)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + '\n')
    print(f'{len(catalog["routes"])} route IDs, {len(catalog["stations"])} GTFS station records')
    print(
        f'Largest representative path: {max(len(route["coordinates"]) for route in catalog["routes"])} vertices'
    )


if __name__ == '__main__':
    main()
