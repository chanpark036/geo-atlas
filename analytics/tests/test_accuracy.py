from contextlib import redirect_stdout
import base64
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from google.transit import gtfs_realtime_pb2 as gtfs

from analytics.geoatlas_history.accuracy import evaluate_accuracy
from analytics.geoatlas_history.cli import main
from analytics.geoatlas_history.pipeline import import_source
from analytics.tests.test_pipeline import SECONDS, packet, row, write_raw


def observation(
    offset,
    prediction=60,
    status=gtfs.VehiclePosition.IN_TRANSIT_TO,
    outcome='changed',
    stop_id='A24S',
):
    message = gtfs.FeedMessage.FromString(packet(SECONDS + offset, SECONDS + (prediction or 0)))
    vehicle = message.entity[1].vehicle
    vehicle.stop_id = stop_id
    message.entity[0].trip_update.stop_time_update[0].stop_id = stop_id
    # A movement clock is deliberately unrelated to arrival. Evaluation must ignore it.
    vehicle.timestamp = SECONDS + 3600
    if status is None:
        vehicle.ClearField('current_stop_sequence')
    else:
        vehicle.current_status = status
    if prediction is None:
        del message.entity[0]
    return row(message.SerializeToString(), SECONDS + offset, outcome)


class AccuracyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.dataset = self.root / 'parquet'

    def report(self, captures):
        raw = self.root / 'part.ndjson.gz'
        write_raw(raw, captures)
        import_source(raw, self.dataset)
        return evaluate_accuracy(self.dataset)

    def test_error_ranges_cover_early_late_and_inside_window_forecasts(self):
        report = self.report(
            [
                observation(0, 60),
                observation(10, 25),
                observation(20, 15),
                observation(40, None, gtfs.VehiclePosition.STOPPED_AT),
            ]
        )
        coverage = report['coverage'][0]
        self.assertEqual(coverage['matched_predictions'], 3)
        self.assertEqual(coverage['matched_arrivals'], 1)
        self.assertEqual(coverage['coverage_pct'], 100)
        samples = report['sample_comparisons']
        self.assertEqual(
            [(s['signed_error_seconds_min'], s['signed_error_seconds_max']) for s in samples],
            [(-40, -20), (-5, 15), (5, 25)],
        )
        self.assertEqual(
            [(s['absolute_error_seconds_min'], s['absolute_error_seconds_max']) for s in samples],
            [(20, 40), (0, 15), (5, 25)],
        )
        metric = report['accuracy_by_horizon'][0]
        self.assertEqual(metric['mean_absolute_error_seconds_min'], 8.33)
        self.assertEqual(metric['mean_absolute_error_seconds_max'], 26.67)
        self.assertEqual(metric['median_absolute_error_seconds_min'], 5)
        self.assertEqual(metric['median_absolute_error_seconds_max'], 25)
        self.assertEqual(metric['mean_signed_error_seconds_min'], -13.33)
        self.assertEqual(metric['mean_signed_error_seconds_max'], 6.67)
        # All three forecasts share one arrival clock. Moving that clock changes
        # their common bias, but their population variance stays 372.22 seconds².
        self.assertEqual(metric['signed_error_variance_seconds_squared_min'], 372.22)
        self.assertEqual(metric['signed_error_variance_seconds_squared_max'], 372.22)
        self.assertEqual(metric['signed_error_stddev_seconds_min'], 19.29)
        self.assertEqual(metric['signed_error_stddev_seconds_max'], 19.29)
        self.assertEqual(metric['within_60_seconds_pct_min'], 100)

    def test_spread_accounts_for_different_arrivals_moving_in_opposite_directions(self):
        report = self.report(
            [
                observation(0, 15),
                observation(30, None, gtfs.VehiclePosition.STOPPED_AT),
                observation(60, 75, stop_id='A25S'),
                observation(90, None, gtfs.VehiclePosition.STOPPED_AT, stop_id='A25S'),
            ]
        )
        metric = report['accuracy_by_horizon'][0]
        self.assertEqual(metric['arrivals'], 2)
        # Each error is in [-15,15]. Both lower endpoints (or both upper
        # endpoints) have zero variance, but errors -15,+15 have variance 225.
        self.assertEqual(metric['signed_error_variance_seconds_squared_min'], 0)
        self.assertEqual(metric['signed_error_variance_seconds_squared_max'], 225)
        self.assertEqual(metric['signed_error_stddev_seconds_max'], 15)

    def test_uncertainty_does_not_erase_known_variation_within_each_arrival(self):
        report = self.report(
            [
                observation(0, 0),
                observation(10, 30),
                observation(20, None),
                observation(30, None, gtfs.VehiclePosition.STOPPED_AT),
                observation(60, 60, stop_id='A25S'),
                observation(70, 90, stop_id='A25S'),
                observation(80, None, stop_id='A25S'),
                observation(90, None, gtfs.VehiclePosition.STOPPED_AT, stop_id='A25S'),
            ]
        )
        metric = report['accuracy_by_horizon'][0]
        # Each pair is separated by 30 seconds, forcing within-arrival variance
        # 225. Different arrival clocks can add at most 25 in this fixture.
        self.assertEqual(metric['comparisons'], 4)
        self.assertEqual(metric['signed_error_variance_seconds_squared_min'], 225)
        self.assertEqual(metric['signed_error_variance_seconds_squared_max'], 250)
        self.assertEqual(metric['signed_error_stddev_seconds_min'], 15)
        self.assertEqual(metric['signed_error_stddev_seconds_max'], 15.81)

    def test_forecasts_during_or_after_arrival_are_not_scored(self):
        report = self.report(
            [
                observation(0),
                observation(30, 50, gtfs.VehiclePosition.STOPPED_AT),
                observation(60, 55, gtfs.VehiclePosition.STOPPED_AT),
            ]
        )
        coverage = report['coverage'][0]
        self.assertEqual(coverage['eligible_arrival_predictions'], 3)
        self.assertEqual(coverage['matched_predictions'], 1)
        self.assertEqual(coverage['unmatched_eligible_predictions'], 2)
        self.assertEqual(coverage['usable_arrival_windows'], 1)
        self.assertEqual(report['summary']['coverage_pct'], 33.33)

    def test_a_threshold_crossing_window_does_not_claim_certain_accuracy(self):
        report = self.report(
            [
                observation(0, 75),
                observation(30, None, gtfs.VehiclePosition.STOPPED_AT),
            ]
        )
        metric = report['accuracy_by_horizon'][0]
        self.assertEqual(metric['mean_absolute_error_seconds_min'], 45)
        self.assertEqual(metric['mean_absolute_error_seconds_max'], 75)
        self.assertEqual(metric['within_60_seconds_pct_min'], 0)
        self.assertEqual(metric['within_60_seconds_pct_max'], 100)
        self.assertEqual(metric['signed_error_stddev_seconds_min'], 0)
        self.assertEqual(metric['signed_error_stddev_seconds_max'], 0)

    def test_repeated_snapshots_and_overlapping_batches_do_not_inflate_accuracy(self):
        captures = [observation(0), observation(30, None, gtfs.VehiclePosition.STOPPED_AT)]
        first_report = self.report(captures)
        raw = self.root / 'overlap.ndjson.gz'
        repeated = row(base64.b64decode(captures[0]['payload_base64']), SECONDS + 2)
        write_raw(raw, [repeated, captures[1]])
        import_source(raw, self.dataset)
        report = evaluate_accuracy(self.dataset)
        self.assertEqual(report['coverage'][0]['matched_predictions'], 1)
        self.assertEqual(report['coverage'][0]['matched_arrivals'], 1)
        self.assertEqual(report['accuracy_by_horizon'], first_report['accuracy_by_horizon'])

    def test_missing_arrival_evidence_produces_zero_coverage_not_zero_error(self):
        for captures in [
            [observation(0)],
            [observation(0, status=gtfs.VehiclePosition.STOPPED_AT)],
            [observation(0), observation(120, None, gtfs.VehiclePosition.STOPPED_AT)],
            [observation(0, status=None), observation(30, None, gtfs.VehiclePosition.STOPPED_AT)],
        ]:
            with self.subTest(captures=captures):
                with tempfile.TemporaryDirectory() as directory:
                    raw = Path(directory) / 'part.ndjson.gz'
                    dataset = Path(directory) / 'parquet'
                    write_raw(raw, captures)
                    import_source(raw, dataset)
                    report = evaluate_accuracy(dataset)
                    self.assertEqual(report['coverage'][0]['matched_predictions'], 0)
                    self.assertEqual(report['accuracy_by_horizon'], [])

    def test_different_stop_and_repeated_stop_visits_are_not_matched(self):
        stopped = observation(30, None, gtfs.VehiclePosition.STOPPED_AT, stop_id='A25S')
        report = self.report([observation(0), stopped])
        self.assertEqual(report['coverage'][0]['matched_predictions'], 0)

        raw = self.root / 'visits.ndjson.gz'
        write_raw(
            raw,
            [
                observation(60),
                observation(90, None, gtfs.VehiclePosition.STOPPED_AT),
                observation(120),
                observation(150, None, gtfs.VehiclePosition.STOPPED_AT),
            ],
        )
        import_source(raw, self.dataset)
        report = evaluate_accuracy(self.dataset)
        self.assertEqual(report['coverage'][0]['matched_predictions'], 0)

    def test_conflicting_or_live_rejected_arrival_evidence_is_excluded(self):
        for captures in [
            [
                observation(0, outcome='rejected'),
                observation(30, None, gtfs.VehiclePosition.STOPPED_AT),
            ],
            [observation(0), observation(30, None, gtfs.VehiclePosition.STOPPED_AT, 'rejected')],
            [
                observation(0, 60),
                observation(0, 90),
                observation(30, None, gtfs.VehiclePosition.STOPPED_AT),
            ],
        ]:
            with self.subTest(captures=captures):
                with tempfile.TemporaryDirectory() as directory:
                    raw = Path(directory) / 'part.ndjson.gz'
                    dataset = Path(directory) / 'parquet'
                    write_raw(raw, captures)
                    import_source(raw, dataset)
                    self.assertEqual(
                        evaluate_accuracy(dataset)['coverage'][0]['matched_predictions'], 0
                    )

    def test_metrics_are_separated_by_forecast_horizon(self):
        report = self.report(
            [
                observation(-601, 610),
                observation(0, 610),
                observation(450, 610),
                observation(570, 610),
                observation(600, None, gtfs.VehiclePosition.STOPPED_AT),
            ]
        )
        self.assertEqual(
            {item['forecast_horizon'] for item in report['accuracy_by_horizon']},
            {'0-2 minutes', '2-5 minutes', '5-10 minutes', '10+ minutes'},
        )

    def test_ambiguous_forecasts_for_two_occurrences_of_one_station_are_excluded(self):
        message = gtfs.FeedMessage.FromString(base64.b64decode(observation(0)['payload_base64']))
        stop = message.entity[0].trip_update.stop_time_update.add(stop_id='A24S', stop_sequence=2)
        stop.arrival.time = SECONDS + 90
        report = self.report(
            [
                row(message.SerializeToString()),
                observation(30, None, gtfs.VehiclePosition.STOPPED_AT),
            ]
        )
        self.assertEqual(report['coverage'][0]['arrival_predictions'], 2)
        self.assertEqual(report['coverage'][0]['eligible_arrival_predictions'], 0)
        self.assertEqual(report['coverage'][0]['usable_arrival_windows'], 1)
        self.assertEqual(report['accuracy_by_horizon'], [])

    def test_departure_predictions_are_not_compared_with_arrivals(self):
        message = gtfs.FeedMessage.FromString(base64.b64decode(observation(0)['payload_base64']))
        message.entity[0].trip_update.stop_time_update[0].departure.time = SECONDS + 90
        report = self.report(
            [
                row(message.SerializeToString()),
                observation(30, None, gtfs.VehiclePosition.STOPPED_AT),
            ]
        )
        self.assertEqual(report['coverage'][0]['arrival_predictions'], 1)
        self.assertEqual(report['coverage'][0]['matched_predictions'], 1)

    def test_missing_service_dates_cannot_match_trips_across_days(self):
        captures = []
        for original in [observation(0), observation(30, None, gtfs.VehiclePosition.STOPPED_AT)]:
            message = gtfs.FeedMessage.FromString(base64.b64decode(original['payload_base64']))
            for entity in message.entity:
                body = entity.trip_update if entity.HasField('trip_update') else entity.vehicle
                body.trip.ClearField('start_date')
            captures.append(row(message.SerializeToString()))
        report = self.report(captures)
        self.assertEqual(report['coverage'][0]['eligible_arrival_predictions'], 0)
        self.assertEqual(report['coverage'][0]['matched_predictions'], 0)

    def test_empty_selection_has_no_fabricated_metrics_and_cli_writes_report(self):
        self.report([observation(0), observation(30, None, gtfs.VehiclePosition.STOPPED_AT)])
        report = evaluate_accuracy(self.dataset, '2026-11-04', 'g')
        self.assertEqual(report['coverage'], [])
        self.assertEqual(report['accuracy_by_horizon'], [])
        self.assertIsNone(report['summary']['coverage_pct'])
        output = self.root / 'accuracy.json'
        with (
            patch(
                'sys.argv',
                ['history', 'accuracy', '--dataset', str(self.dataset), '--output', str(output)],
            ),
            redirect_stdout(io.StringIO()),
        ):
            main()
        saved = json.loads(output.read_text())
        self.assertEqual(saved['coverage'][0]['matched_predictions'], 1)
        self.assertIn('inferred', saved['metric'])


if __name__ == '__main__':
    unittest.main()
