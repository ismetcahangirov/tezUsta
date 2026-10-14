import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { LocalizedText } from '../../common/i18n/localized-text.types';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { masterServices, masters } from '../../infra/database/schema/masters';
import { portfolioMedia, portfolioPosts } from '../../infra/database/schema/portfolio';
import type { PortfolioMediaRow, PortfolioPostRow } from '../../infra/database/schema/portfolio';
import { services } from '../../infra/database/schema/services';
import { users } from '../../infra/database/schema/users';

/** The order statuses in which the master is on the customer's order (ADR-0045 § 2). */
const ON_THE_ORDER = ['ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS'] as const;

export interface ShownMaster {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly avatarThumbKey: string | null;
  readonly avatarDisplayKey: string | null;
  readonly ratingSum: number;
  readonly ratingCount: number;
}

export interface PublicService {
  readonly serviceId: string;
  readonly name: LocalizedText;
  readonly priceMinor: number | null;
}

/**
 * The read model behind a master's public profile (#310, ADR-0045 § 1–2).
 *
 * It reads across tables other modules own — `masters`, `users`, `orders`,
 * `order_status_history`, `master_services` — because the question it answers
 * ("may this caller see this master, and what do they see") is one question
 * about all of them at once. Read-only, like `OrdersAdminReadService`: no
 * table is written here, so the owning modules keep every write.
 */
@Injectable()
export class PublicProfileRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * The master, **only while they can be shown** (ADR-0045 § 2): verified
   * `active`, not deleted, and their account not suspended. Anything else is
   * `undefined`, so a suspended master and a missing one read the same.
   */
  async findShownMaster(masterId: string): Promise<ShownMaster | undefined> {
    const [row] = await this.db
      .select({
        id: masters.id,
        userId: masters.userId,
        displayName: masters.displayName,
        bio: masters.bio,
        avatarThumbKey: masters.avatarThumbKey,
        avatarDisplayKey: masters.avatarDisplayKey,
        ratingSum: masters.ratingSum,
        ratingCount: masters.ratingCount,
      })
      .from(masters)
      .innerJoin(users, eq(users.id, masters.userId))
      .where(
        and(
          eq(masters.id, masterId),
          eq(masters.verificationStatus, 'active'),
          isNull(masters.deletedAt),
          eq(users.status, 'active'),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Whether this user is the customer of an order this master is on now, or
   * completed within the review window (ADR-0045 § 2, ADR-0042 § 2's window,
   * measured from the `COMPLETED` row as reviews measure it). A re-dispatch
   * moves `master_id` off the order and a cancellation moves its status, so
   * either ends the access at that moment.
   */
  async isCustomerOfMaster(input: {
    userId: string;
    masterId: string;
    reviewWindowHours: number;
  }): Promise<boolean> {
    const result = await this.db.execute<{ visible: boolean }>(sql`
      select exists (
        select 1
          from orders o
          join customers c on c.id = o.customer_id
         where c.user_id = ${input.userId}
           and c.deleted_at is null
           and o.master_id = ${input.masterId}
           and (
             o.status in (${sql.join(
               ON_THE_ORDER.map((status) => sql`${status}`),
               sql`, `,
             )})
             or exists (
               select 1 from order_status_history h
                where h.order_id = o.id
                  and h.to_status = 'COMPLETED'
                  and h.created_at > now() - make_interval(hours => ${input.reviewWindowHours})
             )
           )
      ) as visible
    `);
    return result.rows[0]?.visible === true;
  }

  /** The master's services shown on the profile: their own offer and the catalogue entry both active. */
  async listActiveServices(masterId: string): Promise<PublicService[]> {
    return (
      this.db
        .select({
          serviceId: masterServices.serviceId,
          name: services.name,
          priceMinor: masterServices.priceMinor,
        })
        .from(masterServices)
        .innerJoin(services, eq(services.id, masterServices.serviceId))
        .where(
          and(
            eq(masterServices.masterId, masterId),
            eq(masterServices.isActive, true),
            eq(services.isActive, true),
          ),
        )
        // The order the master's own services screen uses (`masters.repository.ts`).
        .orderBy(sql`${services.name} ->> 'az'`, asc(masterServices.serviceId))
    );
  }

  /**
   * One page of the master's feed: published and not removed, newest first,
   * keyset-paged on `(published_at, id)` — exactly `portfolio_posts_feed_idx`.
   * The cursor names the last post of the previous page, resolved at the
   * column's own precision — and only among this master's own posts, so a
   * cursor cannot be used to compare another master's post against this feed.
   * A cursor that names nothing of theirs (a garbage id, a post since hard
   * deleted) reads as the first page, as a malformed cursor does; an empty
   * page would tell the app the feed had ended.
   */
  async listFeed(input: {
    masterId: string;
    afterPostId: string | null;
    limit: number;
  }): Promise<PortfolioPostRow[]> {
    const after =
      input.afterPostId === null
        ? undefined
        : sql`(
            (${portfolioPosts.publishedAt}, ${portfolioPosts.id}) < (
              select p.published_at, p.id from portfolio_posts p
               where p.id = ${input.afterPostId} and p.master_id = ${input.masterId}
            )
            or not exists (
              select 1 from portfolio_posts p
               where p.id = ${input.afterPostId} and p.master_id = ${input.masterId}
                 and p.published_at is not null
            )
          )`;
    return this.db
      .select()
      .from(portfolioPosts)
      .where(
        and(
          eq(portfolioPosts.masterId, input.masterId),
          eq(portfolioPosts.status, 'published'),
          isNull(portfolioPosts.removedAt),
          after,
        ),
      )
      .orderBy(sql`${portfolioPosts.publishedAt} desc`, sql`${portfolioPosts.id} desc`)
      .limit(input.limit);
  }

  /** A page's photos in one query. A published post's photos are all `ready`; the filter says so anyway. */
  async listReadyMedia(postIds: readonly string[]): Promise<PortfolioMediaRow[]> {
    if (postIds.length === 0) {
      return [];
    }
    return this.db
      .select()
      .from(portfolioMedia)
      .where(and(inArray(portfolioMedia.postId, [...postIds]), eq(portfolioMedia.status, 'ready')))
      .orderBy(asc(portfolioMedia.postId), asc(portfolioMedia.position));
  }
}
