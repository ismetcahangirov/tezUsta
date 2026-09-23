import { Inject, Injectable } from '@nestjs/common';
import type { MessageAttachment } from '@tezusta/types';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { MessageAttachmentRow } from '../../infra/database/schema/message-attachments';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import { MessageAttachmentsRepository } from './message-attachments.repository';

/**
 * The read half of message photos (issue #181): turns attached rows into what
 * a party's app is shown — a short-lived presigned GET per photo.
 *
 * **No actor and no party check, and that is where it sits, not an
 * omission.** It is called only by `ConversationsService`, after
 * `requireParty` has answered for the order and the conversation, with rows or
 * message ids that came out of *that* conversation. Putting a second party
 * check here would be the party rule written twice, which is the one thing
 * `requireParty`'s single definition exists to prevent.
 *
 * **Its own provider rather than a method on `MessageAttachmentsService`**,
 * because of the direction of the dependency: that service asks
 * `ConversationsService` who the caller is, and `ConversationsService` needs
 * this to present a message. Both living in one class would be a cycle
 * `no-circular` refuses (CLAUDE.md §14).
 *
 * The TTL is `UPLOAD_DOWNLOAD_TTL_SECONDS`, the one every other read URL in the
 * product uses — two minutes by default, bounded at five — so "short-lived"
 * means the same thing for a photo in a conversation as for the photo on the
 * order it is about.
 */
@Injectable()
export class MessageAttachmentsReader {
  constructor(
    private readonly attachments: MessageAttachmentsRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The photos on each of a page of messages, keyed by message id — one query
   * for the page, then presigning, which touches no database. A message with
   * none is absent from the map.
   */
  async forMessages(messageIds: readonly string[]): Promise<Map<string, MessageAttachment[]>> {
    const grouped = await this.attachments.listForMessages(messageIds);

    const presented = new Map<string, MessageAttachment[]>();
    await Promise.all(
      [...grouped].map(async ([messageId, rows]) => {
        presented.set(messageId, await this.present(rows));
      }),
    );
    return presented;
  }

  /** Rows already in hand — the send path, which has just attached them. */
  async present(rows: readonly MessageAttachmentRow[]): Promise<MessageAttachment[]> {
    return Promise.all(rows.map((row) => this.presentOne(row)));
  }

  /**
   * The row-to-contract projection. The storage key, the uploader and the
   * *declared* type are all left out — see `MessageAttachment` in
   * `packages/types`.
   *
   * An attached row always has a verified type and a size
   * (`message_attachments_lifecycle_shape`). The guard below throws rather
   * than falling back to the declared type, because a fallback would be the
   * one path on which a client's claim about its own bytes reached the other
   * party as fact.
   */
  private async presentOne(row: MessageAttachmentRow): Promise<MessageAttachment> {
    if (row.verifiedContentType === null || row.sizeBytes === null) {
      throw new Error(`message attachment ${row.id} is presented without having been confirmed`);
    }
    const presigned = await this.storage.presignDownload({
      key: row.storageKey,
      ttlSeconds: this.config.storage.downloadTtlSeconds,
    });
    return {
      id: row.id,
      contentType: row.verifiedContentType,
      sizeBytes: row.sizeBytes,
      url: presigned.url,
      expiresAt: presigned.expiresAt.toISOString(),
    };
  }
}
