# Historical data pipeline — 2026-11-03

SQLite remains the live application's durable current-state checkpoint. Historical data is a separate pipeline: bounded raw captures, versioned Parquet observations, and DuckDB reports. The dashboard still displays current reports; there is no historical playback UI.

```text
approved MTA transport -> live reconciliation -> SQLite checkpoint -> WebSocket dashboard
                      -> asynchronous raw archive -> offline conversion -> Parquet -> DuckDB report
public historical archive -------------------------> offline conversion
```

## Recording live feeds

```sh
pnpm build
TRANSIT_SOURCE=mta pnpm start
```

MTA mode records all eight feeds automatically while the server is running. Synthetic mode does not archive synthetic traffic. `ARCHIVE_ENABLED=0` disables recording; `ARCHIVE_DIRECTORY` changes the default `.data/history/raw`, and `ARCHIVE_MAX_BYTES` changes its default 2 GiB disk budget. `.env.example` documents configuration; environment files are not automatically loaded.

Captures preserve the exact bounded protobuf payload, its SHA-256, a unique capture ID, feed ID, UTC capture time and live ingestion outcome (`changed`, `unchanged`, `rejected`, or `fetch_error`). Capture time is packet receipt time for successful fetches and attempt completion time for failed fetches. Failed fetches have no payload or analytical receipt timestamp. Repeated feed publications remain separate evidence of collection attempts. Decoder failures retain their raw bytes; oversized or incomplete transport responses do not bypass the live transport's existing limits. Headers, credentials and provider error bodies are not archived.

The archive uses gzip-compressed NDJSON, partitioned by UTC date, feed and hour. Each line is an independently compressed gzip member containing a base64 packet. Parts seal after 16 captures, at an hour change, or on graceful shutdown. Jobs process sealed `.ndjson.gz` parts, excluding active `.open` files. The asynchronous writer has a 4 MiB queue and synchronizes each written capture to disk. It pauses on a disk/storage failure, counts drops, logs a sanitized notice and leaves live reconciliation running. Recording is best effort, not an atomic transaction with the SQLite checkpoint; process termination can lose queued captures.

`GET /api/archive/status` exposes process-lifetime written/dropped counts, pending bytes, disk usage including previous runs, and errors. It returns HTTP 503 for an archive error and HTTP 200 when healthy or disabled. The endpoint does not expose filesystem paths or raw feed data. On restart, the recorder validates and seals complete interrupted parts. Incomplete parts are retained with a `.corrupt` suffix for inspection. The archive never silently deletes older data when full.

## Install the offline tools

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then:

```sh
uv sync --project analytics --frozen
pnpm test:python
```

The Python dependencies and hashes are pinned in `analytics/pyproject.toml` and `analytics/uv.lock`. Python 3.11 or newer is required; the jobs and file locking currently target macOS and Linux. Python is not needed to run the live dashboard or raw recorder.

## Convert recorded data and run an analysis

```sh
pnpm history import
pnpm history analyze
```

The default dataset is `.data/history/parquet`. The report is written atomically to `.data/history/reports/latest.json` and also printed. Both commands accept `--dataset`; `import` accepts `--raw` and an input-file budget, and `analyze` accepts `--output`. Allow a raw part to seal before importing, roughly eight minutes per feed at the current polling interval; graceful shutdown also seals partial parts. Conversion and analysis are explicit jobs; no background scheduler or always-on service is installed.

Use `pnpm history analyze --date 2026-10-31 --feed g` to select a UTC capture date and feed. This selects relevant Parquet partitions before canonical deduplication. The report records its selection explicitly; an empty selection produces zero counts. Revision windows are processed one route at a time, allowing the combined live/backfill sample to remain within the same DuckDB memory budget.

Three typed tables are stored as Zstandard-compressed Parquet, partitioned by feed and UTC capture date within immutable batches:

