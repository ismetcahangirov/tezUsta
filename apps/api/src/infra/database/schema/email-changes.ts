import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { users } from './users';

/**
 * Why a pending change stopped being redeemable without completing.
 *
 * `superseded`: the user started another change, which replaces this one.
 * `attempts_exhausted`: the per-change attempt cap was spent (ADR-0072's
 * "max 5 attempts per code, then invalidate", applied to the pair).
 */
export const emailChangeInvalidationReason = pgEnum('email_change_invalidation_reason', [
  'superseded',
  'attempts_exhausted',
]);

/**
 * A signed-in user's change of sign-in address
 * ([ADR-0074](docs/decisions/ADR-0074-account-recovery-and-email-change.md) § 1,
 * issue #514).
 *
 * **Its own table, not two more `otp_challenges` rows.** A sign-in challenge
 * is keyed by an address and proves only that address; a change needs two
 * codes proven together, for one account, and neither may be usable as a
 * sign-in code nor be superseded by somebody asking to sign in. Sharing
 * `otp_challenges` would make every one of those properties depend on a
 * `purpose` column every query had to remember.
 *
 * **Both codes are stored as keyed digests**, like `otp_challenges.code_hash`,
 * and are checked inside the one `UPDATE` that completes the change, so two
 * concurrent confirms cannot both succeed (`EmailChangeRepository.complete`).
 *
 * A completed row is also the record of the change: who, from which address,
 * to which, and when. That is the audit trail ADR-0074 § 1 asks for.
 */
export const emailChanges = pgTable(
  'email_changes',
  {
    id: uuid('id').primaryKey(),

    userId: uuid('user_id')
      .notNull()
      // RESTRICT, as everywhere: users are soft-deleted, so this never fires.
      .references(() => users.id, { onDelete: 'restrict' }),

    /** The address the account had when the change started. */
    oldEmail: text('old_email').notNull(),
    /** Normalised by `infra/email/email-address.ts` before it gets here. */
    newEmail: text('new_email').notNull(),

    /** HMAC of the code sent to `old_email`. */
    currentCodeHash: text('current_code_hash').notNull(),
    /** HMAC of the code sent to `new_email`. */
    newCodeHash: text('new_code_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    completedAt: timestamp('completed_at', { withTimezone: true }),

    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    invalidatedReason: emailChangeInvalidationReason('invalidated_reason'),
  },
  (table) => [
    /**
     * At most one live change per account. A new start supersedes the old one
     * in the same transaction, and this index is what makes two overlapping
     * starts unable to leave two live rows behind.
     */
    uniqueIndex('email_changes_live_per_user_unique')
      .on(table.userId)
      .where(sql`${table.completedAt} is null and ${table.invalidatedAt} is null`),
  ],
);

export type EmailChangeRow = typeof emailChanges.$inferSelect;
export type EmailChangeInvalidationReasonName =
  (typeof emailChangeInvalidationReason.enumValues)[number];
