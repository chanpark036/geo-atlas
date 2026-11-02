# MTA realtime transit milestone — 2026-11-01

## Run

```sh
pnpm install --frozen-lockfile
pnpm build
TRANSIT_SOURCE=mta pnpm start
```

Open http://localhost:3001. This mode shows public MTA A/C/E stop associations in the existing Manhattan catalog and synthetic harbor vessels. No API key is used. The default remains `TRANSIT_SOURCE=synthetic` for an offline report pipeline. Basemap tiles still need internet access in either mode.

Default databases are separate: `.data/geoatlas.sqlite` for synthetic mode and `.data/geoatlas-mta.sqlite` for MTA mode. An explicit `DATABASE_PATH` overrides this; do not reuse a checkpoint with a different adapter registry. Existing synthetic state is retained when switching modes. `.env.example` is a reference; environment files are not loaded automatically.

## Source and scope

- [MTA developer resources](https://www.mta.info/developers)
- [NYCT GTFS-Realtime reference](https://api.mta.info/GTFS.pdf)
- [GTFS-Realtime specification](https://gtfs.org/documentation/realtime/reference/)
- [MTA feed terms](https://www.mta.info/developers/terms-and-conditions)
- Fixed endpoint: `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace`

The application fetches and redistributes normalized data from its own server. The browser does not request MTA feeds directly and receives no credentials. MTA data retains its source terms, is provided as is, and is not guaranteed accurate, complete or timely. GeoAtlas is not MTA-endorsed.

A single registered polling input, `mta-subway / ace / manhattan`, owns the complete normalized A/C/E view. A/C/E are not independent upstream snapshots. Other routes and stations outside the selected catalog are deliberately excluded. The map is not a systemwide inventory or a complete service map. Full-feed completeness, publication ordering, two-publication absence grace and expiry apply to the filtered view as a whole.

Polling waits 30 seconds between completed attempts. Failure backoff never goes below the input's interval. Network failures, stale/future publications, malformed protobuf, differential feeds, conflicting identities and invalid relevant entities preserve prior state. A valid complete empty view can advance absence grace. A repeated publication cannot.

## Decoder and identities

The adapter uses MobilityData's `gtfs-realtime-bindings` to decode bounded Protocol Buffer packets. It accepts GTFS-Realtime 1.0/2.0 full datasets and runtime-validates the fields it consumes. A malformed relevant vehicle rejects the packet rather than creating a partial successful snapshot. Predictions and alerts are not converted to train locations. Canceled/deleted trips are omitted from the complete view.

Vehicle stop IDs are matched by station parent and N/S suffix against the static catalog. The marker is placed at the associated **station**, not at an inferred precise train location. Both northbound and southbound associations use that station anchor.

Status wording preserves `STOPPED_AT`, `INCOMING_AT`, and `IN_TRANSIT_TO`. Missing status defaults to in-transit per GTFS; without a stop sequence, status is not treated as proof of arrival. The UI instead labels an unspecified association.

Trip identities use the documented NYCT origin-time code, route, service date and direction. The pattern suffix is excluded because MTA says it may change or disappear mid-trip. A bounded SHA-256 identifier is used internally; conflicting normalized identities reject the snapshot. Labels display the route and trip origin-time code, not a physical trainset identifier.

## Clocks

`observedAt` explicitly means **feed publication time for the reported association**. It is not an arrival prediction or last-movement time. This clock orders the complete snapshot and determines freshness. Publications more than 120 seconds old, or more than 60 seconds ahead of receipt, are rejected.

MTA's reference describes the vehicle timestamp as last detected movement. That value is optional diagnostic metadata, displayed separately. It does not order or refresh entity state. A future optional movement clock is omitted; real feeds were observed with such values. Invalid required publication clocks still reject the packet.

MTA associations become stale after 60 seconds and expire after 180 seconds. The UI ages reports even if the WebSocket disconnects and explicitly warns when MTA information is at least a minute old. Source health distinguishes last successful receipt from last accepted publication, so a transport connection is not mistaken for fresh data.

## Transitions and variants

The static importer now records shape IDs whose Manhattan coordinate sequence exactly matches the representative route, forward or reversed. The NYCT reference documents the realtime trip ID as `<start time>_<shape_id>`. A recognized compatible suffix permits a display-only track transition; it does not guarantee actual routing or a precise train position.

Unknown, changed or unrecognized patterns fade between station anchors instead of traversing an unverified path. The midpoint has zero opacity, so relocation does not look like travel across an invented route. Reconnect snapshots and reduced-motion settings place anchors immediately. Future work includes broader, variant-aware static coverage and live trip matching.

## Trusted transport

`packages/server/src/http-source.ts` owns the reviewed endpoint. Adapters and environment variables cannot supply arbitrary URLs.

- HTTPS with normal certificate and hostname validation.
- Resolve the fixed hostname to IPv4 addresses, reject private, loopback, reserved and link-local results, and pass those same validated addresses directly to the TLS connection. Mixed safe/unsafe DNS answers fail closed. IPv6 is not enabled for this source.
- No redirect following, cookies, authentication headers or provider error-body logging.
- Require a successful protobuf/octet-stream response; reject compressed bodies and invalid/excessive declared lengths.
- Bound actual streamed bytes to 256 KiB, including responses without a length header. Reject empty/truncated responses.
- Abort on shutdown and enforce a 20-second attempt timeout.
- Expose only sanitized failure codes through source health.

The frontend CSP does not allow browser access to the MTA endpoint; public basemap requests remain a separate exact-origin policy. Adapters are reviewed trusted code, not sandboxed downloadable plugins.

## Verification and remaining work

Offline tests generate synthetic protobuf fixtures and exercise decoder semantics, failures preserving state, source grouping, timestamp policies, path compatibility, fades, transport limits, destination restrictions, health metadata, persistence and WebSocket delivery. CI does not use live feeds or credentials. A public feed was also decoded manually to verify real-world shape and clock behavior.

Remaining: full subway/variant coverage, additional MTA extensions when needed, richer coverage/unsupported-message metrics, and a separately reviewed AISStream transport and decoder. The harbor layer is still synthetic.
