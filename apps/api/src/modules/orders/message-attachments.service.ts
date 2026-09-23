import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfirmedMessageAttachment, MessageAttachmentUpload } from '@tezusta/types';

import { NotFoundError } from '../../common/errors/not-found.error';
import { uuidV7 } from '../../common/ids/uuid-v7';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { MessageAttachmentRow } from '../../infra/database/schema/message-attachments';
import {
  IMAGE_SIGNATURE_BYTES,
  sniffImageContentType,
} from '../../infra/storage/image-content-type';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import type { Actor } from '../auth/auth.types';
import {
  ConversationNotWritableError,
  ConversationsService,
  isWritable,
} from './conversations.service';
import { MessageAttachmentsRepository } from './message-attachments.repository';
import type { PresignMessageAttachmentRequest } from './message-attachments.schema';
import {
  PhotoAlreadyConfirmedError,
  PhotoContentMismatchError,
  PhotoTooLargeError,
  PhotoUploadNotFoundInStorageError,
} from './order-photos.service';

/**
 * Photo attachments in a conversation (issue #181): presign and confirm.
 * Sending a confirmed photo is part of sending a message
 * (`conversations.service.ts#send`), and reading one is part of reading the
 * history (`message-attachments.reader.ts`).
 *
 * **Nothing here is invented** ([ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md)
 * § 4). The storage provider, the allow-list, the size cap and its knob
 * (`ORDER_PHOTO_MAX_BYTES`), the twelve-byte sniff, the single-use row, the
 * error classes and the order of the checks are all
 * `OrderPhotosService`'s, and deliberately so: a second upload path would be a
 * second place for the cap to be wrong. `infra/storage` needed no change to
 * serve a second caller — every method on `StorageProvider` is already
 * expressed in keys and byte counts, which is exactly what made that true.
 *
 * **Two differences, both about who may act:**
 *
 * - **Authorization is the conversation's, asked of `ConversationsService`.**
 *   `requireParty` answers whether the caller is this order's customer or its
 *   currently assigned master — re-read from the database on every request,
 *   404 for anybody else — and this service calls it rather than restating
 *   the rule. A master removed by re-dispatch loses the right to upload and to
 *   confirm at the same instant they lose the job.
 * - **Only while the conversation is writable**, for presign *and* confirm. A
 *   photo is only ever uploaded to go on a message, and a finished order's
 *   conversation takes no more messages (ADR-0033 § 2); minting a write URL
 *   into a billed bucket for a photo that can never be sent would be handing
 *   out storage for nothing. Confirm is refused too, because it costs a billed
 *   `HeadObject` and a ranged `GET` for the same nothing. What such a
 *   half-finished upload leaves behind is the sweep's.
 */
@Injectable()
export class MessageAttachmentsService {
  private readonly logger = new Logger(MessageAttachmentsService.name);

