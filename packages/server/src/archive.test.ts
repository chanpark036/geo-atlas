import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { RawArchive } from './archive.ts';
import { createApp } from './app.ts';
import { createMtaAdapter, demoCatalog } from '@geoatlas/adapters';
import { mtaFixtureBytes } from '../../adapters/src/test-support.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'geoatlas-archive-'));
  roots.push(root);
  return root;
}
async function records(root: string) {
  const files = (await readdir(root, { recursive: true })).filter((name) =>
    name.endsWith('.ndjson.gz'),
  );
  const rows = [];
  for (const file of files) {
    const lines = gunzipSync(await readFile(join(root, file)))
      .toString()
      .trim()
      .split('\n');
    rows.push(...lines.map((line) => JSON.parse(line)));
  }
  return rows;
}
const time = '2026-11-03T12:00:00.000Z';

it('preserves repeated packets as separate captures with exact bytes, hashes and outcomes', async () => {
  const root = await directory();
  const archive = new RawArchive(root);
  const payload = new Uint8Array([0, 1, 255]);
  archive.record('ace', time, 'changed', payload);
  archive.record('ace', time, 'unchanged', payload);
  archive.record('ace', time, 'rejected', new Uint8Array([255]));
  archive.record('g', time, 'fetch_error');
  await archive.close();
  const rows = await records(root);
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map((row) => row.capture_id)).size).toBe(4);
  expect(rows.find((row) => row.outcome === 'changed')).toMatchObject({
    feed_id: 'ace',
    received_at: time,
    payload_sha256: createHash('sha256').update(payload).digest('hex'),
    payload_base64: Buffer.from(payload).toString('base64'),
  });
  expect(rows.find((row) => row.outcome === 'fetch_error').payload_base64).toBeNull();
  expect(archive.status()).toMatchObject({
    state: 'closed',
    written: 4,
    dropped: 0,
    pendingBytes: 0,
  });
});

it('seals bounded parts and partitions captures by UTC date, feed and hour', async () => {
  const root = await directory();
  const archive = new RawArchive(root, 1024 ** 2, 1);
  archive.record('ace', time, 'fetch_error');
  archive.record('g', '2026-11-04T01:00:00.000Z', 'fetch_error');
  await archive.close();
  const files = await readdir(root, { recursive: true });
  expect(files.some((path) => path.startsWith('date=2026-11-03/feed=ace/hour=12/'))).toBe(true);
  expect(files.some((path) => path.startsWith('date=2026-11-04/feed=g/hour=01/'))).toBe(true);
  expect(files.some((path) => path.endsWith('.open'))).toBe(false);
});

it('pauses at the capacity limit and counts lost captures without throwing into ingestion', async () => {
  const root = await directory();
  const warnings: string[] = [];
  const archive = new RawArchive(root, 1, 16, (message) => warnings.push(message));
  archive.record('ace', time, 'fetch_error');
  archive.record('g', time, 'fetch_error');
  await archive.close();
  expect(archive.status()).toMatchObject({
    state: 'paused',
    error: 'capacity',
    dropped: 2,
    written: 0,
  });
  expect(warnings.join(' ')).toContain('capacity');
});

it('bounds queued memory and reports overflow', async () => {
  const root = await directory();
  const archive = new RawArchive(root, 1024 ** 2 * 20, 16, () => {});
  for (let i = 0; i < 100; i++) archive.record('ace', time, 'rejected', new Uint8Array(262144));
  expect(archive.status().pendingBytes).toBeLessThanOrEqual(4 * 1024 ** 2);
  await archive.close();
  expect(archive.status().dropped).toBeGreaterThan(0);
});

it('recovers complete interrupted parts and retains corrupt parts without publishing them', async () => {
  const root = await directory();
  await writeFile(join(root, 'complete.ndjson.gz.open'), gzipSync('{}\n'));
  await writeFile(join(root, 'partial.ndjson.gz.open'), gzipSync('{}\n').subarray(0, 5));
  const archive = new RawArchive(root, 1024 ** 2, 16, () => {});
  await archive.close();
  const files = await readdir(root);
  expect(files).toContain('complete.ndjson.gz');
  expect(files).toContain('partial.ndjson.gz.open.corrupt');
  expect(archive.status().error).toBe('recovery');
  const restarted = new RawArchive(root, 1024 ** 2, 16, () => {});
  await restarted.close();
  expect(restarted.status().error).toBe('recovery');
});

it('counts existing bytes after restart and never overwrites earlier captures', async () => {
  const root = await directory();
  const first = new RawArchive(root);
  first.record('ace', time, 'fetch_error');
  await first.close();
  const second = new RawArchive(root);
  second.record('ace', time, 'fetch_error');
  await second.close();
  expect(await records(root)).toHaveLength(2);
  expect(second.status().diskBytes).toBeGreaterThan(first.status().diskBytes);
});

it('archives decoder failures while keeping the live snapshot reconciliation rules', async () => {
  const root = await directory();
  const adapter = createMtaAdapter(demoCatalog);
  let reads = 0;
  const { app, archive, state } = await createApp({
    adapters: [adapter],
    catalog: demoCatalog,
    archiveDirectory: root,
    endpoints: new Map([
      [
        'mta-ace',
        {
          kind: 'poll' as const,
          timeoutMs: 1000,
          async read() {
            reads++;
            return new Uint8Array([255]);
          },
        },
      ],
    ]),
  });
  await app.close();
  expect(reads).toBe(1);
  expect(state.snapshot().entities).toEqual([]);
  expect(archive!.status().written).toBe(1);
  expect((await records(root))[0].outcome).toBe('rejected');
});

it('continues live ingestion when archive storage is unavailable', async () => {
  const root = await directory();
  const blocked = join(root, 'not-a-directory');
  await writeFile(blocked, 'blocked');
  const adapter = createMtaAdapter(demoCatalog);
  const { app, state, archive } = await createApp({
    adapters: [adapter],
    catalog: demoCatalog,
    archiveDirectory: blocked,
    endpoints: new Map([
      [
        'mta-ace',
        {
          kind: 'poll' as const,
          timeoutMs: 1000,
          async read() {
            return mtaFixtureBytes(Math.floor(Date.now() / 1000));
          },
        },
      ],
    ]),
  });
  await archive!.close();
  const status = await app.inject('/api/archive/status');
  expect(status.statusCode).toBe(503);
  expect(status.json()).toMatchObject({ enabled: true, state: 'paused', error: 'storage' });
  await app.close();
  expect(state.snapshot().entities).toHaveLength(1);
});

it('records failed fetches without recording provider error messages or touching live state', async () => {
  const root = await directory();
  const { app, state } = await createApp({
    adapters: [createMtaAdapter(demoCatalog)],
    catalog: demoCatalog,
    archiveDirectory: root,
    endpoints: new Map([
      [
        'mta-ace',
        {
          kind: 'poll' as const,
          timeoutMs: 1000,
          async read() {
            throw new Error('SECRET-CANARY');
          },
        },
      ],
    ]),
  });
  await app.close();
  const captures = await records(root);
  expect(captures).toHaveLength(1);
  expect(captures[0]).toMatchObject({ outcome: 'fetch_error', payload_base64: null });
  expect(JSON.stringify(captures)).not.toContain('SECRET-CANARY');
  expect(state.snapshot().entities).toEqual([]);
});
