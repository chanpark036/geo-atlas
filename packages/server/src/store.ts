import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LIMITS, type Checkpoint } from '@geoatlas/adapter-core';

/** Single bounded current-state checkpoint. No history or credential storage. */
export class SqliteStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)',
    );
  }
  load(): unknown | undefined {
    const row = this.db.prepare('SELECT value FROM checkpoint WHERE id = 1').get();
    if (!row) return undefined;
    if (typeof row.value !== 'string' || Buffer.byteLength(row.value) > LIMITS.wireBytes)
      throw new Error('Invalid checkpoint');
    return JSON.parse(row.value);
  }
  save(checkpoint: Checkpoint): void {
    this.db
      .prepare(
        'INSERT INTO checkpoint (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(JSON.stringify(checkpoint));
  }
  close(): void {
    this.db.close();
  }
}
