import argparse
import json
from pathlib import Path
import sys
import time
import uuid
from lzma import LZMAError
from tarfile import TarError

import duckdb

from .accuracy import evaluate_accuracy
from .backfill import fetch_day
from .benchmark import benchmark
from .captures import FEEDS
from .pipeline import analyze, import_source

ROOT = Path(__file__).resolve().parents[2] / '.data/history'


def main():
    parser = argparse.ArgumentParser(description='GeoAtlas raw archive, Parquet and DuckDB jobs')
    commands = parser.add_subparsers(dest='command', required=True)
    convert = commands.add_parser(
        'import', help='Convert sealed local raw archive parts into Parquet'
    )
    convert.add_argument('--raw', type=Path, default=ROOT / 'raw')
    convert.add_argument('--dataset', type=Path, default=ROOT / 'parquet')
    convert.add_argument('--max-files', type=int, default=2000)
    convert.add_argument('--max-dataset-bytes', type=int, default=4 * 1024**3)
    fetch = commands.add_parser(
        'fetch-day', help='Download one historical day from the reviewed public archive'
    )
    fetch.add_argument('--date', required=True)
    fetch.add_argument('--directory', type=Path, default=ROOT / 'backfill')
    backfill = commands.add_parser('backfill', help='Convert a downloaded Subway Data NYC archive')
    backfill.add_argument('--file', required=True, type=Path)
    backfill.add_argument('--dataset', type=Path, default=ROOT / 'parquet')
    backfill.add_argument('--feed', choices=sorted(FEEDS))
    backfill.add_argument(
        '--hour', type=int, choices=range(24), help='UTC capture hour; optional bounded sample'
    )
    backfill.add_argument('--max-rows', type=int, default=2_000_000)
    backfill.add_argument('--max-dataset-bytes', type=int, default=4 * 1024**3)
    measure = commands.add_parser(
        'benchmark', help='Measure a fresh historical conversion and report'
    )
    measure.add_argument('--file', required=True, type=Path)
    measure.add_argument('--feed', choices=sorted(FEEDS))
    measure.add_argument('--hour', type=int, choices=range(24))
    measure.add_argument('--max-rows', type=int, default=2_000_000)
    measure.add_argument('--output', type=Path, default=ROOT / 'reports/benchmark.json')
    report = commands.add_parser(
        'analyze', help='Write data-quality and prediction-revision reports'
    )
    report.add_argument('--dataset', type=Path, default=ROOT / 'parquet')
    report.add_argument('--output', type=Path, default=ROOT / 'reports/latest.json')
    report.add_argument('--date', help='UTC capture date YYYY-MM-DD')
    report.add_argument('--feed', choices=sorted(FEEDS))
    accuracy = commands.add_parser(
        'accuracy', help='Compare arrival-field forecasts with inferred reported-stop windows'
    )
    accuracy.add_argument('--dataset', type=Path, default=ROOT / 'parquet')
    accuracy.add_argument('--output', type=Path, default=ROOT / 'reports/accuracy.json')
    accuracy.add_argument('--date', help='UTC capture date YYYY-MM-DD')
    accuracy.add_argument('--feed', choices=sorted(FEEDS))
    args = parser.parse_args()
    try:
        if args.command == 'fetch-day':
            result = fetch_day(args.date, args.directory)
        elif args.command == 'backfill':
            result = import_source(
                args.file,
                args.dataset,
                'subwaydata',
                args.feed,
                args.hour,
                args.max_rows,
                args.max_dataset_bytes,
            )
        elif args.command in {'analyze', 'accuracy', 'benchmark'}:
            if args.command == 'benchmark':
                result = benchmark(args.file, args.feed, args.hour, args.max_rows)
            else:
                job = analyze if args.command == 'analyze' else evaluate_accuracy
                result = job(args.dataset, args.date, args.feed)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_name(f'.{args.output.name}-{uuid.uuid4()}.pending')
            temporary.write_text(json.dumps(result, indent=2) + '\n')
            temporary.replace(args.output)
        else:
            started = time.perf_counter()
            files = sorted(args.raw.rglob('*.ndjson.gz'))
            if not 1 <= args.max_files <= 50_000 or len(files) > args.max_files:
                raise ValueError('Input file budget exceeded')
            results = [
                import_source(path, args.dataset, max_dataset_bytes=args.max_dataset_bytes)
                for path in files
            ]
            result = {
                'files': len(files),
                'new_batches': sum(not item['skipped'] for item in results),
                'skipped_batches': sum(item['skipped'] for item in results),
                'elapsed_seconds': round(time.perf_counter() - started, 4),
            }
        print(json.dumps(result, indent=2))
    except (
        ValueError,
        OSError,
        RuntimeError,
        EOFError,
        LZMAError,
        TarError,
        duckdb.Error,
    ) as error:
        print(f'History job failed: {error}', file=sys.stderr)
        raise SystemExit(1) from error
