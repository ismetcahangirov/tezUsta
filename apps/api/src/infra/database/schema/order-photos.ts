import type { OrderPhotoStatus } from '@tezusta/types';
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

import { customers } from './customers';
import { orders } from './orders';

/**
 * Problem photos a customer attaches to an order (issue #83), built on the
 * exact mechanism issue #38 shipped for master verification documents:
 * presign a PUT, the client writes bytes straight to object storage, confirm
 * validates the real object ([ADR-0005](docs/decisions/ADR-0005-object-storage.md),
 * [ADR-0024](docs/decisions/ADR-0024-presigned-upload-mechanism.md)).
 *
 * **Three states, not two.** `master_documents` only needed "uploaded" and
 * "reviewed"; a photo has an extra step in between, because it is issued to a
 * *customer* before any order exists — a customer photographs the leak before
 * deciding whether to submit the request at all — and only becomes part of an
 * order's record once explicitly attached:
 *
 * - `awaiting_upload` — presigned, nothing behind the key yet. Exists for the
 *   same reason `master_documents.awaiting_upload` does: S3 presigned URLs
 *   have no native single-use mechanism, so this row *is* the single-use
 *   guarantee.
 * - `confirmed` — the bytes are real, sized, and sniffed. Not yet on any
 *   order. A customer may confirm several photos before creating the order
 *   they belong to, or after — issue #83 deliberately keeps upload and attach
 *   as two separate steps so a failed or abandoned upload can never block
 *   order creation (`docs/product/customer-flow.md`).
 * - `attached` — bound to exactly one order, permanently. There is no path
 *   back to `confirmed`: detaching a photo is not a requirement this issue
 *   carries, and inventing one would be a product decision nobody made.
 */
export const orderPhotoStatus = pgEnum('order_photo_status', [
  'awaiting_upload',
  'confirmed',
  'attached',
]);

/**
 * One problem photo: where its bytes live, what is known about them, and — if
 * it has gotten that far — which order it belongs to.
 *
 * **The bytes are never here.** Same reasoning as `master_documents`: a photo
 * of somebody's home in a database column inflates every backup and puts the
 * most sensitive data TezUsta holds into every replica of it.
 */
