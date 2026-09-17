import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER } from '../src/infra/database/migrate';

/**
 * Guards the `meta/` folder `drizzle-kit generate` derives the previous schema
 * from (issue #49). Pure filesystem assertions — no database — because what can
 * break here breaks the *generator*, and it breaks it **silently**:
 * `drizzle-kit`'s `prepareMigrationFolder` calls `process.exit(0)` on a
 * malformed or colliding meta folder, so `pnpm --filter api db:generate` would
 * print a line and exit successfully having written nothing.
 *
 * What the tool actually does was established by reading
 * `drizzle-kit@0.31.10`'s own bundle and by a real run, not from documentation
 * (CLAUDE.md §9) — see `src/infra/database/migrations/README.md`.
 */

const META_FOLDER = path.join(MIGRATIONS_FOLDER, 'meta');

/** `drizzle-kit`'s "this snapshot is the root of the chain" marker. */
const CHAIN_ROOT = '00000000-0000-0000-0000-000000000000';

interface Snapshot {
  id: string;
  prevId: string;
}

interface Journal {
  entries: { idx: number; tag: string }[];
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(path.join(META_FOLDER, '_journal.json'), 'utf8')) as Journal;
}

function snapshotFiles(): string[] {
  // The same filter `prepareOutFolder` applies: everything in `meta/` that
  // does not start with `_` is treated as a snapshot.
  return readdirSync(META_FOLDER)
    .filter((name) => !name.startsWith('_'))
    .sort();
}

function readSnapshot(name: string): Snapshot {
  return JSON.parse(readFileSync(path.join(META_FOLDER, name), 'utf8')) as Snapshot;
}

describe('the drizzle-kit migration snapshot chain (issue #49)', () => {
  it('has no two snapshots claiming the same parent', () => {
    // `validateWithReport` keys snapshots by `prevId`. Two sharing one is a
    // "collision" and aborts generation. This is the concrete reason the
    // hand-written `0000_enable_postgis` entry must NOT be given a snapshot of
    // its own: it would have to claim the chain root, which `0001` already
    // claims, and `db:generate` would stop working repository-wide.
    const byParent = new Map<string, string[]>();
    for (const name of snapshotFiles()) {
      const { prevId } = readSnapshot(name);
      byParent.set(prevId, [...(byParent.get(prevId) ?? []), name]);
    }

    const collisions = [...byParent.entries()].filter(([, names]) => names.length > 1);
    expect(collisions).toEqual([]);
  });

  it('links every snapshot into one unbroken chain from the root', () => {
    const names = snapshotFiles();
    const snapshots = names.map(readSnapshot);

    const roots = snapshots.filter((snapshot) => snapshot.prevId === CHAIN_ROOT);
    expect(roots).toHaveLength(1);

    // Walk it: each snapshot's `prevId` must be the previous one's `id`.
    for (let i = 1; i < snapshots.length; i += 1) {
      expect(snapshots[i]?.prevId).toBe(snapshots[i - 1]?.id);
    }
  });

  it('expects exactly one journal entry without a snapshot — the hand-written first migration', () => {
    // `0000_enable_postgis` was written by hand (issue #22): there were no
    // tables yet, so `generate` had nothing to diff and produced nothing. A
    // real run proved the generator does not mind, because it diffs against the
    // LAST snapshot and never looks for one per journal entry.
    //
    // This number stays at 1 forever. If it moves, either someone added a
    // snapshot for `0000` — which collides, see above — or someone hand-wrote a
    // second migration without recording why.
    expect(readJournal().entries.length - snapshotFiles().length).toBe(1);
    expect(readJournal().entries[0]?.tag).toBe('0000_enable_postgis');
  });

  it('has not edited the already-applied first migration', () => {
    // `drizzle-orm`'s runtime migrator hashes the file body and stores it in
    // `drizzle.__drizzle_migrations`. Editing a migration that has been applied
    // anywhere shared makes it look like a new one, so it would be applied
    // again on top of the schema it already created. Migrations are
    // forward-only; a change goes in the next file, never in this one.
    //
    // `.gitattributes` pins the working tree to LF, so this hash is the same on
    // every platform.
    const body = readFileSync(path.join(MIGRATIONS_FOLDER, '0000_enable_postgis.sql')).toString();

    expect(createHash('sha256').update(body).digest('hex')).toBe(
      'a6f930447ac37ac87795cfa0652ad6d44f6cf683422cb0226f00b181e33fb1bd',
    );
  });
});
