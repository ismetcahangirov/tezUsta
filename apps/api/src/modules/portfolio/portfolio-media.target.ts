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
import { PORTFOLIO_RENDITIONS } from '../../infra/media/media-processor.types';
import type { MediaFailureCode } from '../../infra/media/media-processor.types';
import { PortfolioRepository } from './portfolio.repository';
import { PORTFOLIO_PHOTO_PURPOSE } from './portfolio.service';

/**
 * The portfolio's side of the `media` queue (#305): what a portfolio photo's
 * job processes, and what its outcome does to `portfolio_media` and the post.
 *
 * Every method is idempotent, as the queue requires: each one is a conditional
 * UPDATE on the photo's status, so a retried job or a second worker finds
 * nothing left to do rather than doing it twice.
 */
@Injectable()
export class PortfolioMediaTarget implements MediaJobTarget, OnModuleInit {
  constructor(
    private readonly portfolio: PortfolioRepository,
    private readonly targets: MediaJobTargetRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.targets.register(PORTFOLIO_PHOTO_PURPOSE, this);
  }

  async load(itemId: string): Promise<MediaJobSource | undefined> {
    const media = await this.portfolio.claimForProcessing(itemId);
    if (media === undefined) {
      return undefined;
    }
    return {
      rawKey: media.rawStorageKey,
      maxBytes: this.config.portfolio.imageMaxBytes,
      keyPrefix: 'portfolio',
      renditions: PORTFOLIO_RENDITIONS,
      ...(media.thumbKey !== null && media.displayKey !== null
        ? { reservedKeys: { thumb: media.thumbKey, display: media.displayKey } }
        : {}),
    };
  }

  async reserveKeys(itemId: string, keys: Readonly<Record<string, string>>): Promise<void> {
    await this.portfolio.reserveKeys(itemId, {
      thumbKey: requireKey(keys, 'thumb'),
      displayKey: requireKey(keys, 'display'),
    });
  }

  /** The display rendition's size is the photo's: the viewer lays out from it before it loads. */
  async complete(
    itemId: string,
    renditions: readonly StoredRendition[],
  ): Promise<'accepted' | 'discarded'> {
    const thumb = renditions.find((rendition) => rendition.name === 'thumb');
    const display = renditions.find((rendition) => rendition.name === 'display');
    if (thumb === undefined || display === undefined) {
      throw new Error('A portfolio photo needs both its thumb and display renditions');
    }
    return this.portfolio.completeMedia(
      itemId,
      {
        thumbKey: thumb.key,
        displayKey: display.key,
        width: display.width,
        height: display.height,
        bytesTotal: thumb.bytes + display.bytes,
      },
      new Date(),
    );
  }

  async fail(itemId: string, code: MediaFailureCode): Promise<void> {
    await this.portfolio.failMedia(itemId, code);
  }
}

function requireKey(keys: Readonly<Record<string, string>>, name: string): string {
  const key = keys[name];
  if (key === undefined) {
    throw new Error(`No "${name}" rendition key was reserved for a portfolio photo`);
  }
  return key;
}
