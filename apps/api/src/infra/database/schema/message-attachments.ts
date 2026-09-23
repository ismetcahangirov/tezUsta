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

import { conversations, messages, messageSenderKind } from './conversations';

/**
 * Where one message photo stands (issue #181) — the three states
 * `order_photos` has, for the same reasons and with a message playing the part
 * an order plays there:
 *
 * - `awaiting_upload` — presigned, nothing behind the key yet. The row *is*
 *   the single-use guarantee S3 presigned URLs do not have (ADR-0024 § 4).
 * - `confirmed` — the bytes are real, sized and sniffed. Not on a message yet:
 *   a photo is uploaded while the message is still being composed.
 * - `attached` — part of exactly one message, and therefore of the
 *   transcript, permanently.
 *
 * A separate enum from `order_photo_status` even though the three labels are
 * the same, because the two tables' lifecycles are free to diverge — an order
 * photo may one day be detachable while a transcript never is — and one enum
 * shared by both would make that a migration of the other table.
 */
export const messageAttachmentStatus = pgEnum('message_attachment_status', [
  'awaiting_upload',
  'confirmed',
  'attached',
]);

/**
 * A photograph on a message, on the presigned-upload path order photos already
 * use ([ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md) § 4,
 * [ADR-0024](docs/decisions/ADR-0024-presigned-upload-mechanism.md)).
 *
 * **Scoped to a conversation from the moment it is presigned**, not to a
 * person the way `order_photos` is scoped to a customer. An order photo is
 * taken before any order exists; a message photo is taken inside a
 * conversation that already does, and binding it there at presign is what lets
 * every later check — confirm, send, read — be "does this row belong to the
 * conversation the caller is party to" without a second ownership model. It
 * also means a master removed by re-dispatch loses their unsent photos with
 * the conversation: the new conversation has a different id, and nothing in
 * the old one can be sent again.
 *
 * **Its own table rather than `order_photos` with a second parent.** A problem
 * photo is visible on the master-facing offer card to masters who never take
 * the job; a message photo is visible to the two parties and nobody else. One
 * table serving both audiences would make every read path answer "which kind
 * of photo is this" before "who may see it", and the first read that forgot
 * would publish a photo from a private conversation to a broadcast.
 *
 * The bytes are never here — same reasoning as `order_photos`.
 */
export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: uuid('id').primaryKey(),

    /**
     * The conversation this photo was issued into, at presign. Never changed.
     * `restrict` for the reason `messages.conversation_id` carries it: a
     * transcript is evidence, and so is every photo in it.
     */
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),

    /**
     * Which side of the conversation presigned it — and therefore the only
     * side that may confirm it or send it. A side rather than a user id for
     * the reason `messages.sender_kind` is one: the conversation already names
     * both parties, and one human may hold both roles.
     */
    uploaderKind: messageSenderKind('uploader_kind').notNull(),

    /**
     * Null until sent, and never changed afterwards — a trigger installed by
     * the migration refuses any update or delete of a row that has one,
     * because an attached photo is part of a write-once transcript.
     */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'restrict' }),

    /**
     * **Server-generated, opaque, never a client filename** — the
     * path-traversal control ADR-0005 names, and the `order_photos` rule that
     * a key copied into a signed URL carries no identifier.
     */
    storageKey: text('storage_key').notNull(),

    /** The type the client declared at presign, and the URL was signed for. */
    declaredContentType: text('declared_content_type').notNull(),

    /** What the leading bytes turned out to be. Null until confirm. */
    verifiedContentType: text('verified_content_type'),

    /** The real object size, read from storage at confirm. Null before that. */
    sizeBytes: integer('size_bytes'),

    status: messageAttachmentStatus('status').notNull().default('awaiting_upload'),

    /** When the presigned upload URL stops working. ADR-0005 caps this at 5 minutes. */
    presignExpiresAt: timestamp('presign_expires_at', { withTimezone: true }).notNull(),

    /** When the upload was confirmed. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),

    /** When the photo went out on `message_id`. */
    attachedAt: timestamp('attached_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** A key names exactly one row, forever — same reasoning as `order_photos`. */
    uniqueIndex('message_attachments_storage_key_unique').on(table.storageKey),

    /**
     * **At most one outstanding presign per side of a conversation** — the
     * bound `order_photos_pending_upload_unique` puts on a customer, for the
     * reason ADR-0024 § 3 gives: a presigned PUT binds no size, so every
     * outstanding one is a live write capability into a billed bucket for the
     * rest of its TTL. A new presign replaces the side's previous abandoned
     * one (`message-attachments.service.ts#presignUpload`), so a client sends
     * several photos by uploading them one after another, exactly as it
     * attaches several photos to an order.
     */
    uniqueIndex('message_attachments_pending_upload_unique')
      .on(table.conversationId, table.uploaderKind)
      .where(sql`${table.status} = 'awaiting_upload'`),

    /**
     * **The read path: every photo on a page of messages, in one statement.**
     * `where message_id = any($1)` over a history page is a bitmap of index
     * scans on this, not a scan of the table. Partial, because a row with no
     * message yet is never looked up by message.
     */
    index('message_attachments_message_idx')
      .on(table.messageId)
      .where(sql`${table.messageId} is not null`),

    /**
     * **The sweep's candidate list** — rows never sent, oldest first. Partial
     * on the unsent rows only, so the sweep's range scan never walks the
     * transcript's photos, which it may not touch anyway.
     */
    index('message_attachments_unsent_created_idx')
      .on(table.createdAt)
      .where(sql`${table.messageId} is null`),

    /**
     * The send and confirm lookups: this conversation's photos. Also the
     * foreign key Postgres does not index on its own.
     */
    index('message_attachments_conversation_idx').on(table.conversationId),

    /**
     * The three states, each fully described — `order_photos_lifecycle_shape`
     * with `message_id` in the place of `order_id`.
     */
    check(
      'message_attachments_lifecycle_shape',
      sql`(${table.status} = 'awaiting_upload'
             and ${table.submittedAt} is null
             and ${table.sizeBytes} is null
             and ${table.verifiedContentType} is null
             and ${table.messageId} is null
             and ${table.attachedAt} is null)
          or (${table.status} = 'confirmed'
             and ${table.submittedAt} is not null
             and ${table.sizeBytes} is not null
             and ${table.verifiedContentType} is not null
             and ${table.messageId} is null
             and ${table.attachedAt} is null)
          or (${table.status} = 'attached'
             and ${table.submittedAt} is not null
             and ${table.sizeBytes} is not null
             and ${table.verifiedContentType} is not null
             and ${table.messageId} is not null
             and ${table.attachedAt} is not null)`,
    ),

    /** A zero-byte image is not an image, whatever its first twelve bytes say. */
    check(
      'message_attachments_size_positive',
      sql`${table.sizeBytes} is null or ${table.sizeBytes} > 0`,
    ),
  ],
);

export const messageAttachmentsRelations = relations(messageAttachments, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messageAttachments.conversationId],
    references: [conversations.id],
  }),
  message: one(messages, { fields: [messageAttachments.messageId], references: [messages.id] }),
}));

export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;
export type NewMessageAttachmentRow = typeof messageAttachments.$inferInsert;
