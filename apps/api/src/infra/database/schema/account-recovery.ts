import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { adminUsers } from './admin';
import { users } from './users';

/**
 * Who or what stopped a recovery before its move.
 *
 * - `admin`: an admin holding `accounts.recover` cancelled it, with a reason.
 * - `link`: the cancel link mailed to the old address was followed.
 * - `code_attempts`: the new address's code was guessed wrong too often.
 * - `stale`: at approval the account no longer had the old address or was no
 *   longer active, or another account had taken the new address, so the
 *   move could never happen.
 */
export const accountRecoveryCancelSource = pgEnum('account_recovery_cancel_source', [
  'admin',
  'link',
  'code_attempts',
  'stale',
]);

/**
 * Support-mediated recovery of an account whose sign-in address is lost
 * ([ADR-0074](docs/decisions/ADR-0074-account-recovery-and-email-change.md)
 * §§ 2–5, issue #515).
 *
 * One row walks one way:
 *
 * 1. **Opened** by an admin with the evidence notes; a code goes to the new
 *    address (`code_hash`, `code_expires_at`).
 * 2. **Verified** when the admin enters the code the user read back. The hold
 *    starts here (`code_verified_at`, `hold_until` = + 72 h) and the old address
 *    is sent the notice with the cancel link (`cancel_token_hash`).
 * 3. **Moved** on a second admin's approval after `hold_until`, or
 *    **cancelled** at any point before.
 *
 * The cancel token is stored only as a SHA-256 digest: it is 256 random bits,
 * so a keyed hash adds nothing, and a database dump must not hold a usable
 * link.
 */
