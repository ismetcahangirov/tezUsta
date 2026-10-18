import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { MediaJobTargetRegistry } from '../../infra/media/media-job-target';
import type {
  MediaJobSource,
  MediaJobTarget,
  StoredRendition,
} from '../../infra/media/media-job-target';
import { PRIVATE_PHOTO_RENDITIONS } from '../../infra/media/media-processor.types';
import type { MediaFailureCode } from '../../infra/media/media-processor.types';
import { MessageAttachmentsRepository } from './message-attachments.repository';

/** The `media` queue purpose of a conversation photo's re-encoding. */
export const MESSAGE_ATTACHMENT_PURPOSE = 'message-attachment';

/**
 * A conversation photo's side of the `media` queue (#318), as
 * `OrderPhotosMediaTarget` is an order photo's: the upload is re-encoded
 * without its metadata, GPS included, into the private bucket, and the copy
 * replaces it. This happens between confirm and send, because a sent photo is
 * part of a write-once transcript.
 *
 * Every method is idempotent: each is a conditional UPDATE on a photo not yet
 * re-encoded, so a retried job finds nothing left to do.
 */
@Injectable()
export class MessageAttachmentsMediaTarget implements MediaJobTarget, OnModuleInit {
  constructor(
    private readonly attachments: MessageAttachmentsRepository,
    private readonly targets: MediaJobTargetRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.targets.register(MESSAGE_ATTACHMENT_PURPOSE, this);
  }

  async load(itemId: string): Promise<MediaJobSource | undefined> {
    const attachment = await this.attachments.findToSanitize(itemId);
    if (attachment === undefined) {
      return undefined;
    }
    return {
      rawKey: attachment.storageKey,
      maxBytes: this.config.storage.orderPhotoMaxBytes,
      keyPrefix: 'message-attachments',
      renditions: PRIVATE_PHOTO_RENDITIONS,
      destination: 'private',
      ...(attachment.sanitizedKey === null
        ? {}
        : { reservedKeys: { display: attachment.sanitizedKey } }),
    };
  }

  async reserveKeys(itemId: string, keys: Readonly<Record<string, string>>): Promise<void> {
    const key = keys.display;
    if (key === undefined) {
      throw new Error('A message photo needs its display rendition key');
    }
    await this.attachments.reserveSanitizedKey(itemId, key);
  }

  async complete(
    itemId: string,
    renditions: readonly StoredRendition[],
  ): Promise<'accepted' | 'discarded'> {
    const display = renditions.find((rendition) => rendition.name === 'display');
    if (display === undefined) {
      throw new Error('A message photo needs its display rendition');
    }
    const accepted = await this.attachments.completeSanitizing({
      attachmentId: itemId,
      key: display.key,
      sizeBytes: display.bytes,
      contentType: 'image/webp',
      now: new Date(),
    });
    if (accepted) {
      return 'accepted';
    }
    // Nothing matched: the photo is gone, or a second run of this job got
    // there first, over the same reserved key. The pipeline deletes what is
    // discarded, so a key the row names is never called that.
    return (await this.attachments.findStorageKey(itemId)) === display.key
      ? 'accepted'
      : 'discarded';
  }

  /** The pipeline deletes the upload itself; the row is the unsent sweep's. */
  async fail(itemId: string, code: MediaFailureCode): Promise<void> {
    await this.attachments.failSanitizing(itemId, code);
  }
}
