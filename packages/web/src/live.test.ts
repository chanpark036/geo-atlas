import { expect, it } from 'vitest';
import { Replica } from './live';
const epoch = 'f7df76ee-67b7-4d48-b946-8e5e26ad8eb7';
const snapshot = { protocol: 1, type: 'snapshot', epoch, revision: 3, entities: [] };
it('requires an initial snapshot and contiguous revisions within the same server epoch', () => {
  const replica = new Replica(),
    change = { protocol: 1, type: 'change', epoch, revision: 4, upserts: [], removed: [] };
  expect(() => replica.apply(change)).toThrow();
  replica.apply(snapshot);
  expect(replica.apply(change).snapshot).toBe(false);
  expect(() => replica.apply({ ...change, revision: 6 })).toThrow();
  expect(() =>
    replica.apply({ ...change, epoch: '4b4ac241-ea0e-4129-9318-3c5aa1fe7c1c', revision: 5 }),
  ).toThrow();
});
it('reconnect requires another full snapshot and accepts a fresh server epoch', () => {
  const replica = new Replica();
  replica.apply(snapshot);
  replica.reset();
  expect(() =>
    replica.apply({ protocol: 1, type: 'change', epoch, revision: 4, upserts: [], removed: [] }),
  ).toThrow();
  expect(
    replica.apply({ ...snapshot, epoch: '4b4ac241-ea0e-4129-9318-3c5aa1fe7c1c', revision: 0 })
      .snapshot,
  ).toBe(true);
});
