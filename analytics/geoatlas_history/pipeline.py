"""Atomic, content-addressed Parquet batches and reproducible DuckDB reports."""

from contextlib import contextmanager
import csv
from datetime import date, datetime, timezone
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import time
import uuid

import duckdb
from google.protobuf.message import DecodeError

from . import VERSION
from .captures import FEEDS, fingerprint, historical_captures, live_captures
from .normalize import normalize

SCHEMAS = {
    'captures': {
        'capture_id': 'VARCHAR',
        'feed_id': 'VARCHAR',
        'source_kind': 'VARCHAR',
        'captured_at': 'TIMESTAMPTZ',
        'received_at': 'TIMESTAMPTZ',
        'imported_at': 'TIMESTAMPTZ',
        'published_at': 'TIMESTAMPTZ',
        'payload_sha256': 'VARCHAR',
        'raw_bytes': 'BIGINT',
        'outcome': 'VARCHAR',
        'decode_status': 'VARCHAR',
        'capture_date': 'DATE',
    },
    'predictions': {
        'observation_id': 'VARCHAR',
        'publication_id': 'VARCHAR',
        'capture_id': 'VARCHAR',
        'feed_id': 'VARCHAR',
        'route_id': 'VARCHAR',
        'trip_key': 'VARCHAR',
        'trip_id': 'VARCHAR',
        'service_date': 'DATE',
        'stop_id': 'VARCHAR',
        'stop_sequence': 'BIGINT',
        'prediction_kind': 'VARCHAR',
        'published_at': 'TIMESTAMPTZ',
        'predicted_at': 'TIMESTAMPTZ',
        'capture_date': 'DATE',
        'captured_at': 'TIMESTAMPTZ',
    },
    'vehicles': {
        'observation_id': 'VARCHAR',
        'publication_id': 'VARCHAR',
        'capture_id': 'VARCHAR',
        'feed_id': 'VARCHAR',
        'route_id': 'VARCHAR',
        'trip_key': 'VARCHAR',
        'trip_id': 'VARCHAR',
        'service_date': 'DATE',
        'stop_id': 'VARCHAR',
        'association': 'BIGINT',
        'published_at': 'TIMESTAMPTZ',
        'last_movement_at': 'TIMESTAMPTZ',
        'capture_date': 'DATE',
        'captured_at': 'TIMESTAMPTZ',
    },
}


def sql_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def connection(temp):
    db = duckdb.connect(
        config={
            'memory_limit': '256MB',
            'threads': '2',
            'max_temp_directory_size': '512MB',
            'temp_directory': str(temp),
        }
    )
    db.execute("SET TimeZone='UTC'")
    return db


@contextmanager
def dataset_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.writer.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def verified_manifest(batch):
    metadata = batch / 'manifest.json'
    if metadata.is_symlink() or metadata.stat().st_size > 1024**2:
        raise ValueError('Invalid batch manifest')
    manifest = json.loads(metadata.read_text())
    if manifest['batch_id'] != batch.name:
        raise ValueError('Batch identity mismatch')
    for item in manifest['files']:
        path = batch / item['path']
        if (
            path.is_symlink()
            or not path.resolve().is_relative_to(batch.resolve())
            or fingerprint(path) != item['sha256']
        ):
            raise ValueError('Completed Parquet batch is missing or corrupt')
    return manifest


def clean_interrupted_work(output):
    # The exclusive writer lock proves these owned staging directories are no
    # longer active. Preserve unknown directories rather than guessing ownership.
    for work in (output / '.pending').glob('*'):
        marker = work / '.geoatlas-pending'
        if work.is_symlink() or not work.is_dir() or not marker.is_file() or marker.is_symlink():
            continue
        if marker.stat().st_size < 1024 and marker.read_text() == 'geoatlas-history\n':
            shutil.rmtree(work)


