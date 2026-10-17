import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, Transaction } from '../../infra/database/database.types';
import { masters } from '../../infra/database/schema/masters';
import { portfolioMedia, portfolioPosts } from '../../infra/database/schema/portfolio';
import type { PortfolioMediaRow, PortfolioPostRow } from '../../infra/database/schema/portfolio';
import type { AdminPortfolioPosition } from './portfolio-cursor';

export type AdminPostStatusFilter =
  'draft' | 'processing' | 'published' | 'failed' | 'deleted' | 'removed';

export interface AdminPostRow {
  readonly post: PortfolioPostRow;
  readonly masterName: string;
  readonly masterStatus: string;
}

export interface AdminListedPostRow extends AdminPostRow {
  /** `created_at` at microsecond precision, for the list's cursor. */
  readonly createdAtExact: string;
}

export type RemovalOutcome =
  | { readonly kind: 'removed'; readonly post: PortfolioPostRow }
  | { readonly kind: 'missing' }
  | { readonly kind: 'already_removed' }
  | { readonly kind: 'not_published'; readonly status: string };

/**
 * The portfolio's tables as a moderator reads and changes them (#312,
 * ADR-0045 § 6). Every status is visible here, deleted and removed ones too:
 * a moderator answers questions about what was shown, and when.
 */
