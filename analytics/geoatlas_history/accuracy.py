"""Evaluate forecasts against feed-reported stop transitions, with timing uncertainty."""

from datetime import date, datetime, timezone
from math import sqrt
from pathlib import Path

from . import VERSION
from .captures import FEEDS
from .pipeline import connection, dataset_views, rows, sql_string

MAX_ARRIVAL_WINDOW_SECONDS = 90


def arrival_evaluation_tables(db, route):
    """Materialize one route at a time within the existing DuckDB resource limits."""
    route = sql_string(route)
    db.execute(f"""
        CREATE OR REPLACE TEMP TABLE accuracy_vehicle_states AS
        WITH checked AS (
            SELECT v.feed_id,v.trip_key,v.stop_id,v.association,v.published_at,v.observation_id,
                   v.service_date IS NOT NULL AND v.stop_id IS NOT NULL
                   AND v.association IN (0,1,2)
                   AND NOT EXISTS (SELECT 1 FROM accuracy_conflicts c
                       WHERE c.feed_id=v.feed_id AND c.published_at=v.published_at)
                   AND EXISTS (SELECT 1 FROM captures c
                       WHERE c.capture_id=v.capture_id AND c.outcome!='rejected')
                   AND count(*) OVER (PARTITION BY v.feed_id,v.trip_key,v.published_at)=1 AS usable
            FROM vehicles v WHERE route_id={route}
        )
        SELECT *, lag(stop_id) OVER w previous_stop,
               lag(association) OVER w previous_status,
               lag(published_at) OVER w previous_publication,
               lag(observation_id) OVER w previous_observation_id,
               lag(usable) OVER w previous_usable
        FROM checked
        WINDOW w AS (PARTITION BY feed_id,trip_key ORDER BY published_at,observation_id)
    """)
    db.execute("""
        CREATE OR REPLACE TEMP TABLE accuracy_stop_events AS
        SELECT *, count(*) OVER (PARTITION BY feed_id,trip_key,stop_id) AS stop_visits
        FROM accuracy_vehicle_states
        WHERE association=1 AND (
            previous_status IS DISTINCT FROM 1 OR previous_stop IS DISTINCT FROM stop_id
            OR NOT coalesce(previous_usable,false)
        )
    """)
    db.execute(f"""
        CREATE OR REPLACE TEMP TABLE accuracy_arrivals AS
        SELECT feed_id,trip_key,stop_id,
               previous_observation_id AS previous_vehicle_observation_id,
               observation_id AS stopped_vehicle_observation_id,
               previous_publication AS arrival_window_start,
               published_at AS arrival_window_end,
               epoch(published_at)-epoch(previous_publication) AS window_seconds
        FROM accuracy_stop_events
        WHERE usable AND previous_usable AND previous_status IN (0,2)
            AND stop_id=previous_stop AND stop_visits=1
            AND epoch(published_at)-epoch(previous_publication)
                BETWEEN 1 AND {MAX_ARRIVAL_WINDOW_SECONDS}
    """)
    db.execute(f"""
        CREATE OR REPLACE TEMP TABLE accuracy_predictions AS
        SELECT p.feed_id,p.trip_key,p.trip_id,p.stop_id,p.observation_id,p.published_at,p.predicted_at,
               p.service_date IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM accuracy_conflicts c
                   WHERE c.feed_id=p.feed_id AND c.published_at=p.published_at)
               AND EXISTS (SELECT 1 FROM captures c
                   WHERE c.capture_id=p.capture_id AND c.outcome!='rejected')
               AND count(*) OVER (
                   PARTITION BY p.feed_id,p.trip_key,p.stop_id,p.publication_id
               )=1 AS eligible
        FROM predictions p WHERE route_id={route} AND prediction_kind='arrival'
    """)
    db.execute("""
        CREATE OR REPLACE TEMP TABLE accuracy_comparisons AS
        WITH matched AS (
            SELECT p.*,a.arrival_window_start,a.arrival_window_end,a.window_seconds,
                   a.previous_vehicle_observation_id,a.stopped_vehicle_observation_id,
                   epoch(a.arrival_window_start)-epoch(p.predicted_at) AS signed_error_seconds_min,
                   epoch(a.arrival_window_end)-epoch(p.predicted_at) AS signed_error_seconds_max,
                   epoch(a.arrival_window_end)-epoch(p.published_at) AS horizon_seconds
            FROM accuracy_predictions p JOIN accuracy_arrivals a USING(feed_id,trip_key,stop_id)
            WHERE p.eligible AND p.published_at<=a.arrival_window_start
        )
        SELECT *,
               CASE WHEN predicted_at BETWEEN arrival_window_start AND arrival_window_end THEN 0
                    ELSE least(abs(signed_error_seconds_min),abs(signed_error_seconds_max))
               END AS absolute_error_seconds_min,
               greatest(abs(signed_error_seconds_min),abs(signed_error_seconds_max))
                   AS absolute_error_seconds_max,
               CASE WHEN horizon_seconds<=120 THEN '0-2 minutes'
                    WHEN horizon_seconds<=300 THEN '2-5 minutes'
                    WHEN horizon_seconds<=600 THEN '5-10 minutes'
                    ELSE '10+ minutes' END AS forecast_horizon
        FROM matched
    """)


