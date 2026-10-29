import { z } from 'zod';
import { batchSchema, LIMITS, manifestSchema, packetSchema, trackedEntitySchema, type AdapterManifest, type ChangeMessage, type DataAdapter, type SourcePacket, type TrackedEntity, type WireMessage } from './schema.ts';

const tombstoneSchema = z.strictObject({ observedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative() });
const checkpointSchema = z.strictObject({
  version: z.literal(1), entities: z.array(trackedEntitySchema).max(LIMITS.stateEntities),
  watermarks: z.record(z.string().max(256), z.number().int().nonnegative()).refine(v => Object.keys(v).length <= 256),
  tombstones: z.record(z.string().max(384), tombstoneSchema).refine(v => Object.keys(v).length <= LIMITS.tombstones),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
export const scopeKey = (adapterId: string, inputId: string, scope: string) => `${adapterId}|${inputId}|${scope}`;
export const entityKey = (adapterId: string, inputId: string, scope: string, id: string) => `${scopeKey(adapterId, inputId, scope)}|${id}`;

/** One complete, validated batch per packet. [] means ignored, never empty state. */
export class StateManager {
  readonly manifests: readonly AdapterManifest[];
  private records = new Map<string, TrackedEntity>();
  private watermarks: Checkpoint['watermarks'] = {};
  private tombstones: Checkpoint['tombstones'] = {};
  private revision = 0;
  private readonly adapters = new Map<string, DataAdapter>();
  constructor(adapters: readonly DataAdapter[], private readonly epoch: string,
    private readonly save: (checkpoint: Checkpoint) => void = () => {}, checkpoint?: unknown) {
    this.manifests = adapters.map(a => manifestSchema.parse(a.manifest));
    if (new Set(this.manifests.map(m => m.id)).size !== adapters.length || adapters.length > 16) throw new Error('Invalid adapter registry');
    adapters.forEach((a, index) => this.adapters.set(a.manifest.id, { manifest: this.manifests[index]!, decode: a.decode.bind(a) }));
    if (checkpoint !== undefined) {
      const restored = checkpointSchema.parse(checkpoint);
      const knownScopes = new Set(this.manifests.flatMap(m => m.inputs.map(i => scopeKey(m.id, i.id, i.scope))));
      if (Object.keys(restored.watermarks).some(k => !knownScopes.has(k)) || Object.keys(restored.tombstones).some(k => !knownScopes.has(k.split('|').slice(0, 3).join('|')))) throw new Error('Unknown persisted scope');
      for (const entity of restored.entities) {
        const manifest = this.adapters.get(entity.adapterId)?.manifest;
        if (!manifest || !knownScopes.has(scopeKey(entity.adapterId, entity.inputId, entity.scope)) || entity.layer !== manifest.layer || entity.key !== entityKey(entity.adapterId, entity.inputId, entity.scope, entity.id) || this.records.has(entity.key)) throw new Error('Invalid persisted identity');
        this.records.set(entity.key, entity);
      }
      this.watermarks = restored.watermarks;
      this.tombstones = restored.tombstones;
    }
  }
  snapshot(): Extract<WireMessage, { type: 'snapshot' }> {
    return structuredClone({ protocol: 1, type: 'snapshot', epoch: this.epoch, revision: this.revision, entities: [...this.records.values()] });
  }
  checkpoint(): Checkpoint { return structuredClone({ version: 1, entities: [...this.records.values()], watermarks: this.watermarks, tombstones: this.tombstones }); }

  ingest(raw: SourcePacket, now = Date.now()): ChangeMessage | null {
    const packet = packetSchema.parse(raw);
    const adapter = this.adapters.get(packet.adapterId);
    const input = adapter?.manifest.inputs.find(i => i.id === packet.inputId && i.scope === packet.scope);
    if (!adapter || !input) throw new Error('Undeclared input or scope');
    const received = Date.parse(packet.receivedAt);
    if (received > now + 5_000) throw new Error('Invalid receipt clock');
    const scope = scopeKey(packet.adapterId, packet.inputId, packet.scope);
    const decoded = adapter.decode(packet);
    if (!Array.isArray(decoded) || decoded.length > 1) throw new Error('Expected at most one complete batch');
    if (!decoded.length) return null;
    const batch = batchSchema.parse(decoded[0]);
    if (batch.inputId !== input.id || batch.scope !== input.scope || batch.kind !== input.semantics) throw new Error('Cross-scope or semantics mismatch');
    const ids = batch.entities.map(e => e.id), removals = batch.kind === 'delta' ? batch.removals : [];
    const removedIds = removals.map(e => e.id);
    if (new Set(ids).size !== ids.length || new Set(removedIds).size !== removedIds.length || removedIds.some(id => ids.includes(id))) throw new Error('Duplicate or conflicting identity');
    const events = [...batch.entities, ...removals];
    if (events.some(e => Date.parse(e.observedAt) > received + LIMITS.futureSkewMs)) throw new Error('Future observation');
    const published = batch.kind === 'snapshot' ? Date.parse(batch.publishedAt) : null;
    if (published !== null) {
      if (published > received + LIMITS.futureSkewMs || batch.entities.some(e => Date.parse(e.observedAt) > published + LIMITS.futureSkewMs)) throw new Error('Invalid publication clock');
      // Publication order, never download order. Replays cannot advance absence grace.
      if (published <= (this.watermarks[scope] ?? -1)) return null;
    }
    const next = new Map(this.records), manifest = adapter.manifest;
    const tombstones = this.prunedTombstones(now);
    const seen = new Set(ids);
    for (const entity of batch.entities) {
      const key = entityKey(manifest.id, input.id, input.scope, entity.id), previous = next.get(key);
      const observed = Date.parse(entity.observedAt);
      if (observed <= (tombstones[key]?.observedAt ?? -1) || now - observed >= manifest.expireAfterMs) continue;
      if (previous && observed <= Date.parse(previous.observedAt)) {
        // Presence may reset absence grace; duplicate observations don't refresh their age.
        if (batch.kind === 'snapshot' && previous.missingSnapshots) next.set(key, { ...previous, missingSnapshots: 0 });
        continue;
      }
      next.set(key, { ...entity, key, adapterId: manifest.id, inputId: input.id, scope: input.scope, layer: manifest.layer,
        receivedAt: packet.receivedAt, stale: now - observed >= manifest.staleAfterMs, missingSnapshots: 0 });
      delete tombstones[key];
    }
    for (const removal of removals) {
      const key = entityKey(manifest.id, input.id, input.scope, removal.id), previous = next.get(key), observedAt = Date.parse(removal.observedAt);
      if (observedAt < Date.parse(previous?.observedAt ?? '1970-01-01T00:00:00Z') || observedAt <= (tombstones[key]?.observedAt ?? -1)) continue;
      next.delete(key);
      tombstones[key] = { observedAt, expiresAt: now + LIMITS.tombstoneTtlMs };
    }
    if (batch.kind === 'snapshot') for (const [key, entity] of next) {
      if (scopeKey(entity.adapterId, entity.inputId, entity.scope) !== scope || seen.has(entity.id)) continue;
      const missingSnapshots = entity.missingSnapshots + 1;
      if (missingSnapshots >= manifest.snapshotGrace) {
        next.delete(key);
        tombstones[key] = { observedAt: Math.max(published!, Date.parse(entity.observedAt)), expiresAt: now + LIMITS.tombstoneTtlMs };
      } else next.set(key, { ...entity, missingSnapshots });
    }
    return this.commit(next, published === null ? this.watermarks : { ...this.watermarks, [scope]: published }, tombstones);
  }
  sweep(now = Date.now()): ChangeMessage | null {
    const next = new Map(this.records), tombstones = this.prunedTombstones(now);
    for (const [key, entity] of next) {
      const manifest = this.adapters.get(entity.adapterId)!.manifest, observedAt = Date.parse(entity.observedAt), age = now - observedAt;
      if (age >= manifest.expireAfterMs) {
        next.delete(key);
        tombstones[key] = { observedAt, expiresAt: now + LIMITS.tombstoneTtlMs };
      } else if (age >= manifest.staleAfterMs && !entity.stale) next.set(key, { ...entity, stale: true });
    }
    return this.commit(next, this.watermarks, tombstones);
  }
  private prunedTombstones(now: number): Checkpoint['tombstones'] {
    return Object.fromEntries(Object.entries(this.tombstones).filter(([, v]) => v.expiresAt > now));
  }
  private commit(next: Map<string, TrackedEntity>, watermarks: Checkpoint['watermarks'], tombstones: Checkpoint['tombstones']): ChangeMessage | null {
    if (next.size > LIMITS.stateEntities || Object.keys(tombstones).length > LIMITS.tombstones) throw new Error('State capacity exceeded');
    const upserts = [...next.values()].filter(e => JSON.stringify(this.records.get(e.key)) !== JSON.stringify(e));
    const removed = [...this.records.keys()].filter(k => !next.has(k));
    const checkpoint: Checkpoint = { version: 1, entities: [...next.values()], watermarks, tombstones };
    if (new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength > LIMITS.wireBytes - 4096) throw new Error('State byte capacity exceeded');
    const bookkeepingChanged = watermarks !== this.watermarks || JSON.stringify(tombstones) !== JSON.stringify(this.tombstones);
    // Durable write succeeds before publication. A failed write leaves memory untouched.
    if (upserts.length || removed.length || bookkeepingChanged) this.save(structuredClone(checkpoint));
    this.records = next;
    this.watermarks = watermarks;
    this.tombstones = tombstones;
    if (!upserts.length && !removed.length) return null;
    return structuredClone({ protocol: 1, type: 'change', epoch: this.epoch, revision: ++this.revision, upserts, removed });
  }
}
