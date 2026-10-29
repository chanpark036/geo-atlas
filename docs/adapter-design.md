# RFC 0002 — GeoAtlas Data Adapter Contract

> **Implementation update (2026-10-29):** This recovered baseline is supplemented by [accepted implementation decisions](implementation-decisions.md), which resolve ordering, completeness, deletion, persistence, reconnect, animation, and first-milestone scope. Use that document and the runtime schemas for the implemented contract; historical proposals below are retained for provenance.

> Reconstruction dated 2026-10-29. The original attachment was unavailable. This document is recreated from the accessible “Assess Clone Difficulty” conversation (6ae2eb0c-c32c-83ea-b5a1-6ab3155e28c6), not a byte-for-byte recovery. Decisions explicitly present in that record are distinguished below from proposed implementation details. Provider configuration and current API requirements have not been verified.

## Status and recovered decisions
The conversation established two adapter types—polling and streaming—behind one trusted ingestion runtime. Its exact core contract was:

```typescript
interface DataAdapter {
  readonly manifest: AdapterManifest;
  decode(packet: SourcePacket): readonly AdapterBatch[];
}
```

The types below complete that outline as a **proposed reconstruction**. They are not the recovered original TypeScript definitions and require review before implementation.

## Implemented batch contract

The current schemas live in `packages/adapter-core/src/schema.ts`. In addition to the recovered fields, the manifest requires `snapshotGrace`. One decoded packet targets exactly its registered input and scope and yields zero or one batch:

```typescript
type AdapterBatch = {
  inputId: string;
  scope: string;
  entities: GeoEntity[];
} & (
  | { kind: "snapshot"; complete: true; publishedAt: string }
  | { kind: "delta"; removals: { id: string; observedAt: string }[] }
);
```

`[]` means an intentionally ignored packet. A valid empty snapshot is an explicit complete batch with `entities: []`. Errors never imply emptiness. Timestamped delta removals replace the reconstructed `removedIds` proposal below. See [accepted decisions](implementation-decisions.md) for ordering and tie policies.

## Reconstructed proposed manifest and packet types
```typescript
type Semantics = "snapshot" | "delta";
type Input = {
  id: string;
  endpointId: string;
  scope: string;
  semantics: Semantics;
} & (
  | { kind: "poll"; intervalMs: number }
  | { kind: "websocket" }
);
interface AdapterManifest {
  id: string;
  layer: string;
  attribution: string;
  license: { name: string; url?: string };
  staleAfterMs: number;
  expireAfterMs: number;
  inputs: readonly Input[];
}
interface SourcePacket {
  adapterId: string;
  inputId: string;
  scope: string;
  receivedAt: string; // UTC ISO 8601, assigned by runtime
  payload: Uint8Array | string; // bounded before decoding
}
interface GeoEntity {
  id: string; // provider-stable ID within adapter namespace
  longitude: number;
  latitude: number;
  observedAt: string; // provider observation time; fallback policy explicit
  properties: Readonly<Record<string, string | number | boolean | null>>;
}
interface AdapterBatch {
  inputId: string;
  scope: string;
  entities: readonly GeoEntity[];
  removedIds?: readonly string[]; // delta only
}
```

The runtime resolves adapter identity, semantics, layer, attribution and freshness from the registered manifest. It must reject batches targeting another input or scope. TypeScript is supplemented with strict runtime schemas (Zod was proposed in the conversation). Validate finite coordinates, latitude/longitude ranges, bounded identifiers and properties, timestamps, collection sizes and manifest invariants such as expireAfterMs >= staleAfterMs. Do not accept arbitrary HTML in entity properties.

## Runtime responsibilities
Confirmed responsibilities: scheduling, upstream connections, retries, validation, credential injection, state reconciliation and broadcasting.

Proposed operational details:
- Poll centrally, prevent overlapping requests per input, enforce provider limits, time out requests and apply bounded exponential backoff with jitter.
- Reconnect streams with backoff, detect dead connections and bound queues. Subscription construction and authentication live in trusted provider configuration.
- Enforce payload, decoding, entity-count and output-size limits; record sanitized health metrics.
- Apply an accepted batch atomically after validation. Decoder failures produce health errors, never implicit empty snapshots.
- Sequence work per source scope and reject stale/out-of-order updates according to an explicit policy.
- Abort connections and pending work cleanly on shutdown.

The synchronous decode contract cannot by itself interrupt CPU-bound malicious code. Reviewed adapters execute as trusted backend code. Additional process isolation, if needed, is a separate architecture decision.

## Snapshot and delta semantics
Confirmed: MTA snapshots are reconciled within their specific line/feed group. Missing trains expire across successive valid updates. AIS messages update one vessel without deleting others.

Proposed state key: (adapterId, inputId, scope, entityId). A valid snapshot marks unseen entities missing only in that scope. Configure the removal grace explicitly; its exact count/duration was not recovered. Failed, partial or malformed snapshots must not trigger disappearance reconciliation. A successfully decoded complete empty snapshot may do so. Delta batches upsert supplied entities, apply validated explicit removals, and leave all unrelated state intact. Freshness/expiry uses documented clocks and policy; late reports must not overwrite newer observations.

## Recovered abbreviated examples
These appeared in the conversation and omit required metadata:

```typescript
// MTA subway
{
  id: "mta-subway",
  layer: "subway",
  inputs: [{
    kind: "poll",
    endpointId: "mta-ace",
    intervalMs: 30_000,
    semantics: "snapshot"
  }]
}

// AISStream
{
  id: "aisstream",
  layer: "ship",
  inputs: [{
    kind: "websocket",
    endpointId: "aisstream-harbor",
    semantics: "delta"
  }]
}
```

To use the proposed complete types, add input IDs, source scopes, attribution, verified license metadata and explicit freshness thresholds.

MTA decoding uses GTFS-Realtime Protocol Buffers. **Open issue:** confirm which feeds provide actual coordinates; if only stop/trip predictions are available, decide how static GTFS data or interpolation supplies map positions and label inferred positions. Do not invent precise train locations.

AISStream decoding maps vessel reports to stable vessel identities and coordinates, with any static metadata joined by identity. API keys are server-side. Verify current payload schemas and subscription requirements before coding.

## Endpoint registry and contribution security
Confirmed: adapters reference approved endpoint IDs instead of arbitrary URLs. Trusted backend configuration handles credentials, timeouts, network restrictions and payload limits. Adapters do not receive raw secrets. Never execute unreviewed downloadable plugins. Review and merge contributions before enabling them. Required CODEOWNERS and repository protection settings must be configured separately.

Proposed registry fields: endpoint ID, approved transport/host/path, authentication reference, request/subscription template, allowed redirects, response limits and timeout. Credential-bearing requests and provider error bodies must be redacted from logs. Reject undeclared endpoint references and scope changes.

## Proposed tests and implementation order
Start with adapter-core and mock fixtures, then MTA, then AISStream.

Test manifest validation, malformed packets, bounded output, duplicate identities, invalid coordinates/timestamps, snapshot scope isolation, absence grace, valid empty snapshots, invalid snapshots preserving prior state, delta preservation, stale ordering, freshness expiry, reconnect and retry behavior, and secret redaction. Use deterministic clocks and fixture providers; do not require production credentials in pull-request tests.

## Unresolved details
Original full types, endpoint registry schema, exact freshness defaults, removal grace, browser event schema, provider license details and complete test cases were not accessible. The proposals above make the recovered decisions reviewable without presenting missing details as established agreements.
