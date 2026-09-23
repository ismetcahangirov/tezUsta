import { Inject, Injectable } from '@nestjs/common';
import type { MessageSenderKind } from '@tezusta/types';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type { MessageAttachmentRow } from '../../infra/database/schema/message-attachments';
import { messageAttachments } from '../../infra/database/schema/message-attachments';

/**
 * Why a set of attachment ids could not go out on a message, told apart so
 * the service can answer each case with the right status rather than one
 * shared failure. A discriminated union for the reason `AttachOutcome` in
 * `order-photos.repository.ts` is one.
 */
export type AttachmentRefusal = 'not_found' | 'not_confirmed' | 'already_attached';

/**
 * Drizzle queries over `message_attachments` (issue #181) — the
 * `order-photos.repository.ts` of a conversation.
 *
 * **Every read and write that resolves a caller's own attachment is scoped by
 * `conversation_id` and `uploader_kind` as well as by the row's own id**, the
 * rule `OrderPhotosRepository` follows with `customer_id`: the ownership check
 * belongs in the `WHERE` clause, not only in the service above it. An id that
 * names a photo in some other conversation, or one the *other* party
 * uploaded, therefore matches nothing, and nothing distinguishes that from an
 * id that names nothing at all.
 */
@Injectable()
export class MessageAttachmentsRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * This side's abandoned presign in this conversation, if there is one —
   * `message_attachments_pending_upload_unique` allows exactly one, so a new
   * presign has to clear it first (`OrderPhotosRepository#findPendingUpload`).
   */
  async findPendingUpload(
    conversationId: string,
    uploaderKind: MessageSenderKind,
  ): Promise<MessageAttachmentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(messageAttachments)
      .where(
        and(
          eq(messageAttachments.conversationId, conversationId),
          eq(messageAttachments.uploaderKind, uploaderKind),
          eq(messageAttachments.status, 'awaiting_upload'),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Discards an abandoned presign — a hard delete, guarded on still being
   * `awaiting_upload`, for `OrderPhotosRepository#deletePendingUpload`'s
   * reason: the row records that a URL was minted, not that anything happened.
   */
  async deletePendingUpload(id: string): Promise<void> {
    await this.db
      .delete(messageAttachments)
      .where(and(eq(messageAttachments.id, id), eq(messageAttachments.status, 'awaiting_upload')));
  }

  async createPendingUpload(input: {
    readonly conversationId: string;
    readonly uploaderKind: MessageSenderKind;
    readonly storageKey: string;
    readonly declaredContentType: string;
    readonly presignExpiresAt: Date;
  }): Promise<MessageAttachmentRow> {
    const [row] = await this.db
      .insert(messageAttachments)
      .values({ id: uuidV7(), ...input })
      .returning();
    if (row === undefined) {
      throw new Error('Insert of message_attachments returned no row.');
    }
    return row;
  }

  /** Scoped by conversation and side as well as by id — see the class comment. */
  async findOwn(input: {
    readonly conversationId: string;
    readonly uploaderKind: MessageSenderKind;
    readonly attachmentId: string;
  }): Promise<MessageAttachmentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(messageAttachments)
      .where(
        and(
          eq(messageAttachments.id, input.attachmentId),
          eq(messageAttachments.conversationId, input.conversationId),
          eq(messageAttachments.uploaderKind, input.uploaderKind),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * `awaiting_upload` → `confirmed`, conditional on still being
   * `awaiting_upload` — `OrderPhotosRepository#confirmUpload`'s single-use
   * mechanism, unchanged. `undefined` means the caller lost the race or is
   * confirming twice.
   */
  async confirmUpload(input: {
    readonly conversationId: string;
    readonly uploaderKind: MessageSenderKind;
    readonly attachmentId: string;
    readonly sizeBytes: number;
    readonly verifiedContentType: string;
    readonly now: Date;
  }): Promise<MessageAttachmentRow | undefined> {
    const [row] = await this.db
      .update(messageAttachments)
      .set({
        status: 'confirmed',
        sizeBytes: input.sizeBytes,
        verifiedContentType: input.verifiedContentType,
        submittedAt: input.now,
      })
      .where(
        and(
          eq(messageAttachments.id, input.attachmentId),
          eq(messageAttachments.conversationId, input.conversationId),
          eq(messageAttachments.uploaderKind, input.uploaderKind),
          eq(messageAttachments.status, 'awaiting_upload'),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Binds confirmed photos to a message that was just inserted, inside the
   * caller's transaction — or reports why it could not, without writing.
   *
   * **One guarded `UPDATE` for the whole set, not a read-then-write.** The
   * predicate names the conversation, the side, and `status = 'confirmed'`, so
   * a foreign id, the other party's photo, an unconfirmed upload and one that
   * already went out on another message all simply fail to match — and two
   * concurrent sends naming the same photo cannot both claim it, because the
   * second one's `UPDATE` waits on the first's row lock and then finds it no
   * longer `confirmed`. The count is then the whole check: fewer rows than ids
   * means at least one id was not usable, and the caller rolls the message
   * back with it.
   *
   * **Only on that failure does it look further**, to say *which* refusal it
   * was. Reading first would be a second round trip on every send with a
   * photo, spent explaining a failure that almost never happens.
   *
   * Returned oldest-upload first, which is the order a client shows them in.
   */
  async attachToMessage(
    input: {
      readonly conversationId: string;
      readonly uploaderKind: MessageSenderKind;
      readonly messageId: string;
      readonly attachmentIds: readonly string[];
      readonly now: Date;
    },
    executor: DatabaseExecutor,
  ): Promise<
    | { readonly kind: 'attached'; readonly rows: MessageAttachmentRow[] }
    | { readonly kind: 'refused'; readonly refusal: AttachmentRefusal }
  > {
    const ownership = and(
      inArray(messageAttachments.id, [...input.attachmentIds]),
      eq(messageAttachments.conversationId, input.conversationId),
      eq(messageAttachments.uploaderKind, input.uploaderKind),
    );

    const rows = await executor
      .update(messageAttachments)
      .set({ status: 'attached', messageId: input.messageId, attachedAt: input.now })
      .where(and(ownership, eq(messageAttachments.status, 'confirmed')))
      .returning();

    if (rows.length === input.attachmentIds.length) {
      return { kind: 'attached', rows: rows.sort(byCreatedAtThenId) };
    }

    const found = await executor
      .select({ status: messageAttachments.status })
      .from(messageAttachments)
      .where(ownership);

    // Checked in the order that tells the caller the most useful thing: an id
    // that is not theirs at all first, because nothing else about the request
    // matters until that is fixed.
    if (found.length < input.attachmentIds.length) {
      return { kind: 'refused', refusal: 'not_found' };
    }
    if (found.some((row) => row.status === 'awaiting_upload')) {
      return { kind: 'refused', refusal: 'not_confirmed' };
    }
    return { kind: 'refused', refusal: 'already_attached' };
  }

  /**
   * Every photo on each of several messages, grouped by message id — one
   * `where message_id = any($1)` for a whole history page, served by the
   * partial `message_attachments_message_idx`. The per-message shape was
   * 1 + N round trips on the endpoint a chat screen reads most (CLAUDE.md §12).
   *
   * Filters on `status = 'attached'` explicitly, for
   * `OrderPhotosRepository#listAttachedForOrder`'s reason: a read whose
   * correctness depends on a CHECK it never names is one edit from wrong.
   *
   * Messages with no photos are absent from the map rather than present with
   * an empty array; the caller reads it with `?? []`.
   */
  async listForMessages(
    messageIds: readonly string[],
  ): Promise<Map<string, MessageAttachmentRow[]>> {
    const grouped = new Map<string, MessageAttachmentRow[]>();
    if (messageIds.length === 0) {
      return grouped;
    }

    const rows = await this.db
      .select()
      .from(messageAttachments)
      .where(
        and(
          inArray(messageAttachments.messageId, [...messageIds]),
          eq(messageAttachments.status, 'attached'),
        ),
      )
      .orderBy(asc(messageAttachments.createdAt), asc(messageAttachments.id));

    for (const row of rows) {
      if (row.messageId === null) {
        continue;
      }
      const existing = grouped.get(row.messageId);
      if (existing === undefined) {
        grouped.set(row.messageId, [row]);
      } else {
        existing.push(row);
      }
    }

    return grouped;
  }

  /**
   * Photos never sent on a message and created at or before `cutoff` — both
   * the presign whose upload never arrived and the confirmed upload whose
   * message was never written. The sweep's candidate list, bounded by
   * `limit`, served by the partial `message_attachments_unsent_created_idx`.
   *
   * **One clock for both states, and it is `created_at`.** `order_photos`
   * measures a confirmed photo from `submitted_at` because a customer may
   * photograph a leak days before placing the order it belongs to. A message
   * photo has no such gap: it is taken while the message is being written,
   * inside a conversation that is already open, so a photo presigned longer
   * ago than the window and still unsent is abandoned however recently its
   * bytes arrived. Unlike `order_photos`, `awaiting_upload` rows are swept
   * here too: the presign path only clears a side's stale presign when that
   * side presigns again, and on a finished order nobody ever will.
   */
  async listUnsent(cutoff: Date, limit: number): Promise<MessageAttachmentRow[]> {
    return this.db
      .select()
      .from(messageAttachments)
      .where(and(isNull(messageAttachments.messageId), lte(messageAttachments.createdAt, cutoff)))
      .orderBy(asc(messageAttachments.createdAt))
      .limit(limit);
  }

  /**
   * Deletes one unsent photo and its bytes, returning `false` when it was sent
   * in the meantime. The ordering, and the reason for the transaction — a row
   * lock taken before the object is touched, not an atomicity the storage call
   * cannot have — is `OrderPhotosRepository#deleteAbandoned`'s, unchanged: a
   * concurrent send blocks on the lock and then finds no row, rather than
   * attaching a photo whose bytes are already gone.
   */
  async deleteUnsent(
    attachmentId: string,
    deleteObject: (storageKey: string) => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(messageAttachments)
        .where(and(eq(messageAttachments.id, attachmentId), isNull(messageAttachments.messageId)))
        .returning({ storageKey: messageAttachments.storageKey });

      if (row === undefined) {
        return false;
      }

      await deleteObject(row.storageKey);
      return true;
    });
  }
}

function byCreatedAtThenId(a: MessageAttachmentRow, b: MessageAttachmentRow): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}
