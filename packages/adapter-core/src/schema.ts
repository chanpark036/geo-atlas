import { z } from 'zod';

export const LIMITS = Object.freeze({ packetBytes: 262_144, batchEntities: 500, stateEntities: 2_000, wireBytes: 2_097_152, futureSkewMs: 60_000, tombstones: 4_000, tombstoneTtlMs: 604_800_000 });
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const entityIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_ .:/-]+$/);
export const timestampSchema = z.iso.datetime();
const text = (max: number) => z.string().min(1).max(max).refine(v => !/[<>\u0000-\u001f]/.test(v), 'Plain text required');
const inputFields = { id: idSchema, endpointId: idSchema, scope: idSchema, semantics: z.enum(['snapshot', 'delta']) };
export const inputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...inputFields, kind: z.literal('poll'), intervalMs: z.number().int().min(250).max(86_400_000) }),
  z.strictObject({ ...inputFields, kind: z.literal('websocket') }),
]);
export const manifestSchema = z.strictObject({
  id: idSchema, layer: idSchema, attribution: text(256),
  license: z.strictObject({ name: text(128), url: z.url().refine(v => v.startsWith('https://')).optional() }),
  staleAfterMs: z.number().int().min(1_000).max(86_400_000),
  expireAfterMs: z.number().int().min(1_000).max(604_800_000),
  snapshotGrace: z.number().int().min(1).max(10),
  inputs: z.array(inputSchema).min(1).max(16),
}).superRefine((m, ctx) => {
  if (m.expireAfterMs < m.staleAfterMs) ctx.addIssue({ code: 'custom', message: 'Expiry must follow staleness' });
  if (new Set(m.inputs.map(i => i.id)).size !== m.inputs.length) ctx.addIssue({ code: 'custom', message: 'Duplicate input ID' });
});
const propertyName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
export const entitySchema = z.strictObject({
  id: entityIdSchema, longitude: z.number().finite().min(-180).max(180), latitude: z.number().finite().min(-90).max(90),
  observedAt: timestampSchema,
  properties: z.record(propertyName, z.union([text(256), z.number().finite(), z.boolean(), z.null()]))
    .refine(v => Object.keys(v).length <= 16, 'Too many properties'),
});
export const packetSchema = z.strictObject({
  adapterId: idSchema, inputId: idSchema, scope: idSchema, receivedAt: timestampSchema,
  payload: z.union([z.string(), z.custom<Uint8Array>(v => v instanceof Uint8Array)]),
}).refine(p => (typeof p.payload === 'string' ? new TextEncoder().encode(p.payload).length : p.payload.byteLength) <= LIMITS.packetBytes, 'Packet too large');
const batchFields = { inputId: idSchema, scope: idSchema, entities: z.array(entitySchema).max(LIMITS.batchEntities) };
export const batchSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...batchFields, kind: z.literal('snapshot'), complete: z.literal(true), publishedAt: timestampSchema }),
  z.strictObject({ ...batchFields, kind: z.literal('delta'), removals: z.array(z.strictObject({ id: entityIdSchema, observedAt: timestampSchema })).max(LIMITS.batchEntities) }),
]);
export type AdapterManifest = z.infer<typeof manifestSchema>;
export type AdapterInput = z.infer<typeof inputSchema>;
export type GeoEntity = z.infer<typeof entitySchema>;
export type SourcePacket = z.infer<typeof packetSchema>;
export type AdapterBatch = z.infer<typeof batchSchema>;
export interface DataAdapter { readonly manifest: AdapterManifest; decode(packet: SourcePacket): readonly AdapterBatch[] }

export const trackedEntitySchema = entitySchema.extend({
  key: z.string().max(384), adapterId: idSchema, inputId: idSchema, scope: idSchema, layer: idSchema,
  receivedAt: timestampSchema, stale: z.boolean(), missingSnapshots: z.number().int().min(0).max(10),
});
export type TrackedEntity = z.infer<typeof trackedEntitySchema>;
export const wireMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ protocol: z.literal(1), type: z.literal('snapshot'), epoch: z.string().uuid(), revision: z.number().int().nonnegative(), entities: z.array(trackedEntitySchema).max(LIMITS.stateEntities) }),
  z.strictObject({ protocol: z.literal(1), type: z.literal('change'), epoch: z.string().uuid(), revision: z.number().int().positive(), upserts: z.array(trackedEntitySchema).max(LIMITS.stateEntities), removed: z.array(z.string().max(384)).max(LIMITS.stateEntities) }),
]);
export type WireMessage = z.infer<typeof wireMessageSchema>;
export type ChangeMessage = Extract<WireMessage, { type: 'change' }>;

export const catalogSchema = z.strictObject({
  routes: z.array(z.strictObject({
    id: z.string().max(32), name: z.string().max(128), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    coordinates: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(2).max(2000),
    stops: z.array(z.strictObject({ id: idSchema, name: z.string().max(128), pathIndex: z.number().int().nonnegative() })).max(100),
  })).max(16),
});
export type Catalog = z.infer<typeof catalogSchema>;
