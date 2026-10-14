import { Inject, Injectable } from '@nestjs/common';
import type {
  CursorPage,
  MasterPublicProfile,
  PortfolioMedia,
  PortfolioPost,
} from '@tezusta/types';

import { NotFoundError } from '../../common/errors/not-found.error';
import { resolveLocalizedText } from '../../common/i18n/resolve-localized-text';
import { toPartyRating } from '../../common/rating/party-rating';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { PortfolioMediaRow, PortfolioPostRow } from '../../infra/database/schema/portfolio';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import type { Actor } from '../auth/auth.types';
import { decodePortfolioCursor, encodePortfolioCursor } from './portfolio-cursor';
import { PublicProfileRepository } from './public-profile.repository';
import type { PublicService, ShownMaster } from './public-profile.repository';

/** The feed's first page on the profile, and the default page after it. */
export const PROFILE_FEED_PAGE = 18;

/**
 * A master's public profile and portfolio (#310, ADR-0045 § 1–2).
 *
 * **Who may read it is decided on every request**: the master themselves,
 * or the customer of an order this master is on now, or completed within the
 * review window — and only while the master can be shown (active, not
 * deleted, account not suspended). Everyone else gets the 404 a missing
 * master gets, so a master id cannot be probed for whether it exists, is
 * suspended, or is simply not the caller's to see. There is no list.
 *
 * **What it shows is ADR-0045 § 1, and nothing else.** Every response is
 * built field by field from an allow-list below: a column added to `masters`
 * reaches no customer by accident. No post count and no "member since" —
 * § 1 is the whole list. No phone, location, verification data, storage key,
 * order or customer reference: the test asserts the exact key sets.
 */
@Injectable()
export class PublicProfileService {
  constructor(
    private readonly profiles: PublicProfileRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async getProfile(
    actor: Actor,
    masterId: string,
    languages: readonly string[],
  ): Promise<MasterPublicProfile> {
    const master = await this.requireVisible(actor, masterId);
    const services = await this.profiles.listActiveServices(master.id);
    const page = await this.feedPage(master.id, null, PROFILE_FEED_PAGE, services, languages);
    return {
      masterId: master.id,
      displayName: master.displayName,
      bio: master.bio,
      avatarUrl: this.url(master.avatarThumbKey),
      avatarLargeUrl: this.url(master.avatarDisplayKey),
      rating: toPartyRating(master.ratingSum, master.ratingCount),
      services: services.map((service) => ({
        serviceId: service.serviceId,
        name: resolveLocalizedText(service.name, languages),
        priceMinor: service.priceMinor,
      })),
      posts: page.items,
      nextCursor: page.nextCursor,
    };
  }

  async getPortfolio(
    actor: Actor,
    masterId: string,
    query: { cursor?: string | undefined; limit: number },
    languages: readonly string[],
  ): Promise<CursorPage<PortfolioPost>> {
    const master = await this.requireVisible(actor, masterId);
    const services = await this.profiles.listActiveServices(master.id);
    return this.feedPage(
      master.id,
      decodePortfolioCursor(query.cursor),
      query.limit,
      services,
      languages,
    );
  }

  private async requireVisible(actor: Actor, masterId: string): Promise<ShownMaster> {
    const master = await this.profiles.findShownMaster(masterId);
    if (master === undefined) {
      throw new NotFoundError();
    }
    if (master.userId === actor.userId) {
      return master;
    }
    const visible = await this.profiles.isCustomerOfMaster({
      userId: actor.userId,
      masterId: master.id,
      reviewWindowHours: this.config.reviews.windowHours,
    });
    if (!visible) {
      throw new NotFoundError();
    }
    return master;
  }

  private async feedPage(
    masterId: string,
    afterPostId: string | null,
    limit: number,
    services: readonly PublicService[],
    languages: readonly string[],
  ): Promise<CursorPage<PortfolioPost>> {
    const rows = await this.profiles.listFeed({ masterId, afterPostId, limit: limit + 1 });
    const page = rows.slice(0, limit);
    const media = await this.profiles.listReadyMedia(page.map((row) => row.id));
    const byPost = new Map<string, PortfolioMediaRow[]>();
    for (const item of media) {
      const list = byPost.get(item.postId) ?? [];
      list.push(item);
      byPost.set(item.postId, list);
    }
    const offered = new Map(services.map((service) => [service.serviceId, service.name]));
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toPost(row, byPost.get(row.id) ?? [], offered, languages)),
      nextCursor: rows.length > limit && last !== undefined ? encodePortfolioCursor(last.id) : null,
    };
  }

  /**
   * A post as a profile reader sees it. The tag shows only while the master
   * still offers that service (ADR-0045 § 3), and comes back if they offer it
   * again.
   */
  private toPost(
    row: PortfolioPostRow,
    media: readonly PortfolioMediaRow[],
    offered: ReadonlyMap<string, PublicService['name']>,
    languages: readonly string[],
  ): PortfolioPost {
    const serviceName = row.serviceId === null ? undefined : offered.get(row.serviceId);
    return {
      id: row.id,
      caption: row.caption,
      service:
        row.serviceId === null || serviceName === undefined
          ? null
          : { serviceId: row.serviceId, name: resolveLocalizedText(serviceName, languages) },
      media: media.flatMap((item) => this.toMedia(item)),
    };
  }

  private toMedia(item: PortfolioMediaRow): PortfolioMedia[] {
    if (
      item.thumbKey === null ||
      item.displayKey === null ||
      item.width === null ||
      item.height === null
    ) {
      return [];
    }
    return [
      {
        id: item.id,
        thumbUrl: this.storage.publicUrl(item.thumbKey),
        displayUrl: this.storage.publicUrl(item.displayKey),
        width: item.width,
        height: item.height,
      },
    ];
  }

  private url(key: string | null): string | null {
    return key === null ? null : this.storage.publicUrl(key);
  }
}
