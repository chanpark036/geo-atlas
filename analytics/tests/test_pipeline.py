import base64
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import uuid

from google.transit import gtfs_realtime_pb2 as gtfs

from analytics.geoatlas_history.backfill import PublicHTTPSConnection, approved_url, fetch_day
from analytics.geoatlas_history.benchmark import benchmark
from analytics.geoatlas_history.captures import historical_captures, live_captures
from analytics.geoatlas_history.pipeline import analyze, connection, dataset_views, import_source

SECONDS = int(datetime(2026, 11, 3, 12, tzinfo=timezone.utc).timestamp())


def packet(published=SECONDS, prediction=SECONDS + 300):
    message = gtfs.FeedMessage()
    message.header.gtfs_realtime_version = '2.0'
    message.header.timestamp = published
    entity = message.entity.add(id='prediction')
    trip = entity.trip_update.trip
    trip.trip_id, trip.route_id, trip.start_date = '090000_A..S58R', 'A', '20261103'
    stop = entity.trip_update.stop_time_update.add(stop_id='A24S', stop_sequence=1)
    stop.arrival.time = prediction
    vehicle = message.entity.add(id='vehicle').vehicle
    vehicle.trip.CopyFrom(trip)
    vehicle.stop_id, vehicle.current_stop_sequence = 'A24S', 1
    vehicle.current_status = gtfs.VehiclePosition.STOPPED_AT
    vehicle.timestamp = published - 10
    return message.SerializeToString()


def row(payload, received=SECONDS, outcome='changed'):
    return {
        'version': 1,
        'capture_id': str(uuid.uuid4()),
        'feed_id': 'ace',
        'received_at': datetime.fromtimestamp(received, timezone.utc).isoformat(),
        'outcome': outcome,
        'payload_sha256': hashlib.sha256(payload).hexdigest() if payload is not None else None,
        'payload_base64': base64.b64encode(payload).decode() if payload is not None else None,
    }


def write_raw(path, rows):
    with gzip.open(path, 'wt') as target:
        for item in rows:
            target.write(json.dumps(item) + '\n')


