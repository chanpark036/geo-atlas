import { catalogSchema, type Catalog, type TrackedEntity } from '@geoatlas/adapter-core';
import type { LiveUpdate } from './live';

export type CatalogSyncStatus = 'loading' | 'ready' | 'retrying';
interface SynchronizedState {
  catalog: Catalog;
  entities: TrackedEntity[];
  reset: boolean;
}
type CatalogLoader = (epoch: string, signal: AbortSignal) => Promise<Catalog>;

export async function loadCatalogForEpoch(epoch: string, signal: AbortSignal): Promise<Catalog> {
  const response = await fetch('/api/catalog', {
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  });
  if (!response.ok || response.headers.get('X-GeoAtlas-Epoch') !== epoch) {
    throw new Error('Catalog does not match the current stream');
  }
  return catalogSchema.parse(await response.json());
}

/** Publish geometry and reports together; never mix a new stream with an old route catalog. */
export class CatalogSynchronizer {
  private latest: LiveUpdate | undefined;
  private catalog: Catalog | undefined;
  private catalogFingerprint = '';
  private displayedEpoch: string | undefined;
  private generation = 0;
  private loading = false;
  private disposed = false;
  private failures = 0;
  private controller: AbortController | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly load: CatalogLoader,
    private readonly apply: (state: SynchronizedState) => void,
    private readonly status: (status: CatalogSyncStatus) => void,
  ) {}

  accept(update: LiveUpdate): void {
    if (this.disposed) return;
    if (!update.snapshot && update.epoch !== this.latest?.epoch) {
      throw new Error('A catalog refresh requires a stream snapshot');
    }
    this.latest = update;
    if (update.snapshot) {
      this.failures = 0;
      this.refresh(update.epoch);
    } else if (!this.loading && this.catalog && this.displayedEpoch === update.epoch) {
      this.apply({ catalog: this.catalog, entities: update.entities, reset: false });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.controller?.abort();
    clearTimeout(this.retry);
  }

  private refresh(epoch: string): void {
    clearTimeout(this.retry);
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    this.loading = true;
    this.status('loading');
    void this.load(epoch, controller.signal)
      .then((catalog) => {
        if (this.disposed || generation !== this.generation) return;
        const latest = this.latest!;
        const fingerprint = JSON.stringify(catalog);
        // Preserve the viewport and map instance when a reconnect returns an identical catalog.
        if (fingerprint !== this.catalogFingerprint) this.catalog = catalog;
        this.catalogFingerprint = fingerprint;
        this.displayedEpoch = epoch;
        this.loading = false;
        this.failures = 0;
        this.apply({ catalog: this.catalog!, entities: latest.entities, reset: true });
        this.status('ready');
      })
      .catch(() => {
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return;
        this.status('retrying');
        const backoff = Math.min(15_000, 500 * 2 ** Math.min(this.failures++, 5));
        this.retry = setTimeout(() => this.refresh(epoch), backoff);
      });
  }
}
