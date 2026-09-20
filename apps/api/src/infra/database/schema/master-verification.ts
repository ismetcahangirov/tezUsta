import { relations, sql } from 'drizzle-orm';
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
import { masters, masterVerificationStatus } from './masters';
import { users } from './users';

/**
 * The evidence a master submits, fixed by
 * [ADR-0023](docs/decisions/ADR-0023-master-verification-policy.md).
 *
 * The selfie is not ceremony: an ID card photograph proves that somebody holds
 * an image of a document, which is exactly what a stolen document also proves.
 * The selfie is what binds the card to the person who will stand in a
 * customer's hallway.
 *
 * Extensible by design — adding `trade_certificate` is a migration that
 * appends an enum value, and no row already written becomes wrong.
 */
export const masterDocumentType = pgEnum('master_document_type', [
  'id_card_front',
  'id_card_back',
  'selfie_with_id',
]);

/**
 * Where one uploaded file stands.
 *
 * `awaiting_upload` is the row that exists **before** any bytes do, and it is
 * load-bearing rather than bookkeeping. S3 presigned URLs have no native
 * single-use mechanism — AWS's own documentation is explicit that a presigned
 * URL "can be used multiple times, up to the expiration date and time" — so
 * the server's own record is what makes an upload single-use: the key was
 * issued to exactly one master for exactly one document, and confirming it is
 * a conditional transition out of this status that only one request can win
 * ([ADR-0024](docs/decisions/ADR-0024-presigned-upload-mechanism.md)).
 *
 * `accepted` and `rejected` are written by admin review (issue #39). They are
 * in the enum now so that landing review is a migration that adds columns
 * rather than one that rewrites a type every row already uses.
 */
export const masterDocumentStatus = pgEnum('master_document_status', [
  'awaiting_upload',
  'pending_review',
  'accepted',
  'rejected',
]);

/**
 * One verification document: where its bytes live, and what is known about
 * them.
 *
 * **The bytes are never here.** The row holds a server-generated key; storage
 * holds the file (ADR-0005). Identity documents in a database column would
 * inflate every backup, evict useful pages from shared buffers, and put the
 * most sensitive data TezUsta holds into every replica of it.
 */