@Injectable()
export class PortfolioModerationRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Newest first, keyset on `(created_at, id)` — `portfolio_posts_created_idx`,
   * or `portfolio_posts_master_created_idx` with a master filter. The cursor
   * is the previous page's last `(created_at, id)`, compared as constants so
   * the index seeks to it, whether or not that post still exists.
   */
  async list(input: {
    masterId?: string | undefined;
    status?: AdminPostStatusFilter | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    after: AdminPortfolioPosition | null;
    limit: number;
  }): Promise<AdminListedPostRow[]> {
    // A removed post keeps its status, so "published" means still shown.
    const status =
      input.status === undefined
        ? undefined
        : input.status === 'removed'
          ? isNotNull(portfolioPosts.removedAt)
          : input.status === 'published'
            ? and(eq(portfolioPosts.status, 'published'), isNull(portfolioPosts.removedAt))
            : eq(portfolioPosts.status, input.status);
    const after =
      input.after === null
        ? undefined
        : sql`(${portfolioPosts.createdAt}, ${portfolioPosts.id}) < (${input.after.createdAt}::timestamptz, ${input.after.id}::uuid)`;
    const rows = await this.db
      .select({
        post: portfolioPosts,
        masterName: masters.displayName,
        masterStatus: masters.verificationStatus,
        createdAtExact: sql<string>`to_char(${portfolioPosts.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(portfolioPosts)
      .innerJoin(masters, eq(masters.id, portfolioPosts.masterId))
      .where(
        and(
          input.masterId === undefined ? undefined : eq(portfolioPosts.masterId, input.masterId),
          status,
          input.from === undefined ? undefined : gte(portfolioPosts.createdAt, input.from),
          input.to === undefined ? undefined : lte(portfolioPosts.createdAt, input.to),
          after,
        ),
      )
      .orderBy(sql`${portfolioPosts.createdAt} desc`, sql`${portfolioPosts.id} desc`)
      .limit(input.limit);
    return rows;
  }

  async find(postId: string): Promise<AdminPostRow | undefined> {
    const [row] = await this.db
      .select({
        post: portfolioPosts,
        masterName: masters.displayName,
        masterStatus: masters.verificationStatus,
      })
      .from(portfolioPosts)
      .innerJoin(masters, eq(masters.id, portfolioPosts.masterId))
      .where(eq(portfolioPosts.id, postId))
      .limit(1);
    return row;
  }

  async listMedia(postId: string): Promise<PortfolioMediaRow[]> {
    return this.db
      .select()
      .from(portfolioMedia)
      .where(eq(portfolioMedia.postId, postId))
      .orderBy(asc(portfolioMedia.position));
  }

  /**
   * Removes a published post with a reason, and runs `record` — the audit —
   * in the same transaction (ADR-0045 § 6). The post stays `published` and is
   * marked, as a removed review is; every reader filters `removed_at`.
   */
  async remove(input: {
    postId: string;
    adminId: string;
    reason: string;
    now: Date;
    record: (tx: Transaction, post: PortfolioPostRow) => Promise<void>;
  }): Promise<RemovalOutcome> {
    return this.db.transaction(async (tx) => {
      const [post] = await tx
        .select()
        .from(portfolioPosts)
        .where(eq(portfolioPosts.id, input.postId))
        .for('update')
        .limit(1);
      if (post === undefined) {
        return { kind: 'missing' } as const;
      }
      if (post.removedAt !== null) {
        return { kind: 'already_removed' } as const;
      }
      if (post.status !== 'published') {
        return { kind: 'not_published', status: post.status } as const;
      }
      const [removed] = await tx
        .update(portfolioPosts)
        .set({ removedAt: input.now, removedByAdminId: input.adminId, removalReason: input.reason })
        .where(eq(portfolioPosts.id, post.id))
        .returning();
      if (removed === undefined) {
        throw new Error('the locked post vanished inside its own transaction');
      }
      await input.record(tx, post);
      return { kind: 'removed', post: removed } as const;
    });
  }

  /** The rendition keys of a post's photos, in position order. */
  async renditionKeys(postId: string): Promise<string[]> {
    const rows = await this.db
      .select({ thumbKey: portfolioMedia.thumbKey, displayKey: portfolioMedia.displayKey })
      .from(portfolioMedia)
      .where(eq(portfolioMedia.postId, postId))
      .orderBy(asc(portfolioMedia.position));
    return rows
      .flatMap((row) => [row.thumbKey, row.displayKey])
      .filter((key): key is string => key !== null);
  }

  /**
   * Posts removed between `retainedSince` and `before` whose renditions are
   * still public: never tried by the sweep first, then the least recently
   * tried, so one whose move keeps failing cannot hold the batch (#362).
   * Older ones are past retention and the purge's, not the move's.
   *
   * `portfolio_posts_removed_idx` finds them and the few found are sorted. A
   * second partial index in this order was tried and the planner kept this
   * one: it cannot tell how few removed posts are still unmoved.
   */
  async listEvidenceToMove(retainedSince: Date, before: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: portfolioPosts.id })
      .from(portfolioPosts)
      .where(
        and(
          isNotNull(portfolioPosts.removedAt),
          isNull(portfolioPosts.evidenceMovedAt),
          isNull(portfolioPosts.evidencePurgedAt),
          gte(portfolioPosts.removedAt, retainedSince),
          lt(portfolioPosts.removedAt, before),
        ),
      )
      .orderBy(
        sql`${portfolioPosts.evidenceAttemptedAt} nulls first`,
        asc(portfolioPosts.removedAt),
      )
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** Sends the post to the back of the sweep's queues, before the sweep tries it. */
  async markEvidenceAttempted(postId: string, now: Date): Promise<void> {
    await this.db
      .update(portfolioPosts)
      .set({ evidenceAttemptedAt: now })
      .where(and(eq(portfolioPosts.id, postId), isNotNull(portfolioPosts.removedAt)));
  }

  /**
   * Records the move; false when there is nothing to record — already moved,
   * or purged while the move ran.
   */
  async markEvidenceMoved(postId: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(portfolioPosts)
      .set({ evidenceMovedAt: now })
      .where(
        and(
          eq(portfolioPosts.id, postId),
          isNotNull(portfolioPosts.removedAt),
          isNull(portfolioPosts.evidenceMovedAt),
          isNull(portfolioPosts.evidencePurgedAt),
        ),
      )
      .returning({ id: portfolioPosts.id });
    return rows.length > 0;
  }

  /** Whether the post's evidence has been purged; false for an unknown post. */
  async isEvidencePurged(postId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ purgedAt: portfolioPosts.evidencePurgedAt })
      .from(portfolioPosts)
      .where(eq(portfolioPosts.id, postId))
      .limit(1);
    return row !== undefined && row.purgedAt !== null;
  }

  /**
   * Evidence past its retention, removed before `before`, whether or not it
   * ever moved: never tried first, then the least recently tried, as the
   * move (#362, `portfolio_posts_removed_idx`).
   */
  async listEvidenceToPurge(
    before: Date,
    limit: number,
  ): Promise<{ id: string; moved: boolean }[]> {
    const rows = await this.db
      .select({ id: portfolioPosts.id, movedAt: portfolioPosts.evidenceMovedAt })
      .from(portfolioPosts)
      .where(
        and(
          isNotNull(portfolioPosts.removedAt),
          isNull(portfolioPosts.evidencePurgedAt),
          lt(portfolioPosts.removedAt, before),
        ),
      )
      .orderBy(
        sql`${portfolioPosts.evidenceAttemptedAt} nulls first`,
        asc(portfolioPosts.removedAt),
      )
      .limit(limit);
    return rows.map((row) => ({ id: row.id, moved: row.movedAt !== null }));
  }

  async markEvidencePurged(postId: string, now: Date): Promise<void> {
    await this.db
      .update(portfolioPosts)
      .set({ evidencePurgedAt: now })
      .where(
        and(
          eq(portfolioPosts.id, postId),
          isNotNull(portfolioPosts.removedAt),
          isNull(portfolioPosts.evidencePurgedAt),
        ),
      );
  }
}
