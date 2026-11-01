#!/usr/bin/env python3
"""Extract a reproducible Manhattan demo catalog from the official, local GTFS ZIP.

Network access is intentionally separate. Existing source coordinates are retained;
this is a subset of representative southbound trips, not a service schedule.
"""
import argparse
import collections
import csv
import hashlib
import io
import json
from pathlib import Path
import zipfile

SOURCE_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip'
COLORS = {'A': '#7cb4ff', 'C': '#b19bfa', 'E': '#78dbc0'}
NAMES = {'A': 'A · Manhattan express demo', 'C': 'C · Manhattan local demo', 'E': 'E · Midtown to World Trade Center demo'}
MAX_ARCHIVE_BYTES = 30 * 1024 * 1024
MAX_ENTRY_BYTES = 100 * 1024 * 1024


def extract_catalog(archive_path: Path, retrieved_at: str) -> dict:
    if archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError('GTFS archive exceeds size limit')
    with zipfile.ZipFile(archive_path) as archive:
        def read(name):
            info = archive.getinfo(name)
            if info.file_size > MAX_ENTRY_BYTES:
                raise ValueError(f'{name} exceeds decompressed size limit')
            with archive.open(info) as stream:
                yield from csv.DictReader(io.TextIOWrapper(stream, encoding='utf-8-sig'))

        stops = {row['stop_id']: row for row in read('stops.txt')}
        trips = [row for row in read('trips.txt') if row['route_id'] in COLORS and row['direction_id'] == '1']
        chosen = {}
        for route_id in COLORS:
            frequencies = collections.Counter(row['shape_id'] for row in trips if row['route_id'] == route_id)
            shape_id = sorted(frequencies, key=lambda key: (-frequencies[key], key))[0]
            chosen[route_id] = min((t for t in trips if t['shape_id'] == shape_id and t['route_id'] == route_id), key=lambda t: t['trip_id'])

        selected_ids = {trip['trip_id'] for trip in chosen.values()}
        stop_times = collections.defaultdict(list)
        for row in read('stop_times.txt'):
            if row['trip_id'] in selected_ids:
                stop_times[row['trip_id']].append(row)
        selected_shapes = {trip['shape_id'] for trip in chosen.values()}
        shapes = collections.defaultdict(list)
        for row in read('shapes.txt'):
            if row['shape_id'] in selected_shapes:
                shapes[row['shape_id']].append((int(row['shape_pt_sequence']), [float(row['shape_pt_lon']), float(row['shape_pt_lat'])]))

        routes = []
        for route_id, trip in chosen.items():
            shape = [point for _, point in sorted(shapes[trip['shape_id']])]
            selected_stops, last_index = [], -1
            for record in sorted(stop_times[trip['trip_id']], key=lambda row: int(row['stop_sequence'])):
                stop = stops[record['stop_id']]
                point = [float(stop['stop_lon']), float(stop['stop_lat'])]
                if not (-74.02 < point[0] < -73.96 and 40.70 < point[1] < 40.77):
                    continue
                # Fail rather than invent/snapping coordinates if future feeds diverge.
                index = next((i for i in range(last_index + 1, len(shape)) if shape[i] == point), None)
                if index is None:
                    raise ValueError(f'{route_id}: station {stop["stop_id"]} is not on its shape in order')
                last_index = index
                selected_stops.append({'id': stop['stop_id'].lower(), 'gtfsStopId': stop['stop_id'], 'name': stop['stop_name'], 'pathIndex': index})
            if len(selected_stops) < 2:
                raise ValueError(f'{route_id}: insufficient Manhattan stations')
            start, end = selected_stops[0]['pathIndex'], selected_stops[-1]['pathIndex']
            coordinates = shape[start:end + 1]
            for stop in selected_stops:
                stop['pathIndex'] -= start
            if len(coordinates) > 2000:
                raise ValueError(f'{route_id}: shape exceeds catalog limit')
            routes.append({'id': route_id, 'name': NAMES[route_id], 'color': COLORS[route_id], 'sourceShapeId': trip['shape_id'], 'sourceTripId': trip['trip_id'], 'coordinates': coordinates, 'stops': selected_stops})
        feed = next(read('feed_info.txt'))
    return {'routes': routes, 'source': {
        'name': 'MTA New York City Transit static GTFS', 'url': SOURCE_URL,
        'termsUrl': 'https://www.mta.info/developers/terms-and-conditions',
        'retrievedAt': retrieved_at, 'archiveSha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
        'feedVersion': feed['feed_version'], 'feedStartDate': feed['feed_start_date'], 'feedEndDate': feed['feed_end_date'],
    }}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--retrieved-at', required=True, help='UTC date the archive was downloaded, YYYY-MM-DD')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'packages/adapters/src/data/manhattan.json')
    args = parser.parse_args()
    from datetime import date
    date.fromisoformat(args.retrieved_at)
    catalog = extract_catalog(args.archive, args.retrieved_at)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + '\n')
    for route in catalog['routes']:
        print(f'{route["id"]}: {len(route["stops"])} stations, {len(route["coordinates"])} shape vertices ({route["sourceShapeId"]})')


if __name__ == '__main__':
    main()