  constructor(
    private readonly conversations: ConversationsService,
    private readonly attachments: MessageAttachmentsRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Mints a presigned upload into this order's conversation — clearing the
   * caller's previous, abandoned one first, for `OrderPhotosService#presignUpload`'s
   * reason: `message_attachments_pending_upload_unique` allows one outstanding
   * presign per side of a conversation, and each outstanding one is a live
   * write capability into a billed bucket (ADR-0024 § 3).
   */
  async presignUpload(
    actor: Actor,
    orderId: string,
    input: PresignMessageAttachmentRequest,
  ): Promise<MessageAttachmentUpload> {
    const { order, conversation, side } = await this.conversations.requireParty(actor, orderId);
    if (!isWritable(order)) {
      throw new ConversationNotWritableError(order.status);
    }

    const abandoned = await this.attachments.findPendingUpload(conversation.id, side);
    if (abandoned !== undefined) {
      await this.attachments.deletePendingUpload(abandoned.id);
      await this.storage.delete(abandoned.storageKey);
    }

    const { presignTtlSeconds, orderPhotoMaxBytes } = this.config.storage;
    const storageKey = buildAttachmentKey();

    const presigned = await this.storage.presignUpload({
      key: storageKey,
      contentType: input.contentType,
      ttlSeconds: presignTtlSeconds,
      maxBytes: orderPhotoMaxBytes,
    });

    const row = await this.attachments.createPendingUpload({
      conversationId: conversation.id,
      uploaderKind: side,
      storageKey,
      declaredContentType: input.contentType,
      presignExpiresAt: presigned.expiresAt,
    });

    return {
      attachmentId: row.id,
      uploadUrl: presigned.url,
      expiresAt: presigned.expiresAt.toISOString(),
      contentType: input.contentType,
      maxBytes: orderPhotoMaxBytes,
    };
  }

  /**
   * Turns an uploaded object into a confirmed photo — or refuses it and
   * removes the object. The same checks in the same order as
   * `OrderPhotosService#confirmUpload`: size first against the real object
   * (one `HeadObject`, rejecting the expensive case before anything is read),
   * then the twelve-byte sniff against the type the URL was signed for, then
   * the conditional transition that makes a second confirm impossible.
   *
   * **An id from another conversation, or one the other party uploaded, is a
   * 404** — the lookup is scoped by conversation and side, so it simply finds
   * nothing, and "not yours" is indistinguishable from "does not exist".
   */
  async confirmUpload(
    actor: Actor,
    orderId: string,
    attachmentId: string,
  ): Promise<ConfirmedMessageAttachment> {
    const { order, conversation, side } = await this.conversations.requireParty(actor, orderId);

    const attachment = await this.attachments.findOwn({
      conversationId: conversation.id,
      uploaderKind: side,
      attachmentId,
    });
    if (attachment === undefined) {
      throw new NotFoundError();
    }

    if (!isWritable(order)) {
      throw new ConversationNotWritableError(order.status);
    }

    if (attachment.status !== 'awaiting_upload') {
      throw new PhotoAlreadyConfirmedError();
    }

    const head = await this.storage.head(attachment.storageKey);
    if (head === undefined) {
      throw new PhotoUploadNotFoundInStorageError();
    }

    const maxBytes = this.config.storage.orderPhotoMaxBytes;
    if (head.sizeBytes > maxBytes) {
      await this.discard(attachment, 'oversize');
      throw new PhotoTooLargeError(head.sizeBytes, maxBytes);
    }

    const prefix = await this.storage.readPrefix(attachment.storageKey, IMAGE_SIGNATURE_BYTES);
    const sniffed = prefix === undefined ? null : sniffImageContentType(prefix);
    if (sniffed === null || sniffed !== attachment.declaredContentType) {
      await this.discard(attachment, 'content-mismatch');
      throw new PhotoContentMismatchError();
    }

    const confirmed = await this.attachments.confirmUpload({
      conversationId: conversation.id,
      uploaderKind: side,
      attachmentId: attachment.id,
      sizeBytes: head.sizeBytes,
      verifiedContentType: sniffed,
      now: new Date(),
    });

    if (confirmed === undefined) {
      throw new PhotoAlreadyConfirmedError();
    }

    return toConfirmedResponse(confirmed);
  }

  /**
   * Removes an object that failed validation and **keeps the row**, for
   * `OrderPhotosService#discard`'s reason: the presigned URL does not stop
   * working because a confirm rejected what arrived through it, so a retry
   * needs the row to land on. Nothing is referenced meanwhile — only a
   * `confirmed` row can go out on a message, and this one never became one.
   *
   * Logged against the attachment id only: no order, no conversation, no
   * party, and never the key, which is a capability.
   */
  private async discard(attachment: MessageAttachmentRow, reason: string): Promise<void> {
    await this.storage.delete(attachment.storageKey);
    this.logger.warn(`message attachment upload rejected (${reason}) for ${attachment.id}`);
  }
}

/**
 * The object key for one message photo: a fresh UUIDv7 under its own flat
 * prefix. Server-generated, never a client filename (ADR-0005), and — the rule
 * `order-photos.service.ts#buildPhotoKey` sets out — carrying no order,
 * conversation or party identifier, because both providers copy the key
 * verbatim into every presigned URL. Nothing derives ownership from it; every
 * check reads the row.
 *
 * A prefix of its own rather than `orders/photos/`, so an operator looking at
 * the bucket can tell a transcript's photo from an order's without a query.
 */
function buildAttachmentKey(): string {
  return `conversations/photos/${uuidV7()}`;
}

function toConfirmedResponse(row: MessageAttachmentRow): ConfirmedMessageAttachment {
  if (row.verifiedContentType === null || row.sizeBytes === null || row.submittedAt === null) {
    throw new Error(`message attachment ${row.id} was confirmed without its verified facts`);
  }
  return {
    id: row.id,
    contentType: row.verifiedContentType,
    sizeBytes: row.sizeBytes,
    confirmedAt: row.submittedAt.toISOString(),
  };
}
