# GeoAtlas

A geospatial observatory with live MTA subway ingestion, durable current-state reconciliation, and a historical Parquet/DuckDB analysis pipeline. Built with React, TypeScript, MapLibre, Fastify, WebSockets, SQLite, and Python.

MTA mode ingests eight feed groups covering 29 route IDs, maps reported station associations, and records raw feeds for historical processing. The default offline demo uses six synthetic trains on A/C/E routes and three harbor vessels; harbor traffic remains synthetic in both modes. The New York background comes from OpenFreeMap/OpenStreetMap and subway geometry comes from official MTA static GTFS. No API keys or provider accounts are required.

## Run locally

Requires Node.js 22.13 or newer and pnpm 10.28.2. Node 22 may print an experimental notice for its built-in SQLite module.

```sh
npm install --global pnpm@10.28.2
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open **http://localhost:3001**. The Fastify server serves the built dashboard and API together.

To use MTA transit with synthetic harbor vessels:

```sh
TRANSIT_SOURCE=mta pnpm start
```

The live catalog supports 29 route IDs and 496 GTFS station records across the subway network, including Staten Island Railway. Route filters control the map and entity list. The header and entity details distinguish MTA reports from synthetic traffic; markers represent associated stations, not precise train positions. See [MTA realtime](docs/mta-realtime.md) for clock semantics, coverage and source terms.

For development with hot reload:

```sh
pnpm dev
```

Open **http://localhost:5173**. Vite proxies `/api`, including the WebSocket connection, to the server on port 3001.

```sh
pnpm test
pnpm typecheck
pnpm build
```

## What works

- Eight live MTA feed groups with independent reconciliation and source health, covering 29 subway route IDs.
- Independent complete transit snapshots every six seconds, with two trains per synthetic route.
- A synthetic streaming input emitting one vessel update every two seconds.
- Strict runtime validation, source ordering, absence grace, freshness and expiry, and bounded deletion records.
- SQLite persistence of current entities and reconciliation bookkeeping, committed before broadcast.
- Bounded raw-feed recording in MTA mode, idempotent conversion/backfills to Parquet, and DuckDB data-quality and prediction-revision reports. Historical processing is separate from the live dashboard; there is no playback UI.
- A full state snapshot on every browser connection, followed by revisioned changes. Route geometry and colors refresh against the same server epoch before new reports are displayed. Gaps force a reconnect and resynchronization.
- Layer filters, entity search, report details, source health, and map selection.
- Geographic New York basemap with visible attribution, official static route shapes and station positions, and an explicit route-only fallback if map tiles are unavailable.
- Track-following 1.5-second visual transitions that hold at the last reported target. New reports retarget from the displayed position. Reduced-motion preferences place markers immediately.

## Reconciliation and recovery

Complete snapshots are ordered by provider publication time within each feed. Failed, malformed and repeated snapshots cannot clear valid state or advance absence grace. Two newer valid snapshots omitting a train remove it; freshness and expiry use explicit source clocks. Removal records block late observations until the expiry rule itself makes replay impossible.

SQLite durably saves accepted state before changes are broadcast. Every browser connection starts with a complete snapshot; revision gaps force a reconnect. After a server restart, persisted ordering survives while a new stream epoch ensures clients resynchronize. [Design decisions](docs/implementation-decisions.md) describe the contracts and bounds.

## Historical data

MTA mode records raw packets automatically while running. Check recording health at `/api/archive/status`. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) for the optional offline jobs, then:

```sh
uv sync --project analytics --frozen
pnpm history import
pnpm history analyze
pnpm history accuracy
pnpm test:python
```

Reports are written to `.data/history/reports/latest.json`. The [historical pipeline guide](docs/history.md) covers public backfills, storage limits, rerun safety, timestamp meanings and SQL views. Prediction revisions are explicitly distinguished from actual arrival delays.

`accuracy` writes a separate `accuracy.json` report comparing MTA arrival-field timestamps with inferred feed-reported stop windows. It includes mean/median discrepancy, bias, variance and standard-deviation bounds, p95, timing uncertainty, forecast horizons and match coverage. MTA's arrival field can represent transit time at intermediate stops, so this proxy comparison does not establish physical arrival accuracy.

The [recorded proxy results](docs/results/forecast-proxy-2026-11-05.md) preserve the per-route statistics and full aggregate JSON: 4,662 matched forecasts across 587 reported stop events, covering 1.24% of eligible forecasts in the selected sample. The results include source hashes, capture windows, uncertainty bounds and the independent review findings.

A [recorded backfill benchmark](docs/benchmarks/history-sample.json) converted and analyzed 320,494 prediction observations from one G-train hour in 28.3 seconds, including scanning the 6.82 GB expanded daily archive. This is one local sample; network download time is excluded. The guide distinguishes scanned bytes from the selected data actually normalized.

## Code formatting

Prettier formats TypeScript, TSX, CSS, HTML, JSON, YAML, and working Markdown documents with two-space indentation, single quotes, and a 100-column print width. Editor defaults are in `.editorconfig`.

```sh
pnpm format
pnpm format:check
```

The Python importer uses Ruff with four-space indentation and the same line width. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) if you work on Python scripts; these commands run the pinned Ruff version:

```sh
pnpm format:python
pnpm format:python:check
```

Generated provider catalogs, the lockfile, build output, and the recovered document archive are excluded from Prettier. Refresh provider catalogs through their importer to preserve reproducibility.

## Configuration

The default listener is `127.0.0.1:3001`. Databases default to `.data/geoatlas.sqlite` in synthetic mode and `.data/geoatlas-mta-citywide.sqlite` in MTA mode, preserving separate checkpoints. `.env.example` lists the environment variables; `.env` files are not loaded automatically.

For example, to use another port:

```sh
PORT=3002 WEB_ORIGIN=http://localhost:3002 pnpm start
```

`WEB_ORIGIN` accepts a comma-separated list of exact browser origins. Its defaults cover localhost and 127.0.0.1 on ports 3001 and 5173. `TRANSIT_SOURCE` is `synthetic` by default, or `mta` for live transit. `HOST` and `DATABASE_PATH` can also be set; use an absolute database path to avoid working-directory ambiguity.

The demo has no authentication and is intended for local use. Public hosting needs an explicit access model and deployment configuration.

## Project structure

| Package                 | Responsibility                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `packages/adapter-core` | Runtime schemas, normalization contract, state reconciliation, and browser protocol    |
| `packages/adapters`     | MTA and synthetic decoders, provenance-tracked subway geometry and station headings    |
| `packages/server`       | Trusted transports, ingestion, SQLite checkpoints, raw archives, HTTP and WebSockets   |
| `packages/web`          | React dashboard, MapLibre layers, browser replica, and display-only animation          |
| `analytics`             | Pinned Python jobs for historical backfills, typed Parquet datasets and DuckDB reports |

## Design and next steps

Read [system design](docs/system-design.md), [adapter contract](docs/adapter-design.md), and [accepted implementation decisions](docs/implementation-decisions.md). The decisions document records the review of the reconstructed specifications and resolves the first milestone's open questions.

See [map data and provenance](docs/map-data.md) for the source dates, selected Manhattan coverage, licensing, and reproducible geometry import.

MTA GTFS-Realtime stop associations now cover all eight subway feed groups, with a restricted server-side transport, per-feed health, route filters, and conservative handling of unknown paths. See [citywide subway coverage](docs/subway-network.md) and [the original realtime milestone](docs/mta-realtime.md).

Next: broader variant geometry/trip matching and AISStream. Real feeds require verified schema, timestamp meanings, licensing, limits, and trusted network/credential handling. Animation must preserve reported associations such as “at” versus “approaching”; it must not invent precise train locations.

A [CI template](docs/ci-template.yml) runs TypeScript/Python tests, formatting checks and the production build without provider credentials. To enable it, copy it to `.github/workflows/ci.yml` using GitHub access that permits workflow uploads. It is not active yet.

`geoatlas-design-documents/` preserves the original recovered document bundle. It is historical reference; `docs/` is the working specification.

## License

[MIT](LICENSE) for project code. MTA static data and OpenStreetMap/OpenMapTiles cartography retain their separate source terms and attribution requirements; see [map data](docs/map-data.md).
