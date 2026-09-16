import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../infra/database/database.types';
import type { OtpChallengeRow } from '../../infra/database/schema/otp-challenges';
import { OtpRepository } from './otp.repository';

/**
 * The retry in `replaceLiveChallenge`, isolated.
 *
 * `auth.otp.e2e.test.ts` fires two overlapping requests for one number against
 * a real Postgres and asserts the outcome — exactly one live challenge — which
 * is the property that matters. What it cannot guarantee is that the two
 * requests actually collided on the unique index: scheduling might serialise
 * them, in which case the test passes without the retry ever running, and the
 * branch would be untested while looking covered. That is precisely the shape
 * of bug this repository's own testing rules exist to prevent (CLAUDE.md §13),
 * so the retry is pinned down here, deterministically.
 *
 * The whole transaction is faked rather than the statements inside it: what is
 * under test is the decision to run it again, not what it does.
 */
const CHALLENGE: OtpChallengeRow = {
  id: '01a0a000-0000-7000-8000-000000000001',
  phoneE164: '+994501112233',
  codeHash: 'f'.repeat(64),
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 300_000),
  consumedAt: null,
  invalidatedAt: null,
  invalidatedReason: null,
};

const INPUT = {
  id: CHALLENGE.id,
  phoneE164: CHALLENGE.phoneE164,
  codeHash: CHALLENGE.codeHash,
  expiresAt: CHALLENGE.expiresAt,
};

/** PostgreSQL `unique_violation`, exactly as `pg` surfaces it. */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
}

/**
 * An `OtpRepository` whose only working member is `transaction`. Everything
 * else would throw, which is correct: a test that reached another method would
 * be testing something this file makes no claim about.
 */
function repositoryWith(transaction: unknown): OtpRepository {
  return new OtpRepository({ transaction } as unknown as Database);
}

describe('OtpRepository.replaceLiveChallenge', () => {
  it('retries once when two requests for one number collide on the unique index', async () => {
    // The collision is real, not hypothetical: two requests that both find no
    // live row to supersede both insert, and the partial unique index lets
    // exactly one commit. Without the retry, the loser's caller gets a 500 for
    // having double-tapped a button.
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce(CHALLENGE);

    const created = await repositoryWith(transaction).replaceLiveChallenge(INPUT);

    expect(created).toBe(CHALLENGE);
    // Twice, not more: the second attempt runs after the winner committed, so
    // its supersede statement now finds and clears the slot.
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('does not retry an error that is not a unique violation', async () => {
    // A connection failure or a serialisation error must surface, not be
    // silently attempted again — retrying a write whose outcome is unknown is
    // how one request becomes two rows.
    const failure = Object.assign(new Error('connection terminated'), { code: '08006' });
    const transaction = vi.fn().mockRejectedValue(failure);

    await expect(repositoryWith(transaction).replaceLiveChallenge(INPUT)).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry instead of spinning', async () => {
    // A second violation means a third concurrent request for the same number
    // — which the per-phone rate limit has already made a losing strategy. A
    // loop here would turn contention into a busy wait against the database.
    const transaction = vi.fn().mockRejectedValue(uniqueViolation());

    await expect(repositoryWith(transaction).replaceLiveChallenge(INPUT)).rejects.toMatchObject({
      code: '23505',
    });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
