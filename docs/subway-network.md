# Citywide subway stop coverage — 2026-11-01

This milestone expands MTA mode beyond the original A/C/E Manhattan view. It preserves reported station associations, publication ordering, explicit freshness, and conservative display transitions. Harbor traffic remains synthetic.

## Coverage and source ownership

The [official MTA feed directory](https://api.mta.info/) lists eight subway feed groups. The reviewed registry is `packages/adapter-core/src/transit-config.ts`; fixed server URLs are constructed only from those approved entries in `packages/server/src/http-source.ts`.

| Input      | Routes / services               |
| ---------- | ------------------------------- |
| `numbered` | 1, 2, 3, 4, 5, 6, 6X, 7, 7X, GS |
| `ace`      | A, C, E, H                      |
| `bdfm`     | B, D, F, FX, M, FS              |
| `g`        | G                               |
| `jz`       | J, Z                            |
| `l`        | L                               |
| `nqrw`     | N, Q, R, W                      |
| `si`       | Staten Island Railway (SI)      |

The directory currently includes 7 with the numbered feed and Franklin Avenue Shuttle (FS) with B/D/F/M. Each input owns only its registered route IDs. All use scope `citywide`; a complete publication can reconcile only that input. A failure or repeated publication cannot remove trains from another feed. There are eight live polling inputs plus one synthetic harbor input.

The catalog supports **29 GTFS route IDs** and **496 GTFS station records** from the reviewed static archive. Those are data-model counts, not a claim that all services are running or all physical trains are reporting. Vehicle associations are shown only when a known station can be identified; trip predictions are not converted into train positions. Some routes may have no current service, no vehicle report, or a delayed feed.

## Station coverage and route paths

`packages/adapters/src/data/subway-network.json` is a reproducible subset of the official static GTFS archive, using the same recorded publisher, retrieval date, feed version, coverage dates and SHA-256 as the original geography milestone. It contains:

- One representative published shape and stop sequence per route ID, selected deterministically from the most frequent southbound shape (or available direction).
- All station memberships from all trips, including branches absent from that representative path.
- The original station coordinates and source shape vertices. No station is snapped onto a different location.
- Shape IDs that exactly match a representative coordinate sequence in either direction, for conservative visual transitions.
- An explicit `unmappedStopIds` list for representative-trip stations whose exact coordinates do not appear on the chosen shape. These stations remain in the global station table and can receive reports.

For a live report, station lookup uses the global table. A registered route reporting a detour to another known station is still placed at that station, even if its regular static memberships differ. Track transitions require a matching representative station vertex and compatible pattern; other cases fade between station anchors. This is station coverage across the network, not a complete rendering of every service variant or a guarantee of current routing.

Catalog validation is bounded to 32 route entries and 1,000 global station records, with validated memberships, unique identities, ordered representative stop indices and bounded coordinate arrays. The current artifact is about 1.3 MB. Existing input packet, batch, current-state, browser-message and deletion-record caps are unchanged. The measured largest live feed response was below the existing 256 KiB packet cap.

## Dashboard

Route buttons filter train markers, the entity list, static route lines and station dots together. All/None controls are available; vessel visibility remains independent. Filtering is browser-local: all source ingestion and freshness checks continue, and reconnect still starts with the complete current-state snapshot.

The map fits the full geographic station extent at startup in MTA mode. “Fit network” restores that view; “Locate selected” zooms to a report anchor. Stations are rendered as a bounded GeoJSON layer rather than hundreds of HTML labels. Only the selected reported station gets an HTML label. Source health is per feed, with clear retry/delay notices that do not imply all other feeds failed.

## Reconnect catalog synchronization

The catalog HTTP response carries `X-GeoAtlas-Epoch`, matching the epoch of the WebSocket snapshot. On every initial or reconnect snapshot, the browser fetches `/api/catalog` with `cache: no-store` and verifies that epoch before publishing the new reports and geometry together. Updates arriving during the request replace a single pending current-state view rather than accumulating an unbounded queue.

A failed or mismatched catalog request retries with bounded backoff while the previous synchronized view remains visible. Superseded requests are aborted and late completions are ignored. An unchanged catalog retains its object identity so reconnecting does not recreate the map or reset its viewport unnecessarily.

This fixes the case where an open A/C/E-only tab reconnected to citywide train reports but kept the old route geometry and palette. Orange is reserved for synthetic vessels; an unknown train route uses a neutral fallback.

## Safe removal-record retirement

A fixed week of deletion records is unnecessary for short-lived reports and could exhaust the 4,000-record cap as citywide trips turn over. A record now retires once its cutoff timestamp plus the owning adapter's entity expiry has passed.

For cutoff `c`, expiry `E`, and current time `t >= c + E`, every blocked observation `o <= c` already satisfies `t - o >= E`. Such an observation is rejected by the existing expiry check even after the deletion record is gone. This preserves replay protection without retaining redundant records. Legacy longer-lived records are also retired only at that safe boundary. Snapshot publication watermarks remain durable; no resource cap or network/security check is removed.

## Run and persistence

```sh
pnpm build
TRANSIT_SOURCE=mta pnpm start
```

Open http://localhost:3001. Synthetic mode remains the offline default.

The citywide MTA checkpoint defaults to `.data/geoatlas-mta-citywide.sqlite`. The earlier `.data/geoatlas-mta.sqlite` and synthetic checkpoint are retained. This avoids silently interpreting an old Manhattan-scoped checkpoint as a citywide registry. If using an explicit `DATABASE_PATH`, choose a separate file for the changed input scopes. There is no historical playback or implicit deletion of old databases.

## Reproduce the static network

```sh
python3 scripts/import-subway-network.py /tmp/geoatlas-gtfs-subway.zip --retrieved-at YYYY-MM-DD
pnpm format:python:check
pnpm test
pnpm build
```

Use the official archive and actual retrieval date described in [map data](map-data.md). The importer is offline, reads only named ZIP members, bounds archive/decompressed sizes, and fails for a changed route registry that needs review. The generated artifact is excluded from automatic formatting.

## Verification and remaining work

Offline tests cover every feed group, global station/branch coverage, detours, input isolation, invalid snapshots, filters, viewport bounds, catalogue validation, and safe removal-record retirement. Live smoke checks exercised all eight restricted transports and the shared state manager. Tests and builds never fetch provider data.

Remaining: full variant geometry and trip matching, station/route detail improvements, and AISStream. Neither this change nor its source data guarantees that every physical train is represented.
