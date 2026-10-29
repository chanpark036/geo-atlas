import { setTimeout as delay } from 'node:timers/promises';
import { LIMITS, type AdapterManifest, type ChangeMessage, type StateManager } from '@geoatlas/adapter-core';

type Payload = string | Uint8Array;
export type Endpoint = { kind: 'poll'; timeoutMs: number; read(signal: AbortSignal): Promise<Payload> }
  | { kind: 'websocket'; idleTimeoutMs: number; open(signal: AbortSignal): AsyncIterable<Payload> };
export type SourceHealth = { adapterId: string; inputId: string; status: 'starting' | 'healthy' | 'retrying' | 'stopped'; lastSuccessAt: string | null; failures: number; error: 'source-update-failed' | null };

/** Registry entries are trusted server code. This milestone has fixture endpoints only. */
export class IngestionRuntime {
  private readonly controller = new AbortController();
  private tasks: Promise<void>[] = [];
  private readonly health = new Map<string, SourceHealth>();
  private started = false;
  constructor(private readonly state: StateManager, private readonly endpoints: ReadonlyMap<string, Endpoint>,
    private readonly publish: (change: ChangeMessage) => void, private readonly random = Math.random) {
    for (const manifest of state.manifests) for (const input of manifest.inputs) {
      const endpoint = endpoints.get(input.endpointId);
      if (!endpoint || endpoint.kind !== input.kind) throw new Error('Undeclared or incompatible endpoint');
      this.health.set(`${manifest.id}|${input.id}`, { adapterId: manifest.id, inputId: input.id, status: 'starting', lastSuccessAt: null, failures: 0, error: null });
    }
  }
  status(): SourceHealth[] { return structuredClone([...this.health.values()]); }
  start(): void {
    if (this.started) throw new Error('Runtime already started');
    this.started = true;
    this.tasks = this.state.manifests.flatMap(manifest => manifest.inputs.map(input => this.run(manifest, input)));
  }
  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.all(this.tasks);
    for (const health of this.health.values()) health.status = 'stopped';
  }
  private accept(manifest: AdapterManifest, input: AdapterManifest['inputs'][number], payload: Payload): void {
    // Bound transport output before handing bytes to the decoder.
    if ((typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength) > LIMITS.packetBytes) throw new Error('Oversize payload');
    const receivedAt = new Date().toISOString();
    const change = this.state.ingest({ adapterId: manifest.id, inputId: input.id, scope: input.scope, receivedAt, payload });
    if (change) this.publish(change);
    const health = this.health.get(`${manifest.id}|${input.id}`)!;
    health.status = 'healthy'; health.lastSuccessAt = receivedAt; health.failures = 0; health.error = null;
  }
  private async run(manifest: AdapterManifest, input: AdapterManifest['inputs'][number]): Promise<void> {
    const endpoint = this.endpoints.get(input.endpointId)!, signal = this.controller.signal;
    const health = this.health.get(`${manifest.id}|${input.id}`)!;
    while (!signal.aborted) {
      const attempt = new AbortController();
      const combined = AbortSignal.any([signal, attempt.signal]);
      try {
        if (endpoint.kind === 'poll') {
          const timeout = AbortSignal.timeout(endpoint.timeoutMs);
          const requestSignal = AbortSignal.any([combined, timeout]);
          this.accept(manifest, input, await abortable(endpoint.read(requestSignal), requestSignal));
        } else {
          const iterator = endpoint.open(combined)[Symbol.asyncIterator]();
          try {
            while (!signal.aborted) {
              const readSignal = AbortSignal.any([combined, AbortSignal.timeout(endpoint.idleTimeoutMs)]);
              const packet = await abortable(iterator.next(), readSignal);
              if (packet.done) throw new Error('Stream ended');
              this.accept(manifest, input, packet.value);
            }
          } finally {
            attempt.abort();
            // Trusted endpoints must honor abort; don't wait on a broken upstream during shutdown.
            void iterator.return?.().catch(() => {});
          }
        }
        await delay(input.kind === 'poll' ? input.intervalMs : 1_000, undefined, { signal });
      } catch {
        if (signal.aborted) break;
        health.status = 'retrying'; health.error = 'source-update-failed'; health.failures++;
        const backoff = Math.min(30_000, 500 * 2 ** Math.min(health.failures - 1, 6)) * (.8 + this.random() * .4);
        try { await delay(backoff, undefined, { signal }); } catch { break; }
      } finally { attempt.abort(); }
    }
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Operation aborted'));
    if (signal.aborted) { reject(new Error('Operation aborted')); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
