import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { LIMITS, MTA_FEEDS } from '@geoatlas/adapter-core';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const feeds = new Set<string>(MTA_FEEDS.map((feed) => feed.id));
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

export type CaptureOutcome = 'changed' | 'unchanged' | 'rejected' | 'fetch_error';
export interface ArchiveStatus {
  enabled: true;
  state: 'starting' | 'recording' | 'paused' | 'closed';
  written: number;
  dropped: number;
  pendingBytes: number;
  diskBytes: number;
  maxBytes: number;
  error: 'capacity' | 'queue_full' | 'storage' | 'recovery' | null;
}
type Segment = { path: string; handle: FileHandle; hour: string; records: number };

/** Bounded, asynchronous capture. Archive failures never change live reconciliation. */
export class RawArchive {
  private readonly session = randomUUID();
  private readonly segments = new Map<string, Segment>();
  private sequence = 0;
  private closing = false;
  private tail: Promise<void>;
  private readonly health: ArchiveStatus;

  constructor(
    private readonly root: string,
    maxBytes = 2 * 1024 ** 3,
    private readonly segmentRecords = 16,
    private readonly warn: (message: string) => void = console.error,
  ) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 100 * 1024 ** 3 ||
      !Number.isInteger(segmentRecords) ||
      segmentRecords < 1 ||
      segmentRecords > 16
    ) {
      throw new Error('Invalid archive bounds');
    }
    this.health = {
      enabled: true,
      state: 'starting',
      written: 0,
      dropped: 0,
      pendingBytes: 0,
      diskBytes: 0,
      maxBytes,
      error: null,
    };
    this.tail = this.initialize().catch(() => this.pause('storage'));
  }

  status(): ArchiveStatus {
    return { ...this.health };
  }

  record(feed: string, receivedAt: string, outcome: CaptureOutcome, payload?: Uint8Array): void {
    if (
      !feeds.has(feed) ||
      !Number.isFinite(Date.parse(receivedAt)) ||
      (payload && payload.byteLength > LIMITS.packetBytes)
    )
      return;
    if (this.closing || this.health.state === 'paused') {
      this.health.dropped++;
      return;
    }
    const record =
      JSON.stringify({
        version: 1,
        capture_id: randomUUID(),
        feed_id: feed,
        received_at: receivedAt,
        outcome,
        payload_sha256: payload ? createHash('sha256').update(payload).digest('hex') : null,
        payload_base64: payload ? Buffer.from(payload).toString('base64') : null,
      }) + '\n';
    const bytes = Buffer.byteLength(record);
    if (this.health.pendingBytes + bytes > MAX_PENDING_BYTES) {
      this.health.dropped++;
      this.health.error = 'queue_full';
      this.warn('GeoAtlas archive queue full; capture dropped. See /api/archive/status.');
      return;
    }
    this.health.pendingBytes += bytes;
    let persisted = false;
    this.tail = this.tail
      .then(async () => {
        if (this.health.state === 'paused') {
          this.health.dropped++;
          return;
        }
        const compressed = await compress(record);
        if (this.health.diskBytes + compressed.byteLength > this.health.maxBytes) {
          this.health.dropped++;
          this.pause('capacity');
          return;
        }
        const hour = new Date(receivedAt).toISOString().slice(0, 13);
        let segment = this.segments.get(feed);
        if (segment && (segment.hour !== hour || segment.records >= this.segmentRecords)) {
          await this.seal(feed);
          segment = undefined;
        }
        if (!segment) {
          const directory = join(
            this.root,
            `date=${hour.slice(0, 10)}`,
            `feed=${feed}`,
            `hour=${hour.slice(11)}`,
          );
          await mkdir(directory, { recursive: true });
          const path = join(directory, `part-${this.session}-${++this.sequence}.ndjson.gz.open`);
          segment = { path, hour, records: 0, handle: await open(path, 'wx', 0o600) };
          this.segments.set(feed, segment);
        }
        await segment.handle.writeFile(compressed);
        await segment.handle.sync();
        segment.records++;
        this.health.diskBytes += compressed.byteLength;
        this.health.written++;
        persisted = true;
        if (segment.records >= this.segmentRecords) await this.seal(feed);
      })
      .catch(() => {
        if (!persisted) this.health.dropped++;
        this.pause('storage');
      })
      .finally(() => {
        this.health.pendingBytes -= bytes;
      });
  }

  async close(): Promise<void> {
    if (this.closing) return this.tail;
    this.closing = true;
    this.tail = this.tail.then(async () => {
      for (const feed of this.segments.keys()) {
        try {
          await this.seal(feed);
        } catch {
          this.pause('storage');
        }
      }
      if (this.health.state !== 'paused') this.health.state = 'closed';
    });
    await this.tail;
  }

  private pause(reason: 'capacity' | 'storage'): void {
    this.health.state = 'paused';
    this.health.error = reason;
    this.warn(
      `GeoAtlas archive paused: ${reason}. Live ingestion continues. See /api/archive/status.`,
    );
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let count = 0;
    const scan = async (directory: string, depth: number): Promise<void> => {
      if (depth > 4) throw new Error('Archive directory depth exceeded');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++count > 50_000 || entry.isSymbolicLink()) throw new Error('Invalid archive tree');
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await scan(path, depth + 1);
        else if (entry.isFile()) {
          const handle = await open(path, 'r');
          const { size } = await handle.stat();
          await handle.close();
          this.health.diskBytes += size;
          if (entry.name.endsWith('.corrupt')) this.health.error = 'recovery';
          if (entry.name.endsWith('.ndjson.gz.open')) {
            try {
              if (size > MAX_SEGMENT_BYTES) throw new Error('Oversize segment');
              const raw = await decompress(await readFile(path), {
                maxOutputLength: MAX_SEGMENT_BYTES,
              });
              if (!raw.length || raw.at(-1) !== 10) throw new Error('Partial capture');
              await rename(path, path.slice(0, -5));
            } catch {
              await rename(path, path + '.corrupt');
              this.health.error = 'recovery';
              this.warn('GeoAtlas retained an incomplete archive segment for inspection.');
            }
          }
        } else throw new Error('Unsupported archive entry');
      }
    };
    await scan(this.root, 0);
    if (this.health.diskBytes >= this.health.maxBytes) this.pause('capacity');
    else this.health.state = 'recording';
  }

  private async seal(feed: string): Promise<void> {
    const segment = this.segments.get(feed);
    if (!segment) return;
    this.segments.delete(feed);
    try {
      await segment.handle.sync();
    } finally {
      await segment.handle.close();
    }
    await rename(segment.path, segment.path.slice(0, -5));
  }
}
