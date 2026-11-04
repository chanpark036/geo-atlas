"""Measure a fresh historical conversion and query; never reuse completed outputs."""

import platform
from datetime import datetime, timezone
from pathlib import Path
import resource
import sys
import tempfile
import time

import duckdb

from .pipeline import analyze, import_source


def benchmark(path, feed=None, hour=None, max_rows=2_000_000):
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='geoatlas-history-benchmark-') as directory:
        manifest = import_source(path, Path(directory), 'subwaydata', feed, hour, max_rows)
        converted = time.perf_counter()
        report = analyze(Path(directory))
        finished = time.perf_counter()
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return {
            'measured_at': datetime.now(timezone.utc).isoformat(),
            'benchmark': 'historical ETL and canonical DuckDB report; download excluded',
            'source_file': Path(path).name,
            'source_sha256': manifest['source_sha256'],
            'feed': feed,
            'capture_hour_utc': hour,
            'compressed_input_bytes': manifest['source_bytes'],
            'scanned_archive_bytes': manifest['counts'].get('archive_expanded_bytes'),
            'selected_payload_bytes': manifest['counts']['raw_bytes'],
            'parquet_bytes': sum(file['bytes'] for file in manifest['files']),
            'conversion_seconds': round(converted - started, 4),
            'analysis_seconds': round(finished - converted, 4),
            'total_seconds': round(finished - started, 4),
            'peak_process_rss_bytes': int(peak if sys.platform == 'darwin' else peak * 1024),
            'machine': {
                'os': platform.system(),
                'architecture': platform.machine(),
                'python': platform.python_version(),
                'duckdb': duckdb.__version__,
                'duckdb_memory_limit': '256MB',
                'duckdb_threads': 2,
            },
            'summary': report['summary'],
            'prediction_revisions': report['prediction_revisions'],
        }