def forecast_metrics(db):
    metrics = rows(
        db,
        """
        WITH arrival_groups AS (
            SELECT forecast_horizon,feed_id,trip_key,stop_id,count(*) AS forecasts,
                   var_pop((signed_error_seconds_min+signed_error_seconds_max)/2)
                       AS within_variance,
                   max(window_seconds/2) AS radius
            FROM accuracy_comparisons GROUP BY ALL
        ), uncertainty AS (
            SELECT forecast_horizon,
                   sum(forecasts*within_variance)/sum(forecasts) AS within_variance,
                   CASE WHEN count(*)=1 THEN 0
                        ELSE sqrt(sum(forecasts*radius*radius)/sum(forecasts))
                   END AS radius
            FROM arrival_groups GROUP BY forecast_horizon
        )
        SELECT forecast_horizon,count(*) AS comparisons,
               count(DISTINCT (feed_id,trip_key,stop_id)) AS arrivals,
               round(avg(window_seconds),2) AS mean_arrival_window_seconds,
               round(avg(absolute_error_seconds_min),2) AS mean_absolute_error_seconds_min,
               round(avg(absolute_error_seconds_max),2) AS mean_absolute_error_seconds_max,
               round(quantile_cont(absolute_error_seconds_min,0.5),2)
                   AS median_absolute_error_seconds_min,
               round(quantile_cont(absolute_error_seconds_max,0.5),2)
                   AS median_absolute_error_seconds_max,
               round(avg(signed_error_seconds_min),2) AS mean_signed_error_seconds_min,
               round(avg(signed_error_seconds_max),2) AS mean_signed_error_seconds_max,
               round(quantile_cont(absolute_error_seconds_min,0.95),2)
                   AS p95_absolute_error_seconds_min,
               round(quantile_cont(absolute_error_seconds_max,0.95),2)
                   AS p95_absolute_error_seconds_max,
               round(100*avg((absolute_error_seconds_max<=60)::INTEGER),2)
                   AS within_60_seconds_pct_min,
               round(100*avg((absolute_error_seconds_min<=60)::INTEGER),2)
                   AS within_60_seconds_pct_max,
               var_pop((signed_error_seconds_min+signed_error_seconds_max)/2)
                   AS midpoint_variance,
               any_value(u.within_variance) AS within_variance,
               any_value(u.radius) AS radius
        FROM accuracy_comparisons JOIN uncertainty u USING(forecast_horizon)
        GROUP BY forecast_horizon ORDER BY min(horizon_seconds)
    """,
    )
    for metric in metrics:
        within_variance = metric.pop('within_variance')
        between_stddev = sqrt(max(0, metric.pop('midpoint_variance') - within_variance))
        radius = metric.pop('radius')
        # One arrival's timing shift affects all its forecasts equally, leaving
        # within-arrival variance unchanged. Only the between-arrival part varies.
        # Centering cannot increase the norm of the shifts, whose weighted RMS
        # is bounded by radius. The triangle inequality gives conservative bounds.
        variance_min = within_variance + max(0, between_stddev - radius) ** 2
        variance_max = within_variance + (between_stddev + radius) ** 2
        metric.update(
            signed_error_variance_seconds_squared_min=round(variance_min, 2),
            signed_error_variance_seconds_squared_max=round(variance_max, 2),
            signed_error_stddev_seconds_min=round(sqrt(variance_min), 2),
            signed_error_stddev_seconds_max=round(sqrt(variance_max), 2),
        )
    return metrics