def write_tar(path, members):
    with tarfile.open(path, 'w:xz') as target:
        for name, content in members:
            info = tarfile.TarInfo(name)
            info.size = len(content)
            target.addfile(info, io.BytesIO(content))


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.raw = self.root / 'part.ndjson.gz'
        self.dataset = self.root / 'parquet'

    def test_real_parquet_quality_report_and_prediction_revisions(self):
        first, second = packet(), packet(SECONDS + 30, SECONDS + 320)
        write_raw(
            self.raw,
            [
                row(first),
                row(second, SECONDS + 30),
                row(second, SECONDS + 35, 'unchanged'),
                row(b'\xff', SECONDS + 40, 'rejected'),
                row(None, SECONDS + 45, 'fetch_error'),
            ],
        )
        manifest = import_source(self.raw, self.dataset)
        self.assertFalse(manifest['skipped'])
        self.assertGreater(len(manifest['files']), 0)
        self.assertTrue(
            all(
                (self.dataset / 'batches' / manifest['batch_id'] / item['path'])
                .read_bytes()
                .startswith(b'PAR1')
                for item in manifest['files']
            )
        )
        report = analyze(self.dataset)
        self.assertEqual(report['summary']['captures'], 5)
        self.assertEqual(report['summary']['prediction_observations'], 2)
        self.assertEqual(report['summary']['vehicle_observations'], 2)
        self.assertEqual(report['summary']['repeated_publications'], 1)
        self.assertEqual(report['summary']['invalid_packets'], 1)
        self.assertEqual(report['summary']['fetch_errors'], 1)
        self.assertEqual(report['prediction_revisions'][0]['mean_absolute_revision_seconds'], 20)

    def test_reruns_and_copied_sources_do_not_duplicate_outputs(self):
        write_raw(self.raw, [row(packet())])
        first = import_source(self.raw, self.dataset)
        self.assertTrue(import_source(self.raw, self.dataset)['skipped'])
        copied = self.root / 'copy.ndjson.gz'
        copied.write_bytes(self.raw.read_bytes())
        self.assertTrue(import_source(copied, self.dataset)['skipped'])
        self.assertEqual(len(list((self.dataset / 'batches').iterdir())), 1)
        self.assertEqual(analyze(self.dataset)['summary']['prediction_observations'], 1)
        output = self.dataset / 'batches' / first['batch_id'] / first['files'][0]['path']
        output.write_bytes(b'corrupted')
        with self.assertRaises(ValueError):
            import_source(self.raw, self.dataset)

    def test_overlapping_capture_batches_preserve_capture_evidence_and_deduplicate_observations(
        self,
    ):
        write_raw(self.raw, [row(packet())])
        import_source(self.raw, self.dataset)
        other = self.root / 'other.ndjson.gz'
        write_raw(other, [row(packet(), SECONDS + 1)])
        import_source(other, self.dataset)
        report = analyze(self.dataset)['summary']
        self.assertEqual(report['captures'], 2)
        self.assertEqual(report['prediction_observations'], 1)
        self.assertEqual(report['repeated_publications'], 1)

    def test_conflicting_publications_are_flagged_and_excluded_from_revision_metric(self):
        write_raw(
            self.raw,
            [
                row(packet()),
                row(packet(SECONDS, SECONDS + 500)),
                row(packet(SECONDS + 30, SECONDS + 320), SECONDS + 30),
            ],
        )
        import_source(self.raw, self.dataset)
        report = analyze(self.dataset)
        self.assertEqual(report['summary']['conflicting_publications'], 1)
        self.assertEqual(report['prediction_revisions'], [])

    def test_late_and_missing_publications_remain_visible(self):
        write_raw(
            self.raw,
            [
                row(packet(SECONDS + 30), SECONDS + 35),
                row(packet(), SECONDS + 40),
                row(packet(SECONDS + 180), SECONDS + 185),
            ],
        )
        import_source(self.raw, self.dataset)
        quality = analyze(self.dataset)['feed_quality'][0]
        self.assertEqual(quality['out_of_order_publications'], 1)
        self.assertEqual(quality['publication_gaps_over_90s'], 1)

    def test_checksum_errors_and_truncated_input_never_publish_partial_batches(self):
        bad = row(packet())
        bad['payload_sha256'] = '0' * 64
        write_raw(self.raw, [bad])
        with self.assertRaises(ValueError):
            import_source(self.raw, self.dataset)
        write_raw(self.raw, [row(packet())])
        self.raw.write_bytes(self.raw.read_bytes()[:-5])
        with self.assertRaises(EOFError):
            import_source(self.raw, self.dataset)
        self.assertFalse((self.dataset / 'batches').exists())

    def test_observation_budget_rolls_back_cleanly(self):
        write_raw(self.raw, [row(packet())])
        with self.assertRaises(ValueError):
            import_source(self.raw, self.dataset, max_rows=1)
        self.assertFalse((self.dataset / 'batches').exists())
        self.assertEqual(list((self.dataset / '.pending').iterdir()), [])

    def test_dataset_capacity_does_not_publish_partial_outputs(self):
        write_raw(self.raw, [row(packet())])
        with self.assertRaisesRegex(ValueError, 'capacity'):
            import_source(self.raw, self.dataset, max_dataset_bytes=1)
        self.assertFalse((self.dataset / 'batches').exists())

    def test_reports_select_capture_date_and_feed_without_loading_unrelated_partitions(self):
        write_raw(self.raw, [row(packet()), row(packet(), SECONDS + 86400)])
        import_source(self.raw, self.dataset)
        report = analyze(self.dataset, '2026-11-03', 'ace')
        self.assertEqual(report['summary']['captures'], 1)
        self.assertEqual(report['summary']['prediction_observations'], 1)
        self.assertEqual(report['selection']['capture_date'], '2026-11-03')
        empty = analyze(self.dataset, '2026-11-05', 'g')
        self.assertEqual(empty['summary']['captures'], 0)
        self.assertEqual(empty['summary']['prediction_observations'], 0)
        self.assertEqual(empty['prediction_revisions'], [])

    def test_retry_cleans_only_owned_interrupted_staging_work(self):
        owned = self.dataset / '.pending/interrupted'
        owned.mkdir(parents=True)
        (owned / '.geoatlas-pending').write_text('geoatlas-history\n')
        (owned / 'partial.csv').write_text('incomplete')
        unknown = self.dataset / '.pending/other-work'
        unknown.mkdir()
        write_raw(self.raw, [row(packet())])
        import_source(self.raw, self.dataset)
        self.assertFalse(owned.exists())
        self.assertTrue(unknown.exists())

    def test_late_publications_do_not_reset_the_gap_watermark(self):
        write_raw(
            self.raw,
            [
                row(packet(SECONDS + 30), SECONDS + 35),
                row(packet(), SECONDS + 40),
                row(packet(SECONDS + 100), SECONDS + 105),
            ],
        )
        import_source(self.raw, self.dataset)
        quality = analyze(self.dataset)['feed_quality'][0]
        self.assertEqual(quality['out_of_order_publications'], 1)
        self.assertEqual(quality['publication_gaps_over_90s'], 0)

    def test_live_rejected_captures_remain_auditable_but_do_not_drive_revision_statistics(self):
        write_raw(
            self.raw,
            [
                row(packet(), outcome='rejected'),
                row(packet(SECONDS + 30, SECONDS + 320), SECONDS + 30),
            ],
        )
        import_source(self.raw, self.dataset)
        report = analyze(self.dataset)
        self.assertEqual(report['summary']['live_rejected_captures'], 1)
        self.assertEqual(report['summary']['prediction_observations'], 2)
        self.assertEqual(report['prediction_revisions'], [])

    def test_ambiguous_repeated_stops_are_not_compared_as_one_arrival(self):
        def loop_packet(published):
            message = gtfs.FeedMessage.FromString(packet(published))
            update = message.entity[0].trip_update
            update.stop_time_update[0].ClearField('stop_sequence')
            stop = update.stop_time_update.add(stop_id='A24S')
            stop.arrival.time = published + 600
            return message.SerializeToString()

        write_raw(
            self.raw, [row(loop_packet(SECONDS)), row(loop_packet(SECONDS + 30), SECONDS + 30)]
        )
        import_source(self.raw, self.dataset)
        self.assertEqual(analyze(self.dataset)['prediction_revisions'], [])

    def test_benchmark_runs_a_fresh_conversion_and_cleans_its_temporary_dataset(self):
        source = self.root / 'day.tar.xz'
        write_tar(source, [('nycsubway_ACE_20261103T120000.000Z_abcd.gtfsrt', packet())])
        result = benchmark(source, 'ace', 12)
        self.assertEqual(result['summary']['prediction_observations'], 1)
        self.assertGreater(result['conversion_seconds'], 0)
        self.assertGreater(result['parquet_bytes'], 0)
        self.assertEqual(result['machine']['duckdb'], '1.4.3')

    def test_historical_sample_filters_and_preserves_external_capture_time(self):
        source = self.root / 'day.tar.xz'
        write_tar(
            source,
            [
                ('gtfsrt_readme.md', b'Public archive'),
                ('nycsubway_alerts_20261103T120000.000Z_abcd.gtfsrt', packet()),
                ('nycsubway_ACE_20261103T120000.000Z_abcd.gtfsrt', packet()),
                ('nycsubway_G_20261103T120000.000Z_abcd.gtfsrt', packet()),
                ('nycsubway_ACE_20261103T130000.000Z_abcd.gtfsrt', packet()),
            ],
        )
        manifest = import_source(source, self.dataset, 'subwaydata', 'ace', 12)
        self.assertEqual(manifest['counts']['captures'], 1)
        with connection(self.root / 'temp') as db:
            dataset_views(db, self.dataset)
            captured, received, source_kind = db.execute(
                'SELECT captured_at, received_at, source_kind FROM captures'
            ).fetchone()
        self.assertEqual(captured.timestamp(), SECONDS)
        self.assertIsNone(received)
        self.assertEqual(source_kind, 'subwaydata.nyc')

    def test_tar_paths_links_and_oversize_members_are_rejected_without_extraction(self):
        source = self.root / 'day.tar.xz'
        write_tar(source, [('../escape', b'bad')])
        with self.assertRaises(ValueError):
            list(historical_captures(source))
        with tarfile.open(source, 'w:xz') as target:
            info = tarfile.TarInfo('symlink')
            info.type = tarfile.SYMTYPE
            info.linkname = '/tmp/escape'
            target.addfile(info)
        with self.assertRaises(ValueError):
            list(historical_captures(source))
        write_tar(source, [('oversize', bytes(1024**2 + 1))])
        with self.assertRaises(ValueError):
            list(historical_captures(source))

    def test_only_sealed_capture_parts_are_processed(self):
        path = self.root / 'part.ndjson.gz.open'
        write_raw(path, [row(packet())])
        with self.assertRaises(ValueError):
            list(live_captures(path))

    def test_invalid_capture_envelope_types_are_rejected(self):
        for bad in [
            [],
            {**row(packet()), 'version': True},
            {**row(packet()), 'feed_id': []},
            {**row(packet()), 'outcome': {}},
        ]:
            write_raw(self.raw, [bad])
            with self.assertRaises(ValueError):
                list(live_captures(self.raw))


