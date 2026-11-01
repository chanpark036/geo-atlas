# New York geography — 2026-10-29

## Scope

The dashboard now combines a geographic street/shoreline basemap with a locally served subset of official MTA static GTFS station positions and route shapes. All train and vessel reports, movements and six-second/two-second timings remain synthetic. No live MTA or AISStream integration is enabled.

A GTFS shape represents a published route path, not a surveyed physical track or a guarantee of current service. The application is not MTA-endorsed and does not guarantee the accuracy, completeness, or timeliness of source data.

## Basemap

Provider: [OpenFreeMap](https://openfreemap.org/), using its [dark style](https://tiles.openfreemap.org/styles/dark) and OpenStreetMap/OpenMapTiles data. The service requires no account or API key. See the provider's [quick start](https://openfreemap.org/quick_start/), [terms](https://openfreemap.org/tos/), and [OpenStreetMap attribution and licensing](https://www.openstreetmap.org/copyright).

The browser downloads the style, vector tiles, glyphs and sprites directly from `https://tiles.openfreemap.org`. Unlike the first schematic milestone, background cartography needs internet access. Attribution stays visible through MapLibre's non-collapsed attribution control, with an additional MTA static-data credit.

`packages/adapter-core/src/map-config.ts` is the reviewed cartography endpoint registry. MapLibre requests are restricted to that HTTPS origin and approved style/tile/font/sprite paths. Cross-origin credentials are not sent. The server CSP permits this one additional origin for map connections and images; script sources and the WebSocket origin policy are unchanged. MapLibre validates the external style before applying it. This public cartography policy is separate from trusted server-side provider ingestion and never handles API keys.

If the style fails or does not load within ten seconds, the map displays only the geographic route paths, station labels and synthetic entities on a plain background, with an explicit unavailability notice and retry button. Tile failures after style installation produce a non-blocking warning. The application never presents the old schematic as actual geography. WebGL failure still leaves the report list usable.

## Static subway geometry

Official source: [MTA developer resources](https://www.mta.info/developers), [regular subway GTFS ZIP](https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip), and [MTA data feed terms](https://www.mta.info/developers/terms-and-conditions).

The subset is stored in `packages/adapters/src/data/manhattan.json` and served by GeoAtlas through `/api/catalog`. Browsers do not fetch MTA data directly. This dataset is governed by the source terms, separately from this repository's MIT code license. No MTA logos, official map artwork or licensed symbols are included.

Provenance includes archive SHA-256, retrieval date, feed version, schedule coverage, representative trip ID and shape ID. The downloaded feed covers **2026-11-01 through 2027-05-15**; the current demo uses its static geometry only, and does not claim those schedules apply on the retrieval date.

The importer chooses the most frequent southbound shape per A/C/E route, breaking ties by shape ID, and a representative trip using that shape. It selects stations inside the Manhattan demo bounds and retains the original shape vertices between the first and last selected stations. It requires each station's exact original coordinate to appear in sequence on the shape, failing rather than snapping or inventing positions.

Current coverage:

| Route | Demo segment | Stations | Original shape |
| --- | --- | --- | --- |
| A | 59 St–Columbus Circle to Fulton St | 8 | `A..S58R` |
| C | 59 St–Columbus Circle to Fulton St | 11 | `C..S04R` |
| E | Lexington Av/53 St to World Trade Center | 12 | `E..S69R` |

This is one representative pattern per route, not a complete service map. A and C retain their different stop sequences. Shared paths are visually offset by a few screen pixels for legibility without changing geographic coordinates.

Synthetic trains cycle through **stops**, not through every shape vertex. Each report carries the actual station's catalog ID, GTFS stop ID and path index. Stop-list highlighting uses the station path index rather than its list index, since those are no longer interchangeable.

Animation measures distance along the shape so densely sampled curves do not change the apparent transition speed. It holds at the reported target, retargets smoothly, honors reduced motion and starts reconnect snapshots without replaying old movement. Persisted coordinates from an older demo geometry cannot cause a jump onto an unrelated shape vertex.

## Reproduce or refresh the subset

Network download is an explicit maintenance step, not part of install, build, tests, or server startup:

```sh
curl --fail --location --max-time 60 --proto '=https' --proto-redir '=https' \
  https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip -o /tmp/geoatlas-gtfs-subway.zip
python3 scripts/import-mta-geometry.py /tmp/geoatlas-gtfs-subway.zip --retrieved-at YYYY-MM-DD
pnpm test
pnpm build
```

Use the actual UTC retrieval date. The importer reads only specific ZIP members, bounds archive and decompressed member sizes, and does not extract files into the workspace. It requires Python 3 with only standard-library modules. Reproducing the output from the same archive and retrieval date is deterministic. Review changed source metadata, paths and stop sequences before adopting a refresh; feed updates may alter representative trips.

Remaining work: complete geographic coverage, variant-aware static data for live trips, provider timestamp/association handling, MTA GTFS-Realtime decoding, approved network ingestion and AISStream.