def evaluate_accuracy(root, capture_date=None, feed=None):
    if capture_date is not None and date.fromisoformat(capture_date).isoformat() != capture_date:
        raise ValueError('Expected UTC capture date YYYY-MM-DD')
    if feed is not None and feed not in FEEDS:
        raise ValueError('Unknown feed filter')
    with connection(Path(root) / '.accuracy-spill') as db:
        dataset_views(db, root, capture_date, feed)
        db.execute("""
            CREATE TEMP VIEW accuracy_conflicts AS
            SELECT feed_id,published_at FROM captures WHERE published_at IS NOT NULL
            GROUP BY ALL HAVING count(DISTINCT payload_sha256)>1
        """)
        routes = db.execute(
            'SELECT route_id FROM predictions_raw UNION SELECT route_id FROM vehicles_raw ORDER BY 1'
        ).fetchall()
        coverage, metrics, samples = [], [], []
        for (route,) in routes:
            arrival_evaluation_tables(db, route)
            counts = rows(
                db,
                """
                SELECT count(*) AS arrival_predictions,
                       count(*) FILTER (WHERE eligible) AS eligible_arrival_predictions,
                       (SELECT count(*) FROM accuracy_arrivals) AS usable_arrival_windows,
                       (SELECT count(*) FROM accuracy_comparisons) AS matched_predictions,
                       (SELECT count(DISTINCT (feed_id,trip_key,stop_id))
                           FROM accuracy_comparisons) AS matched_arrivals,
                       (SELECT count(DISTINCT (feed_id,trip_key,stop_id))
                           FROM accuracy_stop_events) AS stops_with_stopped_reports
                FROM accuracy_predictions
            """,
            )[0]
            eligible = counts['eligible_arrival_predictions']
            counts['excluded_arrival_predictions'] = counts['arrival_predictions'] - eligible
            counts['unmatched_eligible_predictions'] = eligible - counts['matched_predictions']
            counts['coverage_pct'] = (
                round(100 * counts['matched_predictions'] / eligible, 2) if eligible else None
            )
            coverage.append({'route_id': route, **counts})
            metrics.extend({'route_id': route, **item} for item in forecast_metrics(db))
            if len(samples) < 20:
                samples.extend(
                    {'route_id': route, **item}
                    for item in rows(
                        db,
                        f"""
                    SELECT observation_id,trip_id,stop_id,
                           previous_vehicle_observation_id,stopped_vehicle_observation_id,
                           cast(published_at AS VARCHAR) AS published_at,
                           cast(predicted_at AS VARCHAR) AS predicted_at,
                           cast(arrival_window_start AS VARCHAR) AS arrival_window_start,
                           cast(arrival_window_end AS VARCHAR) AS arrival_window_end,
                           window_seconds,signed_error_seconds_min,signed_error_seconds_max,
                           absolute_error_seconds_min,absolute_error_seconds_max,forecast_horizon
                    FROM accuracy_comparisons ORDER BY published_at,observation_id
                    LIMIT {20 - len(samples)}
                """,
                    )
                )
        summary = {
            key: sum(item[key] for item in coverage)
            for key in (
                'arrival_predictions',
                'eligible_arrival_predictions',
                'excluded_arrival_predictions',
                'matched_predictions',
                'unmatched_eligible_predictions',
                'matched_arrivals',
                'usable_arrival_windows',
                'stops_with_stopped_reports',
            )
        }
        summary['coverage_pct'] = (
            round(100 * summary['matched_predictions'] / summary['eligible_arrival_predictions'], 2)
            if summary['eligible_arrival_predictions']
            else None
        )
        return {
            'schema_version': VERSION,
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'metric': 'arrival-field forecast discrepancy against inferred reported-stop windows',
            'reference': 'INCOMING_AT or IN_TRANSIT_TO followed by STOPPED_AT at the same stop',
            'prediction_target': {
                'field': 'StopTimeUpdate.arrival.time',
                'meaning': 'MTA arrival or transit time; this pipeline does not distinguish them',
                'reference': 'reported-stop proxy; event equivalence to physical arrival is not verified',
            },
            'limitations': [
                'Arrival windows bracket feed status changes, not independently measured physical arrivals.',
                'MTA arrival.time may represent transit time at intermediate stops; it may target a different event from STOPPED_AT.',
                'Error ranges assume the physical arrival occurred in that window; provider reporting lag is unknown.',
                'Vehicle movement timestamps and final predictions are not used as arrival truth.',
                'Only arrival-field forecasts published at or before the window starts are compared.',
                'Horizon is time from forecast publication to the first stopped report.',
                'Means and percentiles weight forecasts; multiple forecasts can refer to one arrival.',
                'Spread describes this finite forecast sample, not an independent sample of arrivals.',
                'Missing or ambiguous matches are excluded and remain visible in coverage counts.',
            ],
            'signed_error': 'reported-stop proxy minus arrival-field forecast; positive means the proxy is later',
            'percentile_method': 'continuous sample quantile with linear interpolation',
            'dispersion': {
                'definition': 'population variance and standard deviation of signed proxy discrepancies',
                'bounds': 'fixed within-arrival variance plus conservative bounds on between-arrival variance',
                'uncertainty': 'arrival-window bounds, not statistical confidence intervals',
            },
            'max_arrival_window_seconds': MAX_ARRIVAL_WINDOW_SECONDS,
            'time_zone': 'UTC',
            'selection': {'capture_date': capture_date, 'feed_id': feed},
            'summary': summary,
            'coverage': coverage,
            'accuracy_by_horizon': metrics,
            'sample_comparisons': samples,
        }