export const masterDocuments = pgTable(
  'master_documents',
  {
    id: uuid('id').primaryKey(),

    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),

    documentType: masterDocumentType('document_type').notNull(),

    /**
     * **Server-generated, never a client filename.** A client-supplied name is
     * a path-traversal vector and a collision waiting to happen; the key is
     * built from the master id and a fresh UUID
     * (`modules/masters/master-verification.service.ts` → `buildDocumentKey`).
     */
    storageKey: text('storage_key').notNull(),

    /** The type the client declared at presign, and the URL was signed for. */
    declaredContentType: text('declared_content_type').notNull(),

    /**
     * What the leading bytes actually turned out to be.
     *
     * Null until confirm, and never equal to a value the client chose: a
     * declared `Content-Type` is an assertion, and this column is the finding.
     * Storing both is what lets a later question — "did anyone ever upload
     * something that lied about itself?" — be answered from the table.
     */
    verifiedContentType: text('verified_content_type'),

    /** The real object size, read from storage at confirm. Null before that. */
    sizeBytes: integer('size_bytes'),

    status: masterDocumentStatus('status').notNull().default('awaiting_upload'),

    /** When the presigned upload URL stops working. ADR-0005 caps this at 5 minutes. */
    presignExpiresAt: timestamp('presign_expires_at', { withTimezone: true }).notNull(),

    /** When the upload was confirmed — the moment the row became real evidence. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),

    /**
     * Replaced by a newer document of the same type, or withdrawn by the
     * master. Superseding rather than deleting: the evidence behind a past
     * verification decision has to survive the decision, or the audit trail
     * points at nothing.
     */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),

    /**
     * Which admin decided, and when (issue #39).
     *
     * A foreign key to `admin_users` rather than a `uuid` with no target,
     * because "who approved this identity document" is the question a dispute
     * or an audit actually asks, and an id that names nothing is not an
     * answer. `onDelete: 'restrict'` for the same reason: an admin account
     * cannot be hard-deleted out from under the decisions it made.
     */
    reviewedByAdminId: uuid('reviewed_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /**
     * A key names exactly one row, forever. Two rows sharing one would mean
     * two masters' documents could resolve to the same object, which is the
     * cross-tenant read this whole table exists to make impossible.
     */
    uniqueIndex('master_documents_storage_key_unique').on(table.storageKey),

    /**
     * **At most one outstanding presign per document type.** Without it, a
     * client that taps "upload" repeatedly mints unbounded keys, each one a
     * live upload URL against the bucket. Re-presigning discards the previous
     * unused row and its object first — the one hard delete in the module, and
     * it destroys nothing, because a row in this status records that a URL was
     * minted rather than that anything happened.
     */
    uniqueIndex('master_documents_pending_upload_unique')
      .on(table.masterId, table.documentType)
      .where(sql`${table.status} = 'awaiting_upload'`),

    /**
     * **At most one live document per type.** A master replacing their ID card
     * front supersedes the old one at confirm — not at presign, because a
     * presign that is never used must not be able to destroy evidence an admin
     * already accepted.
     */
    uniqueIndex('master_documents_live_unique')
      .on(table.masterId, table.documentType)
      .where(sql`${table.supersededAt} is null and ${table.status} <> 'awaiting_upload'`),

    /** The master's own list, and the admin detail read in issue #39. */
    index('master_documents_master_idx').on(table.masterId, table.documentType),

    /**
     * The abandoned-upload sweep (#128), both halves of its predicate.
     *
     * The first is the candidate scan: rows still `awaiting_upload` whose
     * last activity is older than the window, oldest first. Partial, because
     * `awaiting_upload` is a transient status and the index should not carry
     * every document that ever reached review.
     *
     * The second is the guard that keeps a master who is part-way through
     * gathering three documents: "has this master touched ANY document
     * recently". That lookup is by `master_id` and ordered by time, which the
     * existing `(master_id, document_type)` index cannot serve, and a sweep
     * that sequentially scanned this table to answer it would be exactly the
     * unindexed hot-path query CLAUDE.md §12 forbids.
     */
    index('master_documents_abandoned_idx')
      .on(table.updatedAt)
      .where(sql`${table.status} = 'awaiting_upload'`),
    index('master_documents_master_activity_idx').on(table.masterId, table.updatedAt),

    /**
     * The two halves of a document's life, each fully described.
     *
     * Before confirm there is no size, no sniffed type and no submission time;
     * after it, all three exist. Splitting the rule across three separate
     * nullable columns would allow eight combinations, six of which are
     * nonsense that some later reader would have to guess at.
     */
    check(
      'master_documents_lifecycle_shape',
      sql`(${table.status} = 'awaiting_upload'
             and ${table.submittedAt} is null
             and ${table.sizeBytes} is null
             and ${table.verifiedContentType} is null)
          or (${table.status} <> 'awaiting_upload'
             and ${table.submittedAt} is not null
             and ${table.sizeBytes} is not null
             and ${table.verifiedContentType} is not null)`,
    ),

    /**
     * A reviewed document names its reviewer, and an unreviewed one names
     * nobody (issue #39). Without this, `accepted` with no reviewer is
     * writable — an approval nobody is accountable for, which is the one row
     * an audit most needs to be impossible.
     */
    check(
      'master_documents_review_shape',
      sql`(${table.status} in ('accepted', 'rejected'))
          = (${table.reviewedByAdminId} is not null and ${table.reviewedAt} is not null)`,
    ),

    /** A zero-byte image is not an image, whatever its first twelve bytes say. */
    check(
      'master_documents_size_positive',
      sql`${table.sizeBytes} is null or ${table.sizeBytes} > 0`,
    ),
  ],
);

/**
 * Who caused a verification status change.
 *
 * Three kinds, each with its own nullable foreign key, because an admin is not
 * a `users` row ([ADR-0014](docs/decisions/ADR-0014-admin-authentication.md))
 * and the two account stores share nothing — not a table, not a type, and not
 * a column here.
 *
 * `system` is for a transition nobody chose — an automatic suspension on a
 * rating floor, for instance. Nothing writes it yet, and the alternative was
 * attributing a machine decision to whichever person it happened to affect.
 */
