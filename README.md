# GeoAtlas

A local geospatial observatory built with React, TypeScript, MapLibre, Fastify, WebSockets, and SQLite.

The first milestone runs entirely on **synthetic data**: six trains on three A/C/E-style routes and three harbor vessels. The background, stop coordinates, and route paths are approximate schematic geometry. No API keys, provider accounts, external tiles, or live feeds are required.

## Run locally

Requires Node.js 22.13 or newer and pnpm 10.28.2. Node 22 may print an experimental notice for its built-in SQLite module.

```sh
npm install --global pnpm@10.28.2
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open **http://localhost:3001**. The Fastify server serves the built dashboard and API together.

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
- Track-following 1.5-second visual transitions that hold at the last reported target. New reports retarget from the displayed position. Reduced-motion preferences place markers immediately.

## Configuration

The default listener is `127.0.0.1:3001`. The database defaults to `.data/geoatlas.sqlite` at the repository root. `.env.example` lists the environment variables; `.env` files are not loaded automatically.

For example, to use another port:

```sh
PORT=3002 WEB_ORIGIN=http://localhost:3002 pnpm start
```

`WEB_ORIGIN` accepts a comma-separated list of exact browser origins. Its defaults cover localhost and 127.0.0.1 on ports 3001 and 5173. `HOST` and `DATABASE_PATH` can also be set; use an absolute database path to avoid working-directory ambiguity.

The demo has no authentication and is intended for local use. Public hosting needs an explicit access model and deployment configuration.

## Project structure

| Package | Responsibility |
| --- | --- |
| `packages/adapter-core` | Runtime schemas, normalization contract, state reconciliation, and browser protocol |
| `packages/adapters` | Synthetic provider decoders, payload generators, and route catalog |
| `packages/server` | Trusted endpoint registry, polling/streaming runtime, SQLite, HTTP, and WebSockets |
| `packages/web` | React dashboard, MapLibre layers, browser replica, and display-only animation |

## Design and next steps

Read [system design](docs/system-design.md), [adapter contract](docs/adapter-design.md), and [accepted implementation decisions](docs/implementation-decisions.md). The decisions document records the review of the reconstructed specifications and resolves the first milestone's open questions.

Next: accurate New York basemap, verified stations and track geometry, then MTA GTFS-Realtime stop associations and AISStream. Real feeds require verified schema, timestamp meanings, licensing, limits, and trusted network/credential handling. Animation must preserve reported associations such as “at” versus “approaching”; it must not invent precise train locations.

A [CI template](docs/ci-template.yml) runs tests and the production build without provider credentials. To enable it, copy it to `.github/workflows/ci.yml` using GitHub access that permits workflow uploads. It is not active yet.

`geoatlas-design-documents/` preserves the original recovered document bundle. It is historical reference; `docs/` is the working specification.

## License

[MIT](LICENSE). Third-party data and basemap licensing must be verified separately when those sources are introduced.
