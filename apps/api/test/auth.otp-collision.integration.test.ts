import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/ids/uuid-v7';
import { parseEnv } from '../src/infra/config/parse-env';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import * as schema from '../src/infra/database/schema';
import { otpChallenges } from '../src/infra/database/schema/otp-challenges';
import { OtpRepository } from '../src/modules/auth/otp.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The collision behind issue #70, provoked on purpose instead of waited for.
 *
 * `auth.otp.e2e.test.ts` fires two overlapping `POST /auth/otp/request`s and
 * asserts the outcome, which is the property that matters — but whether the
 * two transactions actually meet on the unique index is up to the scheduler
 * and the connection pool. That is why the defect read as a flake: the loser
 * of a real collision was answered `500`, and most runs never produced one.
 *
 * `otp.repository.test.ts` could not have caught it either, and the reason is
 * the point of this file. It fakes the transaction and therefore chooses the
 * shape of the thrown error itself — it threw a bare `pg` error, the
 * application receives a `DrizzleQueryError` wrapping one, and a mock that
 * picks its own inputs cannot discover that the real one differs. Only a real
 * server raising a real `23505` through the real query layer can.
 *
 * The determinism comes from a second connection that holds the index slot
 * open: a transaction that has inserted the row but not committed makes the
 * repository's insert block on exactly the lock a concurrent request would,
 * and committing it releases that wait as a `unique_violation` at a moment
 * this test chooses.
 */

const PHONE = '+994509998877';

/** Long enough that a slow machine is not mistaken for a deadlock. */
const BLOCK_TIMEOUT_MS = 10_000;

describe('two OTP requests for one number, colliding on the unique index', () => {
  let pool: Pool;
  let db: Database;
  let database: ThrowawayDatabase;
  let repository: OtpRepository;
  let blocker: Client;
  let observer: Client;

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    pool = new Pool({ connectionString: database.url });
    db = drizzle(pool, { schema });
    repository = new OtpRepository(db);

    blocker = new Client({ connectionString: database.url });
    await blocker.connect();

    // A third connection, because the blocker is mid-transaction and the pool
    // is where the waiting statement lives: asking either of them whether the
    // repository is blocked would be asking the wrong process.
    observer = new Client({ connectionString: database.url });
    await observer.connect();
  });

  afterAll(async () => {
    await blocker.end();
    await observer.end();
    await pool.end();
    await database.drop();
  });

  /**
   * Resolves once some backend on this database is waiting on a lock — the
   * repository's insert, queued behind the uncommitted row.
   *
   * Polling `pg_stat_activity` rather than sleeping a fixed interval: a fixed
   * wait is a guess that is too long on a laptop and too short on a loaded CI
   * runner, and a test that commits before the other side has blocked proves
   * nothing while still passing.
   */
  async function waitUntilBlocked(): Promise<void> {
    const deadline = Date.now() + BLOCK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const { rows } = await observer.query<{ waiting: string }>(
        `SELECT count(*)::text AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (Number(rows[0]?.waiting ?? '0') > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error('The repository never blocked on the unique index; the test proves nothing.');
  }

  it('answers the loser with its own live challenge rather than an error', async () => {
    const holder = uuidV7();

    // The winner: inserted, not committed. Its row is invisible to everyone
    // else, so the repository's supersede statement finds nothing to clear —
    // which is precisely the state two genuinely simultaneous requests are in.
    await blocker.query('BEGIN');
    await blocker.query(
      `INSERT INTO otp_challenges (id, phone_e164, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '5 minutes')`,
      [holder, PHONE, 'a'.repeat(64)],
    );

    const loser = repository.replaceLiveChallenge({
      id: uuidV7(),
      phoneE164: PHONE,
      codeHash: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 300_000),
    });

    await waitUntilBlocked();
    await blocker.query('COMMIT');

    // Before the fix this rejected: the `23505` arrived wrapped in a
    // `DrizzleQueryError`, the SQLSTATE was on its `cause`, the retry's guard
    // did not match, and the error travelled to the client as a 500.
    const created = await loser;
    expect(created.phoneE164).toBe(PHONE);

    const rows = await db.select().from(otpChallenges).where(eq(otpChallenges.phoneE164, PHONE));
    const live = rows.filter((row) => row.consumedAt === null && row.invalidatedAt === null);

    // Both attempts are on record, and the winner's row was superseded by the
    // retry rather than left redeemable beside it (ADR-0008).
    expect(rows).toHaveLength(2);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(created.id);

    const superseded = rows.find((row) => row.id === holder);
    expect(superseded?.invalidatedReason).toBe('superseded');
  });
});