export const masterVerificationActorKind = pgEnum('master_verification_actor_kind', [
  'master',
  'admin',
  'system',
]);

/**
 * Every verification status change, ever. **Append-only.**
 *
 * Not a convention: `0008_master_verification.sql` installs a trigger that
 * raises on UPDATE and DELETE, because an audit trail that the application
 * merely promises not to rewrite is an audit trail whose integrity depends on
 * every future query being careful. A trust decision with no reliable record
 * of who made it is indistinguishable from an attacker's
 * (`docs/product/admin-flow.md`).
 */
export const masterVerificationHistory = pgTable(
  'master_verification_history',
  {
    id: uuid('id').primaryKey(),

    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),

    fromStatus: masterVerificationStatus('from_status').notNull(),
    toStatus: masterVerificationStatus('to_status').notNull(),

    actorKind: masterVerificationActorKind('actor_kind').notNull(),

    /**
     * The consumer account that acted, when a master acted. Null for `admin`
     * and `system` — an admin is not a `users` row (ADR-0014), which is why
     * this column cannot simply be "the actor".
     */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),

    /**
     * The admin account that acted (issue #39). Null for `master` and
     * `system`.
     *
     * Two nullable columns rather than one polymorphic `actor_id`, because a
     * single column could only be a `uuid` with no foreign key — and then
     * "which admin suspended this master" would be a join nothing enforces,
     * against a table the id might not even be in. The CHECK below is what
     * makes exactly one of them present for each kind.
     */
    actorAdminId: uuid('actor_admin_id').references(() => adminUsers.id, {
      onDelete: 'restrict',
    }),

    /**
     * Shown to the master, so it is written for them to read.
     *
     * Required on every negative outcome by ADR-0023 and enforced there rather
     * than here: which transitions demand a reason is policy about pairs of
     * statuses, and encoding that pairing as a CHECK would freeze the policy
     * into the shape of the table.
     */
    reason: text('reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One master's trail, newest first — the admin detail view and the master's own. */
    index('master_verification_history_master_idx').on(table.masterId, table.createdAt.desc()),

    /**
     * A transition from a status to itself is not a transition. It would
     * either be a no-op somebody logged, or a bug that read the current status
     * wrongly, and neither belongs in the record of what happened.
     */
    check(
      'master_verification_history_real_transition',
      sql`${table.fromStatus} <> ${table.toStatus}`,
    ),

    /**
     * A master-initiated change names the master; the other two kinds cannot,
     * because there is no `users` row behind them.
     */
    check(
      'master_verification_history_actor_shape',
      sql`(${table.actorKind} = 'master') = (${table.actorUserId} is not null)
          and (${table.actorKind} = 'admin') = (${table.actorAdminId} is not null)`,
    ),

    check(
      'master_verification_history_reason_length',
      sql`${table.reason} is null or length(btrim(${table.reason})) between 1 and 600`,
    ),
  ],
);

export const masterDocumentsRelations = relations(masterDocuments, ({ one }) => ({
  master: one(masters, { fields: [masterDocuments.masterId], references: [masters.id] }),
}));

export const masterVerificationHistoryRelations = relations(
  masterVerificationHistory,
  ({ one }) => ({
    master: one(masters, {
      fields: [masterVerificationHistory.masterId],
      references: [masters.id],
    }),
    actorUser: one(users, {
      fields: [masterVerificationHistory.actorUserId],
      references: [users.id],
    }),
    actorAdmin: one(adminUsers, {
      fields: [masterVerificationHistory.actorAdminId],
      references: [adminUsers.id],
    }),
  }),
);

export type MasterDocumentRow = typeof masterDocuments.$inferSelect;
export type NewMasterDocumentRow = typeof masterDocuments.$inferInsert;
export type MasterDocumentTypeName = (typeof masterDocumentType.enumValues)[number];
export type MasterDocumentStatusName = (typeof masterDocumentStatus.enumValues)[number];
export type MasterVerificationHistoryRow = typeof masterVerificationHistory.$inferSelect;
export type NewMasterVerificationHistoryRow = typeof masterVerificationHistory.$inferInsert;
export type MasterVerificationActorKindName =
  (typeof masterVerificationActorKind.enumValues)[number];
