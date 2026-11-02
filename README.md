# GeoAtlas

A local geospatial observatory built with React, TypeScript, MapLibre, Fastify, WebSockets, and SQLite.

The demo shows **synthetic traffic**: six trains on A/C/E routes and three harbor vessels. The New York background comes from OpenFreeMap/OpenStreetMap; station positions and route paths come from a locally served subset of official MTA static GTFS. No API keys or provider accounts are required. Background tiles require internet access; report generation and static subway geometry run locally. Live MTA A/C/E stop associations can be enabled explicitly; the harbor layer remains synthetic.

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

Only stop associations within the Manhattan catalog are shown. The header and entity details distinguish MTA reports from synthetic traffic; markers represent associated stations, not precise train positions. See [MTA realtime](docs/mta-realtime.md) for clock semantics, coverage and source terms.

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

- Independent complete transit snapshots every six seconds, with two trains per synthetic route.
- A synthetic streaming input emitting one vessel update every two seconds.
- Strict runtime validation, source ordering, absence grace, freshness and expiry, and bounded deletion records.
- SQLite persistence of current entities and reconciliation bookkeeping, committed before broadcast. There is no historical playback.
- A full state snapshot on every browser connection, followed by revisioned changes. Gaps force a reconnect and resynchronization.
- Layer filters, entity search, report details, source health, and map selection.
- Geographic New York basemap with visible attribution, official static route shapes and station positions, and an explicit route-only fallback if map tiles are unavailable.
- Track-following 1.5-second visual transitions that hold at the last reported target. New reports retarget from the displayed position. Reduced-motion preferences place markers immediately.

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

The default listener is `127.0.0.1:3001`. Databases default to `.data/geoatlas.sqlite` in synthetic mode and `.data/geoatlas-mta.sqlite` in MTA mode, preserving separate checkpoints. `.env.example` lists the environment variables; `.env` files are not loaded automatically.

For example, to use another port:

```sh
PORT=3002 WEB_ORIGIN=http://localhost:3002 pnpm start
```

`WEB_ORIGIN` accepts a comma-separated list of exact browser origins. Its defaults cover localhost and 127.0.0.1 on ports 3001 and 5173. `TRANSIT_SOURCE` is `synthetic` by default, or `mta` for live transit. `HOST` and `DATABASE_PATH` can also be set; use an absolute database path to avoid working-directory ambiguity.

The demo has no authentication and is intended for local use. Public hosting needs an explicit access model and deployment configuration.

## Project structure

| Package                 | Responsibility                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `packages/adapter-core` | Runtime schemas, normalization contract, state reconciliation, and browser protocol |
| `packages/adapters`     | Synthetic provider decoders, payload generators, and route catalog                  |
| `packages/server`       | Trusted endpoint registry, polling/streaming runtime, SQLite, HTTP, and WebSockets  |
| `packages/web`          | React dashboard, MapLibre layers, browser replica, and display-only animation       |

## Design and next steps

Read [system design](docs/system-design.md), [adapter contract](docs/adapter-design.md), and [accepted implementation decisions](docs/implementation-decisions.md). The decisions document records the review of the reconstructed specifications and resolves the first milestone's open questions.

See [map data and provenance](docs/map-data.md) for the source dates, selected Manhattan coverage, licensing, and reproducible geometry import.

MTA GTFS-Realtime stop associations are now supported with a restricted server-side transport, source-aware UI, and conservative handling of unknown paths. See [the realtime milestone](docs/mta-realtime.md).

Next: broader subway/variant coverage and AISStream. Real feeds require verified schema, timestamp meanings, licensing, limits, and trusted network/credential handling. Animation must preserve reported associations such as “at” versus “approaching”; it must not invent precise train locations.

A [CI template](docs/ci-template.yml) runs tests and the production build without provider credentials. To enable it, copy it to `.github/workflows/ci.yml` using GitHub access that permits workflow uploads. It is not active yet.

`geoatlas-design-documents/` preserves the original recovered document bundle. It is historical reference; `docs/` is the working specification.

## License

[MIT](LICENSE) for project code. MTA static data and OpenStreetMap/OpenMapTiles cartography retain their separate source terms and attribution requirements; see [map data](docs/map-data.md).