class DownloadBoundaryTests(unittest.TestCase):
    def test_full_download_cache_is_rejected_before_network_access(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'existing').write_bytes(b'full')
            with self.assertRaisesRegex(ValueError, 'capacity'):
                fetch_day('2026-11-03', directory, max_cache_bytes=1)

    def test_exact_source_registry(self):
        self.assertTrue(
            approved_url(
                'https://subwaydata.nyc/data/subwaydatanyc_2026-11-03_gtfsrt.tar.xz', '2026-11-03'
            )
        )
        self.assertTrue(
            approved_url(
                'https://data.subwaydata.nyc/2026-11/subwaydatanyc_2026-11-03_gtfsrt_0123456789ab.tar.xz',
                '2026-11-03',
            )
        )
        for url in [
            'https://localhost/file',
            'https://subwaydata.nyc.evil.test/file',
            'http://subwaydata.nyc/file',
            'https://user:secret@subwaydata.nyc/file',
            'https://subwaydata.nyc:8443/file',
            'https://data.subwaydata.nyc/../file',
        ]:
            self.assertFalse(approved_url(url, '2026-11-03'))

    def test_private_dns_addresses_never_reach_tls(self):
        with patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaises(ValueError):
                PublicHTTPSConnection('subwaydata.nyc').connect()


if __name__ == '__main__':
    unittest.main()