| Table         | Row meaning                                                        |
| ------------- | ------------------------------------------------------------------ |
| `captures`    | A collection attempt, including failed fetches and invalid packets |
| `predictions` | A published absolute arrival/departure prediction for a trip/stop  |
| `vehicles`    | A published stop association and optional last-movement timestamp  |

Absolute predictions are preserved as predictions. Delay-only stop events cannot be converted to absolute times without a matching schedule and are not emitted. Unsupported or malformed snapshots produce an invalid capture record, without publishing a partial set of observations from that packet. No predictions become train coordinates or asserted actual arrivals.

Every observation points back to its capture and publication. A trip key uses route, service date, origin-time code and direction when available, preserving the original trip ID as well. Missing service dates are retained but excluded from prediction-revision comparisons. Local service dates remain distinct from UTC capture dates.

## Reruns, overlapping data and failures

Each input file's content hash, transformation version and selection determine its output batch ID. One writer holds an OS file lock. It converts in a temporary directory, validates the source fingerprint again, checksums outputs, and atomically publishes the completed batch. Failed conversions do not publish partial batches. On retry, the exclusive writer removes abandoned staging work bearing this pipeline's ownership marker. Identical reruns verify existing output checksums and skip completed work. Raw inputs are retained so a corrected transformation can rebuild the dataset.

The Parquet files preserve repeated observations from different captures. The supplied `dataset_views` function in `analytics/geoatlas_history/pipeline.py` verifies completed batch checksums and exposes canonical DuckDB tables that deduplicate capture IDs and observation IDs, selecting the earliest capture. This prevents overlapping archives from inflating analytical counts. Directly counting every physical Parquet row can include those repeated observations.

DuckDB is limited to 256 MB of working memory, two threads and 512 MB of temporary spill space. Conversion bounds capture/observation counts and CSV staging size. Committed Parquet data has a default 4 GiB budget, configurable through `--max-dataset-bytes`; it stops publishing new batches when full. A job that exceeds its budget fails cleanly; select a smaller feed/hour window or explicitly increase the bounded row budget. Existing live packet, entity and browser-message limits are unchanged.

## Historical backfills