export const accountRecoveryRequests = pgTable(
  'account_recovery_requests',
  {
    id: uuid('id').primaryKey(),

    userId: uuid('user_id')
      .notNull()
      // RESTRICT, as everywhere: users are soft-deleted, so this never fires.
      .references(() => users.id, { onDelete: 'restrict' }),

    /** The address the account had at opening: the mover's `fromEmail`, and the notices' recipient. */
    oldEmail: text('old_email').notNull(),
    /** Normalised by `infra/email/email-address.ts` before it gets here. */
    newEmail: text('new_email').notNull(),

    openedByAdminId: uuid('opened_by_admin_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    /** What the admin matched, in their words (ADR-0074 § 2's evidence bar). */
    evidenceNotes: text('evidence_notes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** HMAC of the code sent to `new_email`, under `OTP_CODE_PEPPER`. */
    codeHash: text('code_hash').notNull(),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }).notNull(),
    codeVerifiedAt: timestamp('code_verified_at', { withTimezone: true }),

    /** `code_verified_at` + 72 h. Null until the code is verified. */
    holdUntil: timestamp('hold_until', { withTimezone: true }),
    /** SHA-256 of the cancel link's token. Null until the code is verified. */
    cancelTokenHash: text('cancel_token_hash'),

    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelSource: accountRecoveryCancelSource('cancel_source'),
    /** Set only when `cancel_source` is `admin`. */
    cancelledByAdminId: uuid('cancelled_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
    cancelReason: text('cancel_reason'),

    approvedByAdminId: uuid('approved_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
    approveReason: text('approve_reason'),
    movedAt: timestamp('moved_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * At most one open request per account (#515). Two admins opening at once
     * both pass the service's check; this index is what leaves one row.
     */
    uniqueIndex('account_recovery_requests_open_per_user_unique')
      .on(table.userId)
      .where(sql`${table.cancelledAt} is null and ${table.movedAt} is null`),
    /** A user's recoveries, past and open, and the FK's index. */
    index('account_recovery_requests_user_idx').on(table.userId),
    /** The public cancel endpoint's lookup. */
    uniqueIndex('account_recovery_requests_cancel_token_unique').on(table.cancelTokenHash),
    /** "Every request this admin opened": the panel's filter, and the FK's index. */
    index('account_recovery_requests_opened_by_idx').on(table.openedByAdminId),
    index('account_recovery_requests_approved_by_idx').on(table.approvedByAdminId),
    index('account_recovery_requests_cancelled_by_idx').on(table.cancelledByAdminId),
    // The hold and the token arrive together, at verification.
    check(
      'account_recovery_requests_hold_with_verification',
      sql`(${table.codeVerifiedAt} is null) = (${table.holdUntil} is null)
          and (${table.codeVerifiedAt} is null) = (${table.cancelTokenHash} is null)`,
    ),
    // ADR-0074 § 2: no single admin both accepts the evidence and moves the account.
    check(
      'account_recovery_requests_two_admins',
      sql`${table.approvedByAdminId} is null or ${table.approvedByAdminId} <> ${table.openedByAdminId}`,
    ),
    // A move needs a verified code and an approver; a request ends one way only.
    check(
      'account_recovery_requests_move_shape',
      sql`${table.movedAt} is null
          or (${table.approvedByAdminId} is not null and ${table.codeVerifiedAt} is not null
              and ${table.cancelledAt} is null)`,
    ),
    check(
      'account_recovery_requests_cancel_shape',
      sql`(${table.cancelledAt} is null) = (${table.cancelSource} is null)
          and (${table.cancelledByAdminId} is null or ${table.cancelSource} = 'admin')`,
    ),
    check(
      'account_recovery_requests_text_bounds',
      sql`char_length(${table.evidenceNotes}) between 1 and 4000
          and (${table.cancelReason} is null or char_length(${table.cancelReason}) <= 600)
          and (${table.approveReason} is null or char_length(${table.approveReason}) <= 600)`,
    ),
  ],
);

export type AccountRecoveryRow = typeof accountRecoveryRequests.$inferSelect;
export type AccountRecoveryCancelSourceName =
  (typeof accountRecoveryCancelSource.enumValues)[number];

/**
 * Which of the two photos ADR-0074 § 2 asks a master for (#524): a fresh
 * selfie holding the same ID card, and the card's front.
 */
export const accountRecoveryPhotoKind = pgEnum('account_recovery_photo_kind', [
  'selfie_with_id',
  'id_card_front',
]);

/**
 * `awaiting_upload` from presign until confirm; `stored` once the bytes were
 * checked. Nothing else: a stored photo is never replaced or withdrawn, it is
 * the record of what the request was opened on.
 */
export const accountRecoveryPhotoStatus = pgEnum('account_recovery_photo_status', [
  'awaiting_upload',
  'stored',
]);

/**
 * The evidence photos of a master's recovery request (#524, ADR-0074 § 2).
 *
 * Identity documents, so they live where ADR-0023's do: the private bucket,
 * written by the admin's browser through a presigned PUT (ADR-0024), checked
 * at confirm against the real size and bytes, and read only through a
 * short-lived link whose every issue is audited. The key is server-made and
 * never leaves the API.
 *
 * Kept as long as the request row, which is kept as the record of a move or
 * a refusal (`docs/product/admin-flow.md` § "No destructive deletes"), the
 * same as a reviewed ADR-0023 document. An `awaiting_upload` row that was
 * never confirmed is cleared by the maintenance sweep.
 */
export const accountRecoveryPhotos = pgTable(
  'account_recovery_photos',
  {
    id: uuid('id').primaryKey(),
    recoveryId: uuid('recovery_id')
      .notNull()
      // RESTRICT: requests are never deleted, so this never fires.
      .references(() => accountRecoveryRequests.id, { onDelete: 'restrict' }),
    kind: accountRecoveryPhotoKind('kind').notNull(),
    status: accountRecoveryPhotoStatus('status').notNull().default('awaiting_upload'),
    storageKey: text('storage_key').notNull(),
    declaredContentType: text('declared_content_type').notNull(),
    verifiedContentType: text('verified_content_type'),
    sizeBytes: integer('size_bytes'),
    uploadedByAdminId: uuid('uploaded_by_admin_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'restrict' }),
    presignExpiresAt: timestamp('presign_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    storedAt: timestamp('stored_at', { withTimezone: true }),
  },
  (table) => [
    /** One photo of each kind per request; a pending presign holds the slot. */
    uniqueIndex('account_recovery_photos_kind_unique').on(table.recoveryId, table.kind),
    uniqueIndex('account_recovery_photos_storage_key_unique').on(table.storageKey),
    index('account_recovery_photos_uploaded_by_idx').on(table.uploadedByAdminId),
    /** The sweep's lookup of presigns nobody confirmed. */
    index('account_recovery_photos_awaiting_idx')
      .on(table.presignExpiresAt)
      .where(sql`${table.status} = 'awaiting_upload'`),
    check(
      'account_recovery_photos_stored_shape',
      sql`(${table.status} = 'stored') = (${table.storedAt} is not null)
          and (${table.status} = 'stored') = (${table.sizeBytes} is not null)
          and (${table.status} = 'stored') = (${table.verifiedContentType} is not null)`,
    ),
    check(
      'account_recovery_photos_size_positive',
      sql`${table.sizeBytes} is null or ${table.sizeBytes} > 0`,
    ),
  ],
);

export type AccountRecoveryPhotoRow = typeof accountRecoveryPhotos.$inferSelect;
export type AccountRecoveryPhotoKindName = (typeof accountRecoveryPhotoKind.enumValues)[number];
