#!/usr/bin/env python3
"""Derive station arrowhead angles from all patterns in a local official GTFS ZIP.

This artifact supplies orientation at station anchors, independently of the
representative paths used for display transitions. No network access.
"""

import argparse
import collections
import csv
from datetime import date
import hashlib
import io
import json
import math
from pathlib import Path
import zipfile

SOURCE_URL = 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip'


def bearing(a, b):
    east = (b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    north = b[1] - a[1]
    return math.degrees(math.atan2(east, north)) % 360 if east or north else None


def consensus(angles):
    if not angles:
        return None
    if any(abs((a - b + 180) % 360 - 180) > 20 for a in angles for b in angles):
        return None
    east = sum(math.sin(math.radians(a)) for a in angles)
    north = sum(math.cos(math.radians(a)) for a in angles)
    return round(math.degrees(math.atan2(east, north)) % 360, 1) % 360


def station_bearing(coordinates, point):
    angles = []
    for index, vertex in enumerate(coordinates):
        if vertex != point:
            continue
        # Prefer the departing segment, or the arriving segment at the terminal.
        angle = next(
            (
                angle
                for other in coordinates[index + 1 :]
                if (angle := bearing(point, other)) is not None
            ),
            None,
        )
        if angle is None:
            angle = next(
                (
                    angle
                    for other in reversed(coordinates[:index])
                    if (angle := bearing(other, point)) is not None
                ),
                None,
            )
        if angle is not None:
            angles.append(angle)
    if angles:
        return consensus(angles)

    # A stop coordinate can be just off a source shape. Use only segments within
    # ten meters, and reject equally close segments with conflicting headings.
    scale = math.cos(math.radians(point[1]))
    nearest = float('inf')
    candidates = []
    for a, b in zip(coordinates, coordinates[1:]):
        x, y = (a[0] - point[0]) * scale, a[1] - point[1]
        dx, dy = (b[0] - a[0]) * scale, b[1] - a[1]
        length = dx * dx + dy * dy
        if not length:
            continue
        t = max(0, min(1, -(x * dx + y * dy) / length))
        distance = math.hypot(x + t * dx, y + t * dy) * 111_320
        nearest = min(nearest, distance)
        candidates.append((distance, bearing(a, b)))
    if nearest > 10:
        return None
    return consensus([angle for distance, angle in candidates if distance <= nearest + 0.5])


def extract_headings(archive_path, retrieved_at):
    if archive_path.stat().st_size > 30 * 1024 * 1024:
        raise ValueError('GTFS archive exceeds size limit')
    with zipfile.ZipFile(archive_path) as archive:

        def read(name):
            if archive.getinfo(name).file_size > 100 * 1024 * 1024:
                raise ValueError(f'{name} exceeds decompressed size limit')
            with archive.open(name) as stream:
                yield from csv.DictReader(io.TextIOWrapper(stream, encoding='utf-8-sig'))

        trips = {row['trip_id']: (row['route_id'], row['shape_id']) for row in read('trips.txt')}
        stops = {row['stop_id']: row for row in read('stops.txt')}
        pattern_stops = collections.defaultdict(set)
        for row in read('stop_times.txt'):
            pattern_stops[trips[row['trip_id']]].add(row['stop_id'])
        if len(pattern_stops) > 512:
            raise ValueError('Review expanded pattern coverage')
        shapes = collections.defaultdict(list)
        for row in read('shapes.txt'):
            shapes[row['shape_id']].append(
                (
                    int(row['shape_pt_sequence']),
                    [float(row['shape_pt_lon']), float(row['shape_pt_lat'])],
                )
            )
        shapes = {key: [point for _, point in sorted(rows)] for key, rows in shapes.items()}
        patterns = []
        for (route_id, shape_id), stop_ids in sorted(pattern_stops.items()):
            coordinates = shapes[shape_id]
            if not 2 <= len(coordinates) <= 4000 or len(stop_ids) > 100:
                raise ValueError('Pattern geometry exceeds bounds')
            headings = []
            for stop_id in sorted(stop_ids):
                stop = stops[stop_id]
                angle = station_bearing(
                    coordinates, [float(stop['stop_lon']), float(stop['stop_lat'])]
                )
                # Retain unknown entries so a missing live pattern cannot use
                # agreement from other variants while ignoring an ambiguous one.
                headings.append([stop_id, angle])
            if headings:
                patterns.append({'routeId': route_id, 'shapeId': shape_id, 'headings': headings})
        stations = [
            [row['stop_id'], float(row['stop_lon']), float(row['stop_lat'])]
            for row in stops.values()
            if row['location_type'] == '1'
        ]
        if len(stations) > 1000:
            raise ValueError('Station count exceeds bounds')
        feed = next(read('feed_info.txt'))
    return {
        'source': {
            'url': SOURCE_URL,
            'retrievedAt': retrieved_at,
            'archiveSha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
            'feedVersion': feed['feed_version'],
        },
        'stations': sorted(stations),
        'patterns': patterns,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--retrieved-at', required=True)
    parser.add_argument(
        '--output',
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / 'packages/adapters/src/data/subway-headings.json',
    )
    args = parser.parse_args()
    date.fromisoformat(args.retrieved_at)
    artifact = extract_headings(args.archive, args.retrieved_at)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, indent=2) + '\n')
    print(f'{len(artifact["patterns"])} route patterns with station bearings')


if __name__ == '__main__':
    main()