def import_source(
    path,
    output,
    kind='live',
    feed=None,
    hour=None,
    max_rows=2_000_000,
    max_dataset_bytes=4 * 1024**3,
):
    path, output = Path(path), Path(output)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 128 * 1024**2:
        raise ValueError('Invalid or oversized source file')
    if not 1 <= max_rows <= 10_000_000:
        raise ValueError('Invalid row budget')
    if not 1 <= max_dataset_bytes <= 100 * 1024**3:
        raise ValueError('Invalid dataset byte budget')
    source_hash = fingerprint(path)
    selection = {
        'version': VERSION,
        'source_sha256': source_hash,
        'kind': kind,
        'feed': feed,
        'hour': hour,
    }
    batch_id = hashlib.sha256(json.dumps(selection, sort_keys=True).encode()).hexdigest()
    target = output / 'batches' / batch_id
    with dataset_lock(output):
        clean_interrupted_work(output)
        if target.exists():
            return {**verified_manifest(target), 'skipped': True}
        started = time.perf_counter()
        work = output / '.pending' / str(uuid.uuid4())
        stage = work / 'stage'
        complete = work / 'complete'
        stage.mkdir(parents=True)
        (work / '.geoatlas-pending').write_text('geoatlas-history\n')
        complete.mkdir()
        counts = dict.fromkeys(SCHEMAS, 0)
        counts.update(raw_bytes=0, invalid_packets=0, fetch_errors=0)
        handles = {name: (stage / f'{name}.csv').open('w', newline='') for name in SCHEMAS}
        writers = {name: csv.writer(handle) for name, handle in handles.items()}
        for name, writer in writers.items():
            writer.writerow(SCHEMAS[name])
        imported = datetime.now(timezone.utc)
        try:
            scan_stats = {}
            source = (
                live_captures(path)
                if kind == 'live'
                else historical_captures(path, feed, hour, scan_stats)
            )
            for capture in source:
                if counts['captures'] >= 200_000:
                    raise ValueError('Capture budget exceeded')
                published, predictions, vehicles = None, [], []
                status = 'fetch_error' if capture.payload is None else 'ok'
                try:
                    published, predictions, vehicles = normalize(capture)
                except (ValueError, DecodeError, OverflowError):
                    status = 'invalid'
                counts['invalid_packets'] += status == 'invalid'
                counts['fetch_errors'] += status == 'fetch_error'
                raw_bytes = len(capture.payload or b'')
                counts['raw_bytes'] += raw_bytes
                writers['captures'].writerow(
                    [
                        capture.capture_id,
                        capture.feed_id,
                        capture.source_kind,
                        capture.captured_at,
                        capture.received_at,
                        imported,
                        published,
                        hashlib.sha256(capture.payload).hexdigest()
                        if capture.payload is not None
                        else None,
                        raw_bytes,
                        capture.outcome,
                        status,
                        capture.captured_at.date(),
                    ]
                )
                writers['predictions'].writerows(predictions)
                writers['vehicles'].writerows(vehicles)
                counts['captures'] += 1
                counts['predictions'] += len(predictions)
                counts['vehicles'] += len(vehicles)
                if counts['predictions'] + counts['vehicles'] > max_rows:
                    raise ValueError(
                        'Observation budget exceeded; import a smaller feed/hour selection'
                    )
                if sum(handle.tell() for handle in handles.values()) > 512 * 1024**2:
                    raise ValueError('Staging budget exceeded')
            for handle in handles.values():
                handle.close()
            counts.update(scan_stats)
            if fingerprint(path) != source_hash:
                raise ValueError('Source changed during conversion')
            with connection(work / 'spill') as db:
                for name, schema in SCHEMAS.items():
                    if not counts[name]:
                        continue
                    columns = (
                        '{'
                        + ','.join(
                            f'{sql_string(key)}:{sql_string(value)}'
                            for key, value in schema.items()
                        )
                        + '}'
                    )
                    db.execute(
                        f"""COPY (SELECT * FROM read_csv(?, header=true, columns={columns}))
                            TO {sql_string(complete / name)}
                            (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (feed_id, capture_date))""",
                        [str(stage / f'{name}.csv')],
                    )
            files = [
                {
                    'path': str(file.relative_to(complete)),
                    'sha256': fingerprint(file),
                    'bytes': file.stat().st_size,
                }
                for file in sorted(complete.rglob('*.parquet'))
            ]
            existing = list((output / 'batches').rglob('*.parquet'))
            if (
                len(existing) > 100_000
                or sum(file.stat().st_size for file in existing)
                + sum(file['bytes'] for file in files)
                > max_dataset_bytes
            ):
                raise ValueError('Parquet dataset capacity exceeded')
            manifest = {
                **selection,
                'batch_id': batch_id,
                'source_bytes': path.stat().st_size,
                'counts': counts,
                'elapsed_seconds': round(time.perf_counter() - started, 4),
                'files': files,
            }
            (complete / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            target.parent.mkdir(exist_ok=True)
            complete.rename(target)
            return {**manifest, 'skipped': False}
        finally:
            for handle in handles.values():
                handle.close()
            shutil.rmtree(work, ignore_errors=True)


def dataset_views(db, root, capture_date=None, feed=None):
    root = Path(root)
    batches = []
    for batch in sorted((root / 'batches').glob('*')):
        if batch.is_symlink():
            raise ValueError('Dataset cannot include symlinked batches')
        if batch.is_dir() and (batch / 'manifest.json').is_file():
            manifest = verified_manifest(batch)
            if manifest['version'] == VERSION:
                batches.append((batch, manifest))
    for name, schema in SCHEMAS.items():
        files = []
        for batch, manifest in batches:
            files.extend(
                str(batch / item['path'])
                for item in manifest['files']
                if Path(item['path']).parts[0] == name
                and (
                    capture_date is None
                    or f'capture_date={capture_date}' in Path(item['path']).parts
                )
                and (feed is None or f'feed_id={feed}' in Path(item['path']).parts)
            )
        if len(files) > 100_000:
            raise ValueError('Dataset file count exceeds bounds')
        if files:
            key = 'capture_id' if name == 'captures' else 'observation_id,route_id'
            # Repeated publications remain separate capture evidence. Their
            # identical observations have one canonical analytical identity.
            db.from_parquet(files, hive_partitioning=True, union_by_name=True).create_view(
                f'{name}_raw'
            )
            db.execute(
                f'CREATE VIEW {name} AS SELECT * FROM {name}_raw QUALIFY row_number() OVER (PARTITION BY {key} ORDER BY captured_at,capture_id)=1'
            )
        else:
            fields = ','.join(
                f'CAST(NULL AS {kind}) AS {column}' for column, kind in schema.items()
            )
            db.execute(f'CREATE VIEW {name}_raw AS SELECT {fields} WHERE false')
            db.execute(f'CREATE VIEW {name} AS SELECT * FROM {name}_raw')


def rows(db, sql, parameters=None):
    result = db.execute(sql, parameters)
    columns = [column[0] for column in result.description]
    return [dict(zip(columns, row)) for row in result.fetchall()]


def analyze(root, capture_date=None, feed=None):
    root = Path(root)
    if capture_date is not None and date.fromisoformat(capture_date).isoformat() != capture_date:
        raise ValueError('Expected UTC capture date YYYY-MM-DD')
    if feed is not None and feed not in FEEDS:
        raise ValueError('Unknown feed filter')
    with connection(root / '.query-spill') as db:
        dataset_views(db, root, capture_date, feed)
        db.execute(
            'CREATE VIEW conflicts AS SELECT feed_id, published_at FROM captures WHERE published_at IS NOT NULL GROUP BY ALL HAVING count(DISTINCT payload_sha256)>1'
        )
        summary = rows(
            db,
            """
            SELECT count(*) AS captures,
                   count(*) FILTER (WHERE decode_status='invalid') AS invalid_packets,
                   count(*) FILTER (WHERE decode_status='fetch_error') AS fetch_errors,
                   count(*) FILTER (WHERE outcome='rejected') AS live_rejected_captures,
                   coalesce(sum(raw_bytes),0)::BIGINT AS captured_payload_bytes,
                   count(*) FILTER (WHERE epoch(captured_at)-epoch(published_at)>120) AS stale_publications,
                   count(*) FILTER (WHERE epoch(published_at)-epoch(captured_at)>60) AS future_publications
            FROM captures
        """,
        )[0]
        summary['prediction_observations'] = db.execute(
            'SELECT count(DISTINCT observation_id) FROM predictions_raw'
        ).fetchone()[0]
        summary['vehicle_observations'] = db.execute(
            'SELECT count(DISTINCT observation_id) FROM vehicles_raw'
        ).fetchone()[0]
        summary['conflicting_publications'] = db.execute(
            'SELECT count(*) FROM conflicts'
        ).fetchone()[0]
        summary['repeated_publications'] = db.execute(
            'SELECT coalesce(sum(n-1),0)::BIGINT FROM (SELECT count(*) n FROM captures WHERE published_at IS NOT NULL GROUP BY feed_id,published_at,payload_sha256)'
        ).fetchone()[0]
        quality = rows(
            db,
            """
            WITH ordered AS (
                SELECT *, max(published_at) OVER (
                    PARTITION BY feed_id ORDER BY captured_at,capture_id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) previous
                FROM captures WHERE published_at IS NOT NULL
            )
            SELECT feed_id, count(*) AS captures,
                   cast(min(captured_at) AS VARCHAR) AS first_capture_at,
                   cast(max(captured_at) AS VARCHAR) AS last_capture_at,
                   count(*) FILTER (WHERE published_at < previous) AS out_of_order_publications,
                   count(*) FILTER (WHERE epoch(published_at)-epoch(previous)>90) AS publication_gaps_over_90s
            FROM ordered GROUP BY feed_id ORDER BY feed_id
        """,
        )
        revision_sql = """
            WITH eligible AS (
                SELECT p.route_id,p.trip_key,p.stop_id,p.stop_sequence,p.prediction_kind,
                       p.publication_id,p.observation_id,p.published_at,p.predicted_at
                FROM predictions p ANTI JOIN conflicts c USING(feed_id,published_at)
                WHERE p.route_id=? AND service_date IS NOT NULL
                  AND EXISTS (SELECT 1 FROM captures a WHERE a.capture_id=p.capture_id AND a.outcome!='rejected')
                QUALIFY count(*) OVER (
                    PARTITION BY trip_key,stop_id,stop_sequence,prediction_kind,publication_id
                )=1
            ), ordered AS (
                SELECT p.*, lag(predicted_at) OVER w previous_prediction,
                       lag(published_at) OVER w previous_publication
                FROM eligible p
                WINDOW w AS (PARTITION BY trip_key,stop_id,stop_sequence,prediction_kind ORDER BY published_at,publication_id,observation_id)
            ), changes AS (
                SELECT *, abs(epoch(predicted_at)-epoch(previous_prediction)) change_seconds
                FROM ordered WHERE epoch(published_at)-epoch(previous_publication) BETWEEN 1 AND 90
            )
            SELECT route_id, extract(hour FROM published_at)::INTEGER AS publication_hour_utc,
                   count(*) AS comparisons,
                   count(*) FILTER (WHERE change_seconds>0) AS revised_predictions,
                   round(avg(change_seconds),2) AS mean_absolute_revision_seconds,
                   round(quantile_cont(change_seconds,0.95),2) AS p95_absolute_revision_seconds
            FROM changes GROUP BY ALL ORDER BY route_id,publication_hour_utc
        """
        # Route is also a canonical-window partition key, allowing predicate
        # pushdown before deduplication and keeping revision windows bounded.
        revisions = []
        routes = db.execute(
            'SELECT DISTINCT route_id FROM predictions_raw ORDER BY route_id'
        ).fetchall()
        for (route,) in routes:
            revisions.extend(rows(db, revision_sql, [route]))
        return {
            'schema_version': VERSION,
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'metric': 'prediction revisions; not actual arrival delays',
            'time_zone': 'UTC',
            'selection': {'capture_date': capture_date, 'feed_id': feed},
            'summary': summary,
            'feed_quality': quality,
            'prediction_revisions': revisions,
        }
