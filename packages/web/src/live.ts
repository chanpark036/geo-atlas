import {
  wireMessageSchema,
  LIMITS,
  type TrackedEntity,
  type WireMessage,
} from '@geoatlas/adapter-core';
export type Connection = 'connecting' | 'live' | 'reconnecting';
export class Replica {
  private epoch: string | undefined;
  private revision = 0;
  private entities = new Map<string, TrackedEntity>();
  reset(): void {
    this.epoch = undefined;
  }
  apply(raw: unknown): { entities: TrackedEntity[]; snapshot: boolean } {
    const message: WireMessage = wireMessageSchema.parse(raw);
    if (message.type === 'snapshot') {
      if (new Set(message.entities.map((e) => e.key)).size !== message.entities.length)
        throw new Error('Duplicate snapshot key');
      this.entities = new Map(message.entities.map((e) => [e.key, e]));
      this.epoch = message.epoch;
      this.revision = message.revision;
    } else {
      if (!this.epoch || message.epoch !== this.epoch || message.revision !== this.revision + 1)
        throw new Error('Resynchronization required');
      const next = new Map(this.entities);
      for (const key of message.removed) next.delete(key);
      for (const entity of message.upserts) next.set(entity.key, entity);
      if (next.size > LIMITS.stateEntities) throw new Error('Replica capacity exceeded');
      this.entities = next;
      this.revision = message.revision;
    }
    return { entities: [...this.entities.values()], snapshot: message.type === 'snapshot' };
  }
}
export function connectLive(
  onEntities: (entities: TrackedEntity[], snapshot: boolean) => void,
  onStatus: (status: Connection) => void,
): () => void {
  const replica = new Replica();
  let stopped = false,
    attempts = 0,
    socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    if (stopped) return;
    replica.reset();
    onStatus(attempts ? 'reconnecting' : 'connecting');
    socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live`,
    );
    const current = socket;
    current.onmessage = (event) => {
      try {
        if (
          typeof event.data !== 'string' ||
          new TextEncoder().encode(event.data).byteLength > LIMITS.wireBytes
        )
          throw new Error('Invalid message');
        const result = replica.apply(JSON.parse(event.data));
        attempts = 0;
        onStatus('live');
        onEntities(result.entities, result.snapshot);
      } catch {
        current.close(1002, 'Resynchronization required');
      }
    };
    current.onerror = () => current.close();
    current.onclose = () => {
      if (stopped) return;
      onStatus('reconnecting');
      retry = setTimeout(
        connect,
        Math.min(15_000, 500 * 2 ** Math.min(attempts++, 5)) * (0.8 + Math.random() * 0.4),
      );
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
  };
}
