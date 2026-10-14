import { Logger } from '@nestjs/common';

import type { CdnPurger } from './cdn-purger.types';

/**
 * Thrown when the stub is constructed in production.
 *
 * The mechanism every stub here uses. A production deploy that purged
 * nothing would boot green, delete every photo a master deleted, and keep
 * serving each one from the CDN for up to a year, which is ADR-0045 § 6's
 * deletion promise broken without a single error logged.
 */
export class StubCdnPurgerInProductionError extends Error {
  constructor() {
    super(
      'CDN_PURGE_PROVIDER=stub cannot be used in production: it purges nothing, so a deleted ' +
        'photo would stay on the CDN for as long as its year-long cache held it. Set ' +
        'CDN_PURGE_PROVIDER=cloudflare with CLOUDFLARE_ZONE_ID and CLOUDFLARE_PURGE_API_TOKEN ' +
        '(ADR-0045).',
    );
    this.name = 'StubCdnPurgerInProductionError';
    Object.setPrototypeOf(this, StubCdnPurgerInProductionError.prototype);
  }
}

/**
 * The development and test purger: it remembers what it was asked to purge.
 *
 * There is no cache in front of the stub storage provider, so there is
 * nothing to remove. What a caller's test needs is the other half — that the
 * deletion path asked for the right URLs — and {@link purged} answers it.
 */
export class StubCdnPurger implements CdnPurger {
  private readonly logger = new Logger(StubCdnPurger.name);
  private readonly purgedUrls: string[] = [];

  constructor(private readonly nodeEnv: 'development' | 'test' | 'production') {
    if (nodeEnv === 'production') {
      throw new StubCdnPurgerInProductionError();
    }
  }

  purgeUrls(urls: readonly string[]): Promise<void> {
    if (this.nodeEnv === 'development' && urls.length > 0) {
      this.logger.warn(`[STUB CDN] purge of ${String(urls.length)} URL(s) recorded, not sent`);
    }
    this.purgedUrls.push(...urls);
    return Promise.resolve();
  }

  /** Test helper: every URL purged so far, in order, repeats included. */
  purged(): readonly string[] {
    return [...this.purgedUrls];
  }
}