export const orderPhotos = pgTable(
  'order_photos',
  {
    id: uuid('id').primaryKey(),

    /**
     * The **issuing** customer — set at presign, never changed. This is the
     * whole ownership control: attach re-checks this column, so a key
     * presigned for one customer can never be attached by another, no matter
     * which order id is named in the request.
     */
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    /**
     * Null until attached, and never cleared afterwards. A photo binds to
     * **one** order for its whole life — re-attachment is refused by the
     * conditional UPDATE in `order-photos.repository.ts#attach`, guarded on
     * `status = 'confirmed'`, which an already-attached row can never satisfy
     * again.
     */
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),

    /**
     * **Server-generated, never a client filename.** A fresh UUID under one
     * flat prefix (`order-photos.service.ts` → `buildPhotoKey`) — the
     * path-traversal control ADR-0005 names.
     *
     * **Opaque on purpose: no customer id, no order id, nothing derivable.**
     * The key is copied verbatim into every presigned URL's path, and an
     * order photo's URLs go on the master-facing offer card, which a
     * broadcast hands to every eligible master in range. See `buildPhotoKey`
     * for the whole argument. Nothing reads identity back out of this
     * column — ownership is the row's own `customer_id` and `order_id`.
     */
    storageKey: text('storage_key').notNull(),

    /** The type the client declared at presign, and the URL was signed for. */
    declaredContentType: text('declared_content_type').notNull(),

    /**
     * What the leading bytes actually turned out to be. Null until confirm,
     * and never equal to a value the client chose — see
     * `master_documents.verified_content_type` for the identical reasoning.
     */
    verifiedContentType: text('verified_content_type'),

    /** The real object size, read from storage at confirm. Null before that. */
    sizeBytes: integer('size_bytes'),

    status: orderPhotoStatus('status').notNull().default('awaiting_upload'),

    /** When the presigned upload URL stops working. ADR-0005 caps this at 5 minutes. */
    presignExpiresAt: timestamp('presign_expires_at', { withTimezone: true }).notNull(),

    /** When the upload was confirmed. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),

    /** When the photo was attached to `order_id`. */
    attachedAt: timestamp('attached_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /** A key names exactly one row, forever — same reasoning as `master_documents`. */
    uniqueIndex('order_photos_storage_key_unique').on(table.storageKey),

    /** A customer's own unattached photos, and the confirm/attach ownership check. */
    index('order_photos_customer_idx').on(table.customerId),

    /**
     * **At most one outstanding presign per customer.** Without it, a client
     * that taps "add photo" repeatedly mints unbounded presigned PUT URLs,
     * each one a live, repeatedly-usable write capability into a billed
     * bucket for the full TTL — ADR-0024 §3 is explicit that a presigned PUT
     * binds no size, so the object behind an abandoned URL is unconstrained
     * until something confirms or discards it. `master_documents` bounds the
     * identical exposure with one outstanding presign per document *type*;
     * a photo has no type dimension, so the customer plays that role here.
     * `order-photos.service.ts#presignUpload` clears the previous abandoned
     * row and its object before minting a replacement — the one hard delete
     * in this module, mirroring `MasterVerificationService#presignUpload`.
     */
    uniqueIndex('order_photos_pending_upload_unique')
      .on(table.customerId)
      .where(sql`${table.status} = 'awaiting_upload'`),

    /**
     * The live read path: everything attached to one order. Partial, because
     * most rows in this table pass through `awaiting_upload`/`confirmed` with
     * no order yet, and indexing a null `order_id` for every one of them
     * would be pure waste.
     */
    index('order_photos_order_idx')
      .on(table.orderId)
      .where(sql`${table.orderId} is not null`),

    /**
     * The three states, each fully described. Mirrors
     * `master_documents_lifecycle_shape`, with one more clause per state:
     * `order_id`/`attached_at` are null through `awaiting_upload` and
     * `confirmed`, and both are set together, only in `attached` — a photo
     * cannot belong to an order without an attachment time, and cannot carry
     * an attachment time without belonging to one.
     */
    check(
      'order_photos_lifecycle_shape',
      sql`(${table.status} = 'awaiting_upload'
             and ${table.submittedAt} is null
             and ${table.sizeBytes} is null
             and ${table.verifiedContentType} is null
             and ${table.orderId} is null
             and ${table.attachedAt} is null)
          or (${table.status} = 'confirmed'
             and ${table.submittedAt} is not null
             and ${table.sizeBytes} is not null
             and ${table.verifiedContentType} is not null
             and ${table.orderId} is null
             and ${table.attachedAt} is null)
          or (${table.status} = 'attached'
             and ${table.submittedAt} is not null
             and ${table.sizeBytes} is not null
             and ${table.verifiedContentType} is not null
             and ${table.orderId} is not null
             and ${table.attachedAt} is not null)`,
    ),

    /** A zero-byte image is not an image, whatever its first twelve bytes say. */
    check('order_photos_size_positive', sql`${table.sizeBytes} is null or ${table.sizeBytes} > 0`),
  ],
);

/**
 * Unidirectional, like `masterDocumentsRelations` — `orders.ts` does not
 * declare the reverse `many(orderPhotos)`. A relational query starting from a
 * photo needs its order; nothing in this codebase yet needs to load every
 * photo through a relational order query rather than
 * `order-photos.repository.ts#listAttachedForOrder`.
 */
export const orderPhotosRelations = relations(orderPhotos, ({ one }) => ({
  customer: one(customers, { fields: [orderPhotos.customerId], references: [customers.id] }),
  order: one(orders, { fields: [orderPhotos.orderId], references: [orders.id] }),
}));

export type OrderPhotoRow = typeof orderPhotos.$inferSelect;
export type NewOrderPhotoRow = typeof orderPhotos.$inferInsert;
export type OrderPhotoStatusName = (typeof orderPhotoStatus.enumValues)[number];

/**
 * The column type and the wire contract describe the same set — same
 * technique as `OrderStatusEnumHasNoStrangers` in `orders.ts`, applied here so
 * a status added to one and forgotten in the other fails to compile rather
 * than failing at runtime against a value Postgres rejects.
 */
type AssertNever<T extends never> = T;

export type OrderPhotoStatusEnumHasNoStrangers = AssertNever<
  Exclude<(typeof orderPhotoStatus.enumValues)[number], OrderPhotoStatus>
>;
export type OrderPhotoStatusEnumIsComplete = AssertNever<
  Exclude<OrderPhotoStatus, (typeof orderPhotoStatus.enumValues)[number]>
>;
