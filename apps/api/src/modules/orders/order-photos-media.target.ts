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
import { OrderPhotosRepository } from './order-photos.repository';

/** The `media` queue purpose of an order photo's re-encoding. */
export const ORDER_PHOTO_PURPOSE = 'order-photo';

/**
 * An order photo's side of the `media` queue (#318): the upload is
 * re-encoded without its metadata — GPS included — into the private bucket,
 * and the copy replaces it.
 *
 * Every method is idempotent: each is a conditional UPDATE on a photo not yet
 * re-encoded, so a retried job finds nothing left to do.
 */
@Injectable()
export class OrderPhotosMediaTarget implements MediaJobTarget, OnModuleInit {
  constructor(
    private readonly photos: OrderPhotosRepository,
    private readonly targets: MediaJobTargetRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.targets.register(ORDER_PHOTO_PURPOSE, this);
  }

  async load(itemId: string): Promise<MediaJobSource | undefined> {
    const photo = await this.photos.findToSanitize(itemId);
    if (photo === undefined) {
      return undefined;
    }
    return {
      rawKey: photo.storageKey,
      maxBytes: this.config.storage.orderPhotoMaxBytes,
      keyPrefix: 'order-photos',
      renditions: PRIVATE_PHOTO_RENDITIONS,
      destination: 'private',
      ...(photo.sanitizedKey === null ? {} : { reservedKeys: { display: photo.sanitizedKey } }),
    };
  }

  async reserveKeys(itemId: string, keys: Readonly<Record<string, string>>): Promise<void> {
    const key = keys.display;
    if (key === undefined) {
      throw new Error('An order photo needs its display rendition key');
    }
    await this.photos.reserveSanitizedKey(itemId, key);
  }

  async complete(
    itemId: string,
    renditions: readonly StoredRendition[],
  ): Promise<'accepted' | 'discarded'> {
    const display = renditions.find((rendition) => rendition.name === 'display');
    if (display === undefined) {
      throw new Error('An order photo needs its display rendition');
    }
    const accepted = await this.photos.completeSanitizing({
      photoId: itemId,
      key: display.key,
      sizeBytes: display.bytes,
      contentType: 'image/webp',
      now: new Date(),
    });
    if (accepted) {
      return 'accepted';
    }
    // Nothing matched: the photo is gone, or a second run of this job got
    // there first — over the same reserved key. The pipeline deletes what is
    // discarded, so a key the row names is never called that.
    return (await this.photos.findStorageKey(itemId)) === display.key ? 'accepted' : 'discarded';
  }

  /** The pipeline deletes the upload itself; the keys returned are the sweep's concern. */
  async fail(itemId: string, code: MediaFailureCode): Promise<void> {
    await this.photos.failSanitizing(itemId, code);
  }
}
