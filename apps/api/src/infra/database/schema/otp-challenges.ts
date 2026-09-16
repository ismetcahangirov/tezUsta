import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Why a challenge stopped being redeemable without having been redeemed.
 *
 * Both values are audit, not control flow: a support conversation ("I got a
 * code and it stopped working") has to be answerable, and the two answers are
 * very different — `superseded` means the person asked for a second code,
 * `attempts_exhausted` means somebody spent the attempt cap on this one, which
 * is a security event when the account's owner did not do it.
 *
 * There is deliberately no `expired` member. Expiry needs no write: it is
 * `expires_at < now()`, true the moment it becomes true, on every row at once.
 * A member here would imply something sweeps the table to set it, which
 * nothing does, and a code that had passed its TTL but not yet been marked
 * would then read as live.
 */
export const otpInvalidationReason = pgEnum('otp_invalidation_reason', [
  'superseded',
  'attempts_exhausted',
]);

/**
 * One row per OTP code ever issued (ADR-0008 — sign-in is phone + SMS OTP, and
 * there is no other consumer sign-in path).
 *
 * **Why Postgres and not Redis, when the rate-limit counters for the same
 * endpoint live in Redis.** The two have opposite requirements. A counter may
 * be lost — an evicted key costs an attacker one extra window and nothing
 * else — so it belongs where every instance can see it cheaply. A redeemed
 * code may *not* be lost or double-counted: consumption has to be atomic
 * against a concurrent second attempt, and it has to be auditable afterwards.
 * Postgres gives both in one statement, and this repository already proves the
 * pattern on `refresh_tokens` — `UPDATE ... WHERE ... IS NULL RETURNING *`,
 * where exactly one caller gets a row back and every other gets zero.
 *
 * **There is no foreign key to `users`, and that is the point.** The number is
 * not proven to belong to anybody until a code is verified, so a row here
 * cannot reference an account: creating a `users` row at request time would
 * turn `POST /auth/otp/request` into an account-creation endpoint that anyone
 * can fire at any number in Azerbaijan, and would make "does this number have
 * an account?" answerable by watching the table. The account is created at
 * verification, from the phone number this row carries.
 *
 * Rows carry no `updated_at`, for the same reason `refresh_tokens` does not:
 * every mutable column here is written exactly once, by one conditional
 * `UPDATE`, and nothing else about a row ever changes. Pruning old rows is
 * maintenance work, not something a request path does.
 */
export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey(),

    /**
     * Normalised E.164 (`infra/phone/azerbaijani-phone.ts`) before it is
     * written or compared — never the string the caller typed. The lookup at
     * verification is an equality match on this column, so a row written as
     * `0501234567` and a verification arriving as `+994501234567` would be two
     * different numbers and the code would simply never verify.
     */
    phoneE164: text('phone_e164').notNull(),

    /**
     * HMAC-SHA256 of `<challenge id>|<code>`, keyed by `OTP_CODE_PEPPER` — a
     * pepper the database never holds. **Never the code.**
     *
     * A bare digest would not do here, and this is the one place in the
     * codebase where that is not a theoretical distinction. A six-digit code
     * is ~20 bits: a leaked dump of unkeyed SHA-256 digests is inverted by
     * enumerating all 10^6 candidates, which is milliseconds. Keying the
     * digest with a server-held secret means the dump alone yields nothing.
     *
     * Equally deliberately **not** a slow, salted KDF (bcrypt/argon2), which
     * is the reflex for "hash a short secret" and is wrong twice over here.
     * It cannot rescue a 20-bit keyspace against anyone who also holds the
     * application secret, and a per-row salt would make the digest
     * uncomputable outside the database — forcing read-then-compare-then-write
     * and reopening the race that the conditional `UPDATE` closes. Recorded in
     * `docs/engineering/dependency-policy.md`.
     *
     * The challenge id is part of the HMAC input, not just the row key: two
     * rows that happen to carry the same six digits hash differently, so a
     * dump cannot even be grouped by "these two people got the same code".
     */
    codeHash: text('code_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** `created_at + OTP_TTL_SECONDS`, capped at five minutes by ADR-0008. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /**
     * Null until redeemed. Set exactly once, by the conditional `UPDATE` in
     * `otp.repository.ts`, which is what makes "the same code can never be
     * redeemed twice, including concurrently" a property of the database
     * rather than of the order two requests happen to arrive in.
     */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),

    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    invalidatedReason: otpInvalidationReason('invalidated_reason'),
  },
  (table) => [
    /**
     * **At most one redeemable code per phone number, enforced by the
     * database.**
     *
     * ADR-0008 requires that a new code invalidate the previous one, to
     * prevent "a pool of valid codes". The request path does that explicitly —
     * supersede, then insert, in one transaction — but an application-only
     * rule holds exactly until two requests for one number overlap, which a
     * double-tapped button produces routinely. This index makes the overlap
     * lose instead of quietly leaving two live codes: the second insert raises
     * `23505` and the request path retries the whole transaction, which then
     * sees and supersedes the winner's row.
     *
     * The predicate cannot mention `expires_at`: an index predicate must be
     * IMMUTABLE and `now()` is not. An expired-but-unsuperseded row therefore
     * still occupies the slot, which is why the supersede statement matches on
     * liveness rather than on expiry — it clears the slot regardless.
     */
    uniqueIndex('otp_challenges_live_per_phone_unique')
      .on(table.phoneE164)
      .where(sql`${table.consumedAt} is null and ${table.invalidatedAt} is null`),

    /**
     * The maintenance sweep that deletes spent and expired rows. Same
     * reasoning as `refresh_tokens_expires_at_idx`: without it that job is a
     * full scan of a table that grows by one row per sign-in attempt, forever.
     */
    index('otp_challenges_expires_at_idx').on(table.expiresAt),
  ],
);

export type OtpChallengeRow = typeof otpChallenges.$inferSelect;
export type NewOtpChallengeRow = typeof otpChallenges.$inferInsert;
export type OtpInvalidationReasonName = (typeof otpInvalidationReason.enumValues)[number];
