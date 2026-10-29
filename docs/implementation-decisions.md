# Accepted first-milestone decisions — 2026-10-29

This document records the design review and the decisions accepted during implementation. It supplements the reconstructed system and adapter designs and supersedes their unresolved proposals where stated here. The recovered bundle remains unchanged in `geoatlas-design-documents/`.

## Review of the reconstructed designs

The confirmed architecture is appropriate for a small single-instance application: React/MapLibre, a Fastify backend, modular adapters, and SQLite. Keeping provider decoding separate from transport and reconciliation is a useful boundary. The reconstructed documents correctly avoid presenting missing specifications as recovered facts.

The remaining gaps were behavioral rather than framework choices:

1. Receipt order cannot determine provider order. A newer HTTP response can carry an older snapshot. Repeated copies of the same snapshot cannot count as independent missing-entity confirmations.
2. Completeness must be explicit. Empty successful snapshots, unsupported messages, malformed messages, and partially decoded snapshots cannot share an ambiguous outcome.
3. Feed publication time, observation time, and receipt time serve different purposes. Regular downloads do not make an old observation fresh.
4. Deletion needs bounded ordering memory. Otherwise a delayed update can resurrect an entity after its current record has been removed.
5. Stop associations do not establish precise train coordinates between reports. Predictions and “approaching” reports cannot be relabeled as arrivals.
6. An approved endpoint registry does not by itself enforce network security. Actual network transports still need destination, redirect, byte, timeout, and credential controls.
7. Geographic scope, entity scale, public access, retention, and basemap licensing must be explicit before deployment.

## Accepted scope

- Start with synthetic data and a local single-instance service.
- Persist current state and the bookkeeping needed for safe reconciliation. Do not add historical playback.
- Send a complete snapshot on every browser connection, including reconnects.
- Use reported train stop associations. Animate display changes smoothly, then hold at the latest reported target; do not extrapolate movement.
- The current background is a schematic. Replace it with a proper New York basemap and verified station and track geometry. This may happen while reports are still synthetic.
- MTA and AISStream integrations follow the synthetic milestone. Neither is enabled or implemented as a live transport in this commit.

## Packet acceptance and ordering

A decoder returns zero or one batch per input packet. Zero means ignored; it never means an empty snapshot. A decoder error, incomplete snapshot, invalid normalized entity, scope mismatch, or capacity failure rejects the entire packet and preserves prior state.

Snapshot batches carry `kind: "snapshot"`, `complete: true`, and a source `publishedAt` timestamp. They must match a registered snapshot input. Only a strictly newer publication advances the scope watermark or absence counters. Two distinct valid snapshots omitting an entity remove it from that scope. Other scopes are unaffected.

Delta batches carry `kind: "delta"` and timestamped explicit removals. Each entity is ordered by its own `observedAt`; an older report for one vessel does not cause a valid report for another vessel to be dropped. Equal-time conflicting observations keep the first accepted value. Removals older than an existing observation are ignored. A removal wins an equal-time tie.

Deletion records retain an observation cutoff for seven days, capped at 4,000 records. Updates at or before that cutoff cannot restore the entity. A genuinely newer, unexpired report may restore it. Capacity exhaustion rejects the operation rather than silently discarding ordering guarantees.

## Clocks and freshness

- `publishedAt`: provider publication time for a complete snapshot; orders snapshots within a source scope.
- `observedAt`: time of the event or association represented by an entity; orders entity reports and determines freshness.
- `receivedAt`: runtime-assigned receipt time; useful for diagnosing ingestion, not proof that an observation is current.

Repeated observations do not refresh their age. Provider timestamps more than 60 seconds ahead of receipt are rejected. Receipt timestamps more than five seconds ahead of the processing clock are rejected. Sweep current state every second and at startup.

Synthetic transit becomes stale after 20 seconds and expires after 90 seconds. Synthetic vessels become stale after 15 seconds and expire after 60 seconds. These are demo settings, not verified defaults for real providers. A real adapter must document what its observation timestamp means and any explicit fallback policy.

## Browser delivery and animation

Protocol version 1 uses a random server epoch and monotonically increasing change revisions. A snapshot includes all current entities at its revision; changes contain upserts and removed keys. The client requires a snapshot before applying changes. A revision gap, invalid message, or epoch mismatch closes the connection and retries with bounded exponential backoff and jitter.

Register the socket and send its snapshot synchronously to avoid an update gap. No event replay log is maintained. Server restarts create a new epoch and reset the in-memory revision; restored entity ordering remains in SQLite.

A train moves from its displayed position toward the latest reported stop over 1.5 seconds, following the available route path. A report received mid-transition retargets from the current displayed position. The marker then holds indefinitely until another position arrives. Reconnect snapshots place markers immediately, and reduced-motion preferences disable transitions. All animation state is browser-local and is never persisted as reported geography.

Report details describe the authoritative target, not the intermediate animated coordinate. Future provider adapters must preserve “at,” “approaching,” and other association semantics in both normalization and UI wording.

## Persistence and resource bounds

A single SQLite row stores a versioned JSON checkpoint of current entities, snapshot watermarks, and deletion records. The synchronous durable write must succeed before memory is replaced or changes are broadcast. Invalid persisted state fails startup instead of being silently discarded. SQLite uses WAL and full synchronous durability.

Initial hard limits:

| Resource | Limit |
| --- | --- |
| Input packet | 256 KiB |
| Entities / explicit removals per batch | 500 each |
| Current entities | 2,000 |
| Deletion records | 4,000 |
| Checkpoint | Less than 2 MiB, with protocol headroom |
| Browser WebSocket clients | 32 |
| Browser inbound frame | 1 KiB; the stream accepts no client commands |
| Buffered browser output | 4 MiB before terminating a slow connection |

Limits are enforced atomically. Increase them only with measured memory, serialization, and rendering behavior. These bounds are not a global-scale capacity claim.

## Trusted runtime and remaining work

The registry currently contains local fixture functions only. There are no provider URLs, outbound HTTP fetchers, real upstream WebSocket connections, credentials, or downloadable plugins. Fixture async iteration exercises streaming lifecycle behavior but does not test a real provider's network protocol.

The runtime owns non-overlapping polls, polling timeouts, stream idle timeouts, retries with jitter, sanitized health status, and abort on shutdown. Trusted transport implementations must honor cancellation; a synchronous decoder cannot be interrupted or sandboxed by TypeScript or schema validation.

Before real sources: implement and verify approved HTTPS/WSS destinations, redirect restrictions, DNS/destination handling, transport-level body/frame limits, server-side credential injection, and redaction. Verify feed completeness, timestamp meanings, source licensing and rate limits, and map attribution. Preserve actual MTA feed-group boundaries rather than assuming each displayed route has a separate complete feed.

Before public deployment: decide access control, geographic coverage, basemap provider, deployment/retention policy, and supported scale. Configure CODEOWNERS with actual maintainers and repository review protections; documentation and a commit cannot establish GitHub branch settings.
