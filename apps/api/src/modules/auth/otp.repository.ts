import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type {
  OtpChallengeRow,
  OtpInvalidationReasonName,
} from '../../infra/database/schema/otp-challenges';
import { otpChallenges } from '../../infra/database/schema/otp-challenges';

/** What {@link OtpRepository.replaceLiveChallenge} needs in order to write the row. */
export interface NewOtpChallengeInput {
  readonly id: string;
  readonly phoneE164: string;
  readonly codeHash: string;
  readonly expiresAt: Date;
}

/**
 * PostgreSQL's `unique_violation`. The only constraint this repository can
 * violate is `otp_challenges_live_per_phone_unique`, which is reachable
 * exactly when two requests for one phone number overlap — see
 * {@link OtpRepository.replaceLiveChallenge}.
 */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  // `pg` exposes SQLSTATE on its own `DatabaseError` class, which Drizzle
  // rethrows unchanged. Matching on the string rather than `instanceof
  // DatabaseError` keeps the driver's class out of this module's imports —
  // the SQLSTATE is a PostgreSQL guarantee, the class is a `pg` detail.
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Drizzle queries over `otp_challenges`, and nothing else — no policy about
 * how long a code lives, how many guesses it survives, or what a failed
 * verification tells the caller (`docs/architecture/backend-architecture.md`
 * § Module rules).
 *
 * Every statement here filters on **liveness** — `consumed_at IS NULL AND
 * invalidated_at IS NULL` — rather than leaving it to the call site, for the
 * same reason `UsersRepository` filters `deleted_at IS NULL` in every read: a
 * spent code must behave as absent to every caller, and one call site that
 * forgets is a code that can be redeemed twice.
 */
@Injectable()
export class OtpRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Invalidates whatever code is currently live for this number and writes the
   * new one, **in one transaction**.
   *
   * ADR-0008: "a new code invalidates the previous one — prevents a pool of
   * valid codes". Committing the two statements together is what makes that
   * true at every instant: with two transactions there is a window in which
   * either both codes work (insert first) or neither does (supersede first,
   * then crash), and the second is a user who asked for a code and can now
   * never sign in with the one they receive.
   *
   * The retry is not defensive padding. Two requests for one number that
   * overlap — a double-tapped button, or an attacker deliberately racing —
   * both find no live row to supersede and both insert; the partial unique
   * index lets exactly one commit and raises `23505` on the other. Retrying
   * once is sufficient rather than a loop, and provably so: the second attempt
   * runs after the winner has committed, so its supersede statement now finds
   * that row, locks it, and clears the slot. A `23505` on the retry would mean
   * a *third* concurrent request, which the per-phone rate limit
   * (`OTP_RATE_LIMIT_PER_PHONE_HOUR`) has already made a losing strategy, and
   * it is allowed to propagate rather than be swallowed in a loop that could
   * spin under load.
   */
  async replaceLiveChallenge(
    input: NewOtpChallengeInput,
    now: Date = new Date(),
  ): Promise<OtpChallengeRow> {
    try {
      return await this.writeChallenge(input, now);
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      return await this.writeChallenge(input, now);
    }
  }

  private async writeChallenge(input: NewOtpChallengeInput, now: Date): Promise<OtpChallengeRow> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(otpChallenges)
        .set({ invalidatedAt: now, invalidatedReason: 'superseded' })
        .where(
          and(
            eq(otpChallenges.phoneE164, input.phoneE164),
            isNull(otpChallenges.consumedAt),
            isNull(otpChallenges.invalidatedAt),
          ),
        );

      // Deliberately matches on liveness and NOT on `expires_at > now()`: an
      // expired row still occupies the unique index's slot (the predicate
      // cannot reference `now()`, which is not IMMUTABLE), so a supersede that
      // skipped expired rows would leave the insert below failing forever for
      // that number.
      const [created] = await tx
        .insert(otpChallenges)
        .values({
          id: input.id,
          phoneE164: input.phoneE164,
          codeHash: input.codeHash,
          expiresAt: input.expiresAt,
        })
        .returning();

      if (created === undefined) {
        // Unreachable: an INSERT ... RETURNING that inserts one row returns
        // one row, and a constraint violation throws instead. Present so the
        // narrowing is explicit rather than an assertion.
        throw new Error('Insert into otp_challenges returned no row.');
      }

      return created;
    });
  }

  /**
   * The one code a caller may currently attempt for this number, if any.
   *
   * `limit(1)` is belt and braces, not deduplication: the partial unique index
   * already guarantees at most one row satisfies the liveness predicate.
   */
  async findLiveByPhone(
    phoneE164: string,
    now: Date = new Date(),
  ): Promise<OtpChallengeRow | undefined> {
    const [row] = await this.db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.phoneE164, phoneE164),
          isNull(otpChallenges.consumedAt),
          isNull(otpChallenges.invalidatedAt),
          gt(otpChallenges.expiresAt, now),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Redeems the code, atomically. Returns the row on success and `undefined`
   * when there was nothing to redeem.
   *
   * **This single statement is the whole of ADR-0008's "successful
   * verification consumes the code atomically".** Presented-hash equality,
   * liveness and expiry are all in the same `WHERE` as the write, so two
   * concurrent verifications of one code cannot both succeed: PostgreSQL
   * serialises the row update, the loser re-evaluates the predicate against
   * the already-consumed row, matches nothing, and gets zero rows back. A
   * read-then-compare-then-write would pass both through the comparison before
   * either wrote, which is the race this shape exists to remove — the same
   * pattern `refresh_tokens` uses, and the reason the code digest is keyed
   * rather than salted per row (a salted KDF cannot be compared inside a
   * `WHERE` clause).
   *
   * `undefined` deliberately does not say *which* condition failed. Wrong
   * code, expired code, already redeemed and invalidated are one answer to the
   * caller, because the endpoint must not tell an attacker that the code they
   * guessed was right but late.
   */
  async consume(
    id: string,
    codeHash: string,
    now: Date = new Date(),
  ): Promise<OtpChallengeRow | undefined> {
    const [row] = await this.db
      .update(otpChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(otpChallenges.id, id),
          eq(otpChallenges.codeHash, codeHash),
          isNull(otpChallenges.consumedAt),
          isNull(otpChallenges.invalidatedAt),
          gt(otpChallenges.expiresAt, now),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Retires a code that will never be redeemed — the attempt cap being spent
   * is the case that matters (ADR-0008: "max 5 attempts per code, **then
   * invalidate**").
   *
   * Conditional on liveness so it can never overwrite a `consumed_at` that a
   * concurrent verification has just set: the winner's session must not be
   * followed by a row claiming the code was invalidated instead of used, which
   * would make the audit trail lie about a successful sign-in.
   */
  async invalidate(
    id: string,
    reason: OtpInvalidationReasonName,
    now: Date = new Date(),
  ): Promise<void> {
    await this.db
      .update(otpChallenges)
      .set({ invalidatedAt: now, invalidatedReason: reason })
      .where(
        and(
          eq(otpChallenges.id, id),
          isNull(otpChallenges.consumedAt),
          isNull(otpChallenges.invalidatedAt),
        ),
      );
  }
}
