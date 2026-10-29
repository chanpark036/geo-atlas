# GeoAtlas — Real-Time Geospatial Dashboard Design v0.2

> Reconstruction dated 2026-10-29. The original attachment was unavailable. This document is recreated from the accessible “Assess Clone Difficulty” conversation (6ae2eb0c-c32c-83ea-b5a1-6ab3155e28c6), not a byte-for-byte recovery. Decisions explicitly present in that record are distinguished below from proposed implementation details. Provider configuration and current API requirements have not been verified.

## 1. Purpose and confirmed priorities
GeoAtlas is an open-source, real-time geospatial intelligence dashboard inspired by Argos Atlas. Priorities are security-first engineering, free and open data where possible, real-time updates, modular TypeScript architecture, maintainability, and low infrastructure cost.

## 2. Confirmed architecture
- Frontend: React, TypeScript, MapLibre GL JS.
- Backend: Node.js, Fastify, WebSockets.
- Repository: pnpm workspaces monorepo.
- Persistence: SQLite initially; avoid premature infrastructure complexity.
- Ingestion: modular polling and streaming adapters behind one trusted runtime.

Data flow:

```text
Approved provider endpoints
  -> trusted polling/streaming runtime
  -> provider adapter decode
  -> normalized batch validation
  -> state reconciliation and freshness
  -> backend WebSocket API
  -> React / MapLibre layers
```

Adapters understand provider formats. The runtime owns scheduling, connections, retries, validation, credential injection, state updates and broadcasting. The frontend consumes normalized geographic entities and does not depend on provider payload formats.

## 3. Confirmed source examples
| Source | Transport | Semantics | Role |
| --- | --- | --- | --- |
| MTA subway A/C/E | Polling | Snapshot per line/feed group | First real decoder, GTFS-Realtime Protocol Buffers |
| AISStream | Upstream WebSocket | Delta per vessel | Validate streaming behavior |
| USGS, NWS | Polling examples | To be specified per feed | Potential additional sources |

The prior chat illustrated MTA polling at 30 seconds. Treat this as an example, subject to provider limits. AISStream authentication belongs on the server. Source attribution, licensing, timestamps and freshness thresholds belong in the full manifest. Specific feeds, licenses and service terms still require verification.

## 4. State and delivery
Successful MTA feeds replace the snapshot for their particular source scope; trains absent across successive valid updates eventually expire. A failed or invalid feed must not be interpreted as an empty successful snapshot. AIS reports update individual vessels; receiving one vessel does not remove others.

The state manager owns these differences and browser broadcasting. The exact browser WebSocket protocol, subscription limits, snapshot removal grace, stale thresholds and persistence schema were not recoverable and remain implementation decisions. A proposed starting point is an initial state snapshot followed by versioned upsert/remove events, with resynchronization after reconnect.

## 5. ADR-002 — Zero-trust contribution boundary
Status: decision recorded in the source conversation; exact original ADR text unavailable.

Community adapters are reviewed source contributions, not arbitrary executable plugins loaded from the internet. TypeScript compatibility does not establish a security boundary. Only reviewed and merged code may execute in the trusted service.

- Keep API keys and credentials exclusively server-side; never commit or expose secrets.
- Validate all external input and normalized output.
- Use a trusted registry of approved endpoint IDs instead of adapter-supplied arbitrary URLs.
- Centralize network restrictions, authentication, timeouts and payload limits.
- Never supply production secrets to untrusted pull-request workflows.
- Require repository review protections and CODEOWNERS review for sensitive changes.
- Never weaken security controls without approval.

The prior chat explicitly stated that GitHub protection settings were documented but had not been configured. This reconstruction does not configure them.

Proposed enforcement details: restrict redirects and destinations, bound decoding resources and queues, redact logs, isolate fixture-only pull-request tests, and review dependency changes. These are implementation proposals, not recovered wording.

## 6. Repository layout
```text
geoatlas/
  AGENTS.md
  docs/
    system-design.md
    adapter-design.md
  packages/
    adapter-core/
```
Only adapter-core was explicitly named as the first implementation package. Proposed later packages are provider adapters, server and web client; naming remains open.

## 7. Confirmed implementation sequence
1. Implement packages/adapter-core: manifest schemas, normalized entity types, packet validation, state reconciliation and a mock adapter.
2. Test the real-time pipeline without credentials or external API dependencies.
3. Implement MTA A/C/E decoding with GTFS-Realtime Protocol Buffers.
4. Implement AISStream to exercise streaming ingestion.

Use strict TypeScript, runtime validation, meaningful unit/integration tests and incremental changes. Keep adapters independent of the frontend.

## 8. Open decisions and acceptance criteria (reconstructed proposals)
Before production, decide geographic coverage, user access model, basemap provider and licensing, API limits, history retention, deployment model, entity freshness thresholds and supported browser scale. Do not infer these from the product inspiration.

Minimum validation: mock data appears on the map; snapshot scopes remain independent; invalid input cannot clear valid state; stream updates preserve unrelated vessels; disconnects recover; stale data is visible or expired according to explicit policy; credentials never reach browser payloads; server resources remain bounded.

## 9. Recovery provenance
Available evidence: five accessible conversation turns, including the adapter design response, project transfer guidance and complete AGENTS.md example. No attached original Markdown, Word file or original security ADR was returned. This is a usable reconstructed baseline and should be reconciled if originals become available.