[Subway Data NYC](https://subwaydata.nyc/) provides raw daily GTFS-Realtime archives and describes its [collection process](https://subwaydata.nyc/how-it-works) and [download interface](https://subwaydata.nyc/programmatic-access). Its daily archives cover NYC calendar days; member filenames contain UTC capture timestamps. Cite that project and retain MTA's source terms when using its data.

```sh
pnpm history fetch-day --date 2026-10-31
pnpm history backfill \
  --file .data/history/backfill/subwaydatanyc_2026-10-31_gtfsrt.tar.xz \
  --feed g --hour 12
pnpm history analyze
```

`--feed` and `--hour` select a bounded sample; the hour is UTC. Omit them to import the whole file subject to the job's resource limits. The archive must still be scanned and verified when filtering. A download manifest records the URL, retrieval time, size and SHA-256; cached downloads are checksum-verified before reuse.

The downloader uses two fixed reviewed HTTPS hosts, a date-constrained path, at most one approved redirect, public IPv4 address validation pinned to the TLS connection, normal certificate verification, a 128 MiB compressed download cap and a 2 GiB cache budget. Archive reading limits decompression memory and expanded bytes, validates member names/types/sizes, and never extracts member paths. Historical members have a separate 1 MiB offline bound because some archived records exceed the live transport's 256 KiB cap. Known alert-feed members are validated and skipped; the analytical dataset covers subway prediction/vehicle feeds. This does not change live transport acceptance.

For imported historical data, `captured_at` is the publisher's original collection timestamp, `received_at` is null, and `imported_at` is the actual import time. Importing old data never presents it as newly observed live data.

## Reports and measurements

The report includes canonical observation counts, payload bytes, invalid packets, failed fetches, repeated/conflicting publications, source clock anomalies, and per-feed out-of-order publications and gaps over 90 seconds. Gap counts describe the observed sample interval, not guaranteed coverage of a complete day.

The initial domain analysis measures changes between consecutive predictions for the same trip, stop, stop sequence and arrival/departure kind, grouped by route and UTC publication hour. It excludes live-rejected captures, conflicting publications, ambiguous repeated stop occurrences, missing service dates and comparisons spanning more than 90 seconds. A structurally valid protobuf packet may still fail the live identity/reconciliation checks: its observations remain auditable but do not drive the revision metric. Means and p95 values describe absolute prediction revisions in seconds. They are not measured arrival delays, forecast errors or on-time performance. Gap detection uses the greatest previous publication timestamp, so an out-of-order packet cannot reset the watermark and create a false gap.

Each completed conversion manifest records its source hash, selection, raw payload bytes, decoded row counts, output checksums/sizes and elapsed conversion time. Use those metrics with an explicit source window and machine description. Distinguish compressed archive bytes, selected protobuf bytes, physical rows and canonical observations; none is a count of unique physical trains.

Run a fresh conversion and canonical report in a temporary dataset to measure the complete offline job. This bypasses completed-batch reuse and excludes network download time:

```sh
pnpm history benchmark \
  --file .data/history/backfill/subwaydatanyc_2026-10-31_gtfsrt.tar.xz \
  --feed g --hour 12
```

The result is written to `.data/history/reports/benchmark.json`. It records input/selection hashes, scanned versus selected bytes, canonical observations, Parquet size, conversion/report wall times, peak process RSS, architecture and Python/DuckDB versions. The DuckDB memory setting is not a bound on total Python process RSS. The source archive's compression and the flattened analytical tables use different representations; Parquet is not guaranteed to be smaller than the original compressed protobuf data.

The [recorded sample](benchmarks/history-sample.json) scanned a 56,226,528-byte compressed archive (6,824,557,056 expanded bytes), selected the G feed at 12:00–13:00 UTC on 2026-10-31, and materialized 320,494 prediction observations plus 9,338 vehicle observations from 480 captures. Fresh conversion and analysis took 28.26 seconds with a peak process RSS of 437,977,088 bytes on the recorded Darwin/arm64 environment. This is a single local run, with network download excluded and the live application running separately. Only 7,515,301 protobuf bytes belonged to the selected feed/hour; the entire daily archive was scanned, not normalized into observations.

In that sample, 29,774 of 319,304 comparable successive predictions changed; the p95 absolute revision was 12 seconds. This describes prediction stability in one selected hour, not arrival accuracy or systemwide service performance.

## Comparing arrival-field forecasts with reported stops

```sh
pnpm history accuracy
pnpm history accuracy --date 2026-11-03 --feed numbered
```

The report is written to `.data/history/reports/accuracy.json`. It compares timestamps in MTA's `StopTimeUpdate.arrival.time` field against inferred feed-reported stop windows, independently of the prediction-revision report. Departure-field forecasts are excluded. MTA documents the arrival field as a predicted arrival time where an arrival is scheduled, or a predicted transit time where a transit time is scheduled. Intermediate-stop transit times may target a different event from the `STOPPED_AT` reference. This pipeline does not distinguish those meanings, so its discrepancy statistics do not establish accuracy of physical platform-arrival forecasts. Negative bias can reflect a target mismatch as well as timing error or reporting lag.

The [2026-11-05 results snapshot](results/forecast-proxy-2026-11-05.md) records all scored route/horizon groups, coverage and input provenance, with a readable summary and aggregate JSON. It is a fixed selected sample, separate from later runs of the report command.

The reference requires an `INCOMING_AT` or `IN_TRANSIT_TO` observation followed by `STOPPED_AT` for the same trip and stop, with publications no more than 90 seconds apart. The previous publication starts the window and the first stopped publication ends it. These timestamps bracket a **feed status change**. Treating that as a physical arrival window is an assumption: upstream reporting lag is unknown, and this is not independently measured arrival truth. MTA describes the vehicle timestamp as last detected movement, so neither that clock nor the final arrival prediction is used as the reference. See the [MTA reference](https://api.mta.info/GTFS.pdf) and [GTFS vehicle statuses](https://gtfs.org/documentation/realtime/reference/#enum-vehiclestopstatus).

Only forecasts published at or before the start of the window are scored. For example, a forecast of 10:06:00 and a stop-proxy window of 10:06:40–10:07:00 produce a signed discrepancy range of +40 to +60 seconds. Positive discrepancy means the stop proxy is later than the forecast timestamp. If the forecast falls inside the window, the minimum absolute discrepancy is zero; the maximum is its distance to the farther endpoint. Mean absolute error, p95 absolute error and the percentage within 60 seconds are reported as ranges under this window assumption; the JSON field names retain `error` for these proxy discrepancies. No midpoint is presented as an exact arrival.

The report also includes median absolute error, mean signed error (bias), and population variance/standard deviation of signed discrepancies. Positive bias means the stop proxy is later than the arrival-field forecast timestamp; negative bias means earlier. It does not by itself show that physical arrival predictions are systematically early or late. Standard deviation is in seconds and variance is in seconds squared. These describe the finite matched forecast sample; they are not unbiased estimates from independent arrival observations. A group with one forecast has zero descriptive population variance, which is not evidence of reliable forecasting.

Spread bounds preserve the shared arrival clock: shifting one arrival's time changes all its forecasts' errors equally, so their within-arrival variance stays fixed. The calculation separates fixed within-arrival variance from between-arrival variance. Internally, error-window midpoints provide a mathematical center for the between-arrival part; they are not asserted arrival times. The weighted root-mean-square half-window width bounds the change in between-arrival standard deviation by the triangle inequality. With just one arrival, that change is zero. Adding the fixed within-arrival variance produces conservative variance bounds, whose square roots give standard-deviation bounds. Taking the standard deviations of the lower and upper endpoint lists would not give valid uncertainty bounds: two intervals of [-15,+15] allow errors -15,+15, even though both endpoint lists have zero spread.

All statistics are rounded to two decimals. Bounds account for the assumed stop windows, not unknown provider reporting lag or the arrival/transit target mismatch, and are not statistical confidence intervals. Absolute-error bounds can be conservative because forecasts about one arrival share its clock. The p95 uses a continuous sample quantile with linear interpolation; it approximates the 95th percentile rather than guaranteeing that at least 95% of a finite sample falls at or below the interpolated value.

Results are separated by route and forecast horizon: 0–2, 2–5, 5–10 and over 10 minutes before the first stopped report. These are forecast-weighted statistics: multiple predictions can refer to one arrival. Overall and per-route coverage include total and eligible arrival predictions, matched predictions, distinct matched arrivals and unmatched counts. The report contains up to 20 example comparisons with prediction and vehicle observation IDs for tracing the evidence.

Conflicting publications, live-rejected captures, missing service dates, ambiguous vehicle/trip identities and repeated visits to the same stop are excluded. Arrival events already underway when recording starts, missing/unknown approach statuses, station changes without an observed approach, and gaps over 90 seconds do not create usable windows. Predictions emitted during or after an arrival window remain in coverage counts but are not scored. Canonical observations deduplicate overlapping recordings before evaluation. Date/feed selection limits both forecast and arrival evidence; windows crossing a selected date boundary can be unmatched. A zero-coverage line has no accuracy statistic, rather than a fabricated zero error. This conservative selection can bias the sample toward trips with better reporting, so results do not establish systemwide accuracy.

## Verification

```sh
pnpm format:check
pnpm format:python:check
pnpm test
pnpm test:python
pnpm build
```

Tests use local fixtures, including actual protobuf encoding and real Parquet reads/writes. They cover live failure isolation, archival bounds/recovery, repeated and overlapping inputs, checksum failures, incomplete conversion rollback, historical timestamp provenance, source restrictions, conflicting publications, late data and prediction revisions. Tests never download provider data. CI configuration remains in `docs/ci-template.yml` until workflow-upload access is available.
