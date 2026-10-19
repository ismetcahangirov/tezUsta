import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { isUniqueViolationOn } from '../../infra/database/database-error';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { masters } from '../../infra/database/schema/masters';
import type { PortfolioMediaRow, PortfolioPostRow } from '../../infra/database/schema/portfolio';
import { portfolioMedia, portfolioPosts } from '../../infra/database/schema/portfolio';
import { services } from '../../infra/database/schema/services';
import type { LocalizedText } from '../../common/i18n/localized-text.types';

export type AddMediaOutcome =
  | { readonly kind: 'created'; readonly row: PortfolioMediaRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_editable' }
  | { readonly kind: 'limit_exceeded' }
  | { readonly kind: 'position_taken' };

export type RemoveMediaOutcome =
  | { readonly kind: 'removed'; readonly row: PortfolioMediaRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_editable' };

export type PublishOutcome =
  | { readonly kind: 'published' | 'processing'; readonly row: PortfolioPostRow }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_editable' }
  | { readonly kind: 'not_ready' }
  | { readonly kind: 'limit_exceeded' }
  | { readonly kind: 'master_not_active'; readonly verificationStatus: string | null };

export type DeletePostOutcome = 'deleted' | 'not_found' | 'removed';

/** What the `media` worker needs to process one photo (#305's `MediaJobSource`, minus the specs). */
export interface ProcessableMedia {
  readonly rawStorageKey: string;
  readonly thumbKey: string | null;
  readonly displayKey: string | null;
}

export interface ReadyRenditions {
  readonly thumbKey: string;
  readonly displayKey: string;
  readonly width: number;
  readonly height: number;
  readonly bytesTotal: number;
}

/** Statuses a post counts toward `PORTFOLIO_MAX_POSTS` in. A draft and a failed post do not. */
const COUNTED_POST_STATUSES = ['processing', 'published'] as const;

/**
 * The advisory-lock key serialising one master's publishes — the
 * `order-create:` lock's shape (`orders.repository.ts`), for its reason: an
 * advisory lock serialises exactly this and nothing else, where `FOR UPDATE`
 * on the master row would also hold up a dispatch accept, an availability
 * toggle and every foreign-key check that references the master.
 */
function publishLockKey(masterId: string): string {
  return `portfolio-publish:${masterId}`;
}

/** Thrown inside a transaction to roll it back with a known outcome. */
class Rollback extends Error {
  constructor(readonly outcome: 'position_taken') {
    super(outcome);
    this.name = 'Rollback';
  }
}

/**
 * The master portfolio's tables (#308): `portfolio_posts` and `portfolio_media`.
 *
 * **Locks are always taken in one order: the master, then the post, then its
 * photos.** Publish locks the master row (it alone counts posts), then the
 * post; everything else starts at the post. Two transactions can therefore
 * wait on each other but never deadlock.
 *
 * Every read and write is scoped by `master_id` taken from the caller, never
 * from a client: a post id that belongs to another master reads as absent.
 */
@Injectable()
export class PortfolioRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async createPost(input: {
    masterId: string;
    caption: string | null;
    serviceId: string | null;
  }): Promise<PortfolioPostRow> {
    const [row] = await this.db
      .insert(portfolioPosts)
      .values({
        id: uuidV7(),
        masterId: input.masterId,
        caption: input.caption,
        serviceId: input.serviceId,
      })
      .returning();
    if (row === undefined) {
      throw new Error('insert into portfolio_posts returned no row');
    }
    return row;
  }

  /** One of the master's own posts, unless it is deleted. */
  async findOwnPost(masterId: string, postId: string): Promise<PortfolioPostRow | undefined> {
    const [row] = await this.db
      .select()
      .from(portfolioPosts)
      .where(
        and(
          eq(portfolioPosts.id, postId),
          eq(portfolioPosts.masterId, masterId),
          ne(portfolioPosts.status, 'deleted'),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * The master's posts, newest first, every status but `deleted`.
   *
   * Keyset-paged on `(created_at, id)`, served by
   * `portfolio_posts_master_created_idx`. The cursor names the last post of
   * the previous page; its position is read inside the query at the column's
   * own precision (`call-cursor.ts`'s reasoning). A cursor naming a post that
   * is not there, or is another master's, compares to `NULL` and yields an
   * empty page, so a cursor cannot test whether someone else's post id exists
   * (#391).
   */
  async listOwnPosts(input: {
    masterId: string;
    afterPostId: string | null;
    limit: number;
  }): Promise<PortfolioPostRow[]> {
    const after =
      input.afterPostId === null
        ? undefined
        : sql`(${portfolioPosts.createdAt}, ${portfolioPosts.id}) < (
            select p.created_at, p.id from portfolio_posts p
             where p.id = ${input.afterPostId} and p.master_id = ${input.masterId}
          )`;
    return this.db
      .select()
      .from(portfolioPosts)
      .where(
        and(
          eq(portfolioPosts.masterId, input.masterId),
          ne(portfolioPosts.status, 'deleted'),
          after,
        ),
      )
      .orderBy(sql`${portfolioPosts.createdAt} desc`, sql`${portfolioPosts.id} desc`)
      .limit(input.limit);
  }

  /** Every photo of these posts in one query, by post then position. */
  async listMediaForPosts(postIds: readonly string[]): Promise<PortfolioMediaRow[]> {
    if (postIds.length === 0) {
      return [];
    }
    return this.db
      .select()
      .from(portfolioMedia)
      .where(inArray(portfolioMedia.postId, [...postIds]))
      .orderBy(asc(portfolioMedia.postId), asc(portfolioMedia.position));
  }

  async findServiceNames(serviceIds: readonly string[]): Promise<Map<string, LocalizedText>> {
    if (serviceIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({ id: services.id, name: services.name })
      .from(services)
      .where(inArray(services.id, [...new Set(serviceIds)]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * Claims a place for one photo in a draft post and records its pending
   * upload, together.
   *
   * The count moves first, with a conditional UPDATE — the
   * `orders.photo_count` pattern — so two presigns racing for the last slot
   * cannot both win. The insert follows in the same transaction: if the
   * position is taken, both roll back and the slot is released.
   */
  async addPendingMedia(input: {
    masterId: string;
    postId: string;
    position: number;
    declaredContentType: string;
    rawStorageKey: string;
    presignExpiresAt: Date;
    maxItems: number;
  }): Promise<AddMediaOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(portfolioPosts)
          .set({ mediaCount: sql`${portfolioPosts.mediaCount} + 1` })
          .where(
            and(
              eq(portfolioPosts.id, input.postId),
              eq(portfolioPosts.masterId, input.masterId),
              eq(portfolioPosts.status, 'draft'),
              sql`${portfolioPosts.mediaCount} < ${input.maxItems}`,
            ),
          )
          .returning({ id: portfolioPosts.id });

        if (claimed === undefined) {
          const [post] = await tx
            .select({ status: portfolioPosts.status })
            .from(portfolioPosts)
            .where(
              and(eq(portfolioPosts.id, input.postId), eq(portfolioPosts.masterId, input.masterId)),
            )
            .limit(1);
          if (post === undefined || post.status === 'deleted') {
            return { kind: 'not_found' } as const;
          }
          return post.status === 'draft'
            ? ({ kind: 'limit_exceeded' } as const)
            : ({ kind: 'not_editable' } as const);
        }

        try {
          const [row] = await tx
            .insert(portfolioMedia)
            .values({
              id: uuidV7(),
              postId: input.postId,
              position: input.position,
              rawStorageKey: input.rawStorageKey,
              declaredContentType: input.declaredContentType,
              presignExpiresAt: input.presignExpiresAt,
            })
            .returning();
          if (row === undefined) {
            throw new Error('insert into portfolio_media returned no row');
          }
          return { kind: 'created', row } as const;
        } catch (error) {
          if (isUniqueViolationOn(error, 'portfolio_media_post_position_unique')) {
            throw new Rollback('position_taken');
          }
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof Rollback) {
        return { kind: error.outcome };
      }
      throw error;
    }
  }

  /** One photo of one of the master's own posts that is not deleted. */
  async findOwnMedia(
    masterId: string,
    postId: string,
    mediaId: string,
  ): Promise<{ post: PortfolioPostRow; media: PortfolioMediaRow } | undefined> {
    const [row] = await this.db
      .select({ post: portfolioPosts, media: portfolioMedia })
      .from(portfolioMedia)
      .innerJoin(portfolioPosts, eq(portfolioPosts.id, portfolioMedia.postId))
      .where(
        and(
          eq(portfolioMedia.id, mediaId),
          eq(portfolioMedia.postId, postId),
          eq(portfolioPosts.masterId, masterId),
          ne(portfolioPosts.status, 'deleted'),
        ),
      )
      .limit(1);
    return row;
  }

  /** `awaiting_upload` → `uploaded`, once. `undefined` when another confirm got there first. */
  async confirmMedia(input: {
    mediaId: string;
    sizeBytes: number;
    verifiedContentType: string;
  }): Promise<PortfolioMediaRow | undefined> {
    const [row] = await this.db
      .update(portfolioMedia)
      .set({
        status: 'uploaded',
        rawSizeBytes: input.sizeBytes,
        verifiedContentType: input.verifiedContentType,
      })
      .where(
        and(eq(portfolioMedia.id, input.mediaId), eq(portfolioMedia.status, 'awaiting_upload')),
      )
      .returning();
    return row;
  }

  /** Removes a photo from a draft and frees its slot. Only a draft's photos change. */
  async removeDraftMedia(input: {
    masterId: string;
    postId: string;
    mediaId: string;
  }): Promise<RemoveMediaOutcome> {
    return this.db.transaction(async (tx) => {
      const [post] = await tx
        .select({ status: portfolioPosts.status })
        .from(portfolioPosts)
        .where(
          and(eq(portfolioPosts.id, input.postId), eq(portfolioPosts.masterId, input.masterId)),
        )
        .for('update')
        .limit(1);
      if (post === undefined || post.status === 'deleted') {
        return { kind: 'not_found' } as const;
      }
      if (post.status !== 'draft') {
        return { kind: 'not_editable' } as const;
      }

      const [row] = await tx
        .delete(portfolioMedia)
        .where(and(eq(portfolioMedia.id, input.mediaId), eq(portfolioMedia.postId, input.postId)))
        .returning();
      if (row === undefined) {
        return { kind: 'not_found' } as const;
      }
      await tx
        .update(portfolioPosts)
        .set({ mediaCount: sql`${portfolioPosts.mediaCount} - 1` })
        .where(eq(portfolioPosts.id, input.postId));
      return { kind: 'removed', row } as const;
    });
  }

  /**
   * Edits a post. The caption on a draft or a published post; the tag on a
   * draft only, because a published post's tag is fixed (ADR-0045 § 3). A
   * removed post is the evidence of its removal and does not change.
   */
  async updatePost(input: {
    masterId: string;
    postId: string;
    caption?: string | null;
    serviceId?: string | null;
  }): Promise<PortfolioPostRow | 'not_found' | 'not_editable'> {
    const editableStatuses =
      input.serviceId === undefined ? (['draft', 'published'] as const) : (['draft'] as const);
    const [row] = await this.db
      .update(portfolioPosts)
      .set({
        ...(input.caption === undefined ? {} : { caption: input.caption }),
        ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }),
      })
      .where(
        and(
          eq(portfolioPosts.id, input.postId),
          eq(portfolioPosts.masterId, input.masterId),
          inArray(portfolioPosts.status, [...editableStatuses]),
          isNull(portfolioPosts.removedAt),
        ),
      )
      .returning();
    if (row !== undefined) {
      return row;
    }
    const existing = await this.findOwnPost(input.masterId, input.postId);
    return existing === undefined ? 'not_found' : 'not_editable';
  }

  /**
   * Deletes a post: hidden at once, renditions left to the sweep (#311).
   * Idempotent — a post already deleted answers `deleted` again. A removed
   * post is refused: it is the evidence of its own removal (ADR-0045 § 6).
   */
  async deletePost(input: {
    masterId: string;
    postId: string;
    now: Date;
  }): Promise<DeletePostOutcome> {
    const [row] = await this.db
      .update(portfolioPosts)
      .set({ status: 'deleted', deletedAt: input.now })
      .where(
        and(
          eq(portfolioPosts.id, input.postId),
          eq(portfolioPosts.masterId, input.masterId),
          ne(portfolioPosts.status, 'deleted'),
          isNull(portfolioPosts.removedAt),
        ),
      )
      .returning({ id: portfolioPosts.id });
    if (row !== undefined) {
      return 'deleted';
    }
    const [existing] = await this.db
      .select({ status: portfolioPosts.status, removedAt: portfolioPosts.removedAt })
      .from(portfolioPosts)
      .where(and(eq(portfolioPosts.id, input.postId), eq(portfolioPosts.masterId, input.masterId)))
      .limit(1);
    if (existing === undefined) {
      return 'not_found';
    }
    return existing.status === 'deleted' ? 'deleted' : 'removed';
  }

  /**
   * Submits a draft.
   *
   * **The post limit is atomic because a per-master advisory lock is taken
   * first.** Every publish of one master's posts queues on it, so the count
   * it reads cannot change before its own update commits — the guarantee the
   * issue's conditional UPDATE gives, without a counter column that deletes,
   * failures and removals would each have to keep right. The count
   * is `processing` and `published` posts not removed, from
   * `portfolio_posts_master_created_idx`.
   *
   * A post whose photos are all `ready` already publishes here; otherwise it
   * goes to `processing` and the last photo's completion publishes it.
   */
  async publish(input: {
    masterId: string;
    postId: string;
    maxPosts: number;
    now: Date;
  }): Promise<PublishOutcome> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${publishLockKey(input.masterId)}, 0))`,
      );

      // Re-read under the lock: a suspension that committed after the
      // service's own check must still stop this publish.
      const [master] = await tx
        .select({ verificationStatus: masters.verificationStatus })
        .from(masters)
        .where(and(eq(masters.id, input.masterId), isNull(masters.deletedAt)))
        .limit(1);
      if (master?.verificationStatus !== 'active') {
        return {
          kind: 'master_not_active',
          verificationStatus: master?.verificationStatus ?? null,
        } as const;
      }

      const [post] = await tx
        .select()
        .from(portfolioPosts)
        .where(
          and(eq(portfolioPosts.id, input.postId), eq(portfolioPosts.masterId, input.masterId)),
        )
        .for('update')
        .limit(1);
      if (post === undefined || post.status === 'deleted') {
        return { kind: 'not_found' } as const;
      }
      if (post.status !== 'draft') {
        return { kind: 'not_editable' } as const;
      }

      const items = await tx
        .select({ status: portfolioMedia.status })
        .from(portfolioMedia)
        .where(eq(portfolioMedia.postId, post.id));
      const ready = items.every((item) => item.status === 'ready');
      const publishable =
        items.length > 0 &&
        items.every((item) => item.status !== 'awaiting_upload' && item.status !== 'failed');
      if (!publishable) {
        return { kind: 'not_ready' } as const;
      }

      const [counted] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(portfolioPosts)
        .where(
          and(
            eq(portfolioPosts.masterId, input.masterId),
            inArray(portfolioPosts.status, [...COUNTED_POST_STATUSES]),
            isNull(portfolioPosts.removedAt),
          ),
        );
      if ((counted?.count ?? 0) >= input.maxPosts) {
        return { kind: 'limit_exceeded' } as const;
      }

      const [row] = await tx
        .update(portfolioPosts)
        .set(ready ? { status: 'published', publishedAt: input.now } : { status: 'processing' })
        .where(eq(portfolioPosts.id, post.id))
        .returning();
      if (row === undefined) {
        throw new Error('the locked post vanished inside its own transaction');
      }
      return { kind: ready ? 'published' : 'processing', row } as const;
    });
  }

  /** Ids of a post's photos that are uploaded and not yet finished: re-enqueued at publish. */
  async listUnfinishedMediaIds(postId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: portfolioMedia.id })
      .from(portfolioMedia)
      .where(
        and(
          eq(portfolioMedia.postId, postId),
          inArray(portfolioMedia.status, ['uploaded', 'processing']),
        ),
      );
    return rows.map((row) => row.id);
  }

  // --- The `media` worker's side (#305's MediaJobTarget) -----------------

  /**
   * Claims a photo for processing: `uploaded` → `processing`, or a retry of
   * one already `processing`. Nothing when the photo is gone, finished, or its
   * post deleted or already failed — publishing is all or nothing, so a
   * failed post's other photos would only make renditions for the sweep to
   * delete. The job then ends without touching storage.
   */
  async claimForProcessing(mediaId: string): Promise<ProcessableMedia | undefined> {
    const [row] = await this.db
      .update(portfolioMedia)
      .set({ status: 'processing' })
      .where(
        and(
          eq(portfolioMedia.id, mediaId),
          inArray(portfolioMedia.status, ['uploaded', 'processing']),
          sql`exists (
            select 1 from portfolio_posts p
             where p.id = ${portfolioMedia.postId} and p.status not in ('deleted', 'failed')
          )`,
        ),
      )
      .returning({
        rawStorageKey: portfolioMedia.rawStorageKey,
        thumbKey: portfolioMedia.thumbKey,
        displayKey: portfolioMedia.displayKey,
      });
    return row;
  }

  /** Records the rendition keys before any object is written under them (#307's rule). */
  async reserveKeys(
    mediaId: string,
    keys: { thumbKey: string; displayKey: string },
  ): Promise<void> {
    await this.db
      .update(portfolioMedia)
      .set(keys)
      .where(and(eq(portfolioMedia.id, mediaId), eq(portfolioMedia.status, 'processing')));
  }

  /**
   * A photo's renditions are public: it becomes `ready`, and if it was the
   * last unfinished photo of a `processing` post, the post publishes — one
   * transaction, so a post is never published with a photo still missing.
   *
   * **Races a delete.** The post row is locked first, so a delete either
   * commits before this reads it — and the renditions are `discarded`, for the
   * worker to delete — or waits until this commits, and the sweep (#311)
   * deletes the renditions of the post it then deletes. Either way no live
   * post points at a deleted object, and no deleted post keeps one.
   */
  async completeMedia(
    mediaId: string,
    renditions: ReadyRenditions,
    now: Date,
  ): Promise<'accepted' | 'discarded'> {
    return this.db.transaction(async (tx) => {
      const [media] = await tx
        .select({ postId: portfolioMedia.postId })
        .from(portfolioMedia)
        .where(eq(portfolioMedia.id, mediaId))
        .limit(1);
      if (media === undefined) {
        return 'discarded';
      }

      const [post] = await tx
        .select({ id: portfolioPosts.id, status: portfolioPosts.status })
        .from(portfolioPosts)
        .where(eq(portfolioPosts.id, media.postId))
        .for('update')
        .limit(1);
      if (post === undefined || post.status === 'deleted') {
        return 'discarded';
      }

      const [ready] = await tx
        .update(portfolioMedia)
        .set({ status: 'ready', ...renditions })
        .where(and(eq(portfolioMedia.id, mediaId), eq(portfolioMedia.status, 'processing')))
        .returning({ id: portfolioMedia.id });
      if (ready === undefined) {
        // A second run of the same job — a stalled job redelivered while the
        // first still ran — writes over the same reserved keys and finds the
        // photo already `ready` with them. Those objects are the photo's now:
        // `discarded` would have the worker delete what a published post shows.
        const [current] = await tx
          .select({
            status: portfolioMedia.status,
            thumbKey: portfolioMedia.thumbKey,
            displayKey: portfolioMedia.displayKey,
          })
          .from(portfolioMedia)
          .where(eq(portfolioMedia.id, mediaId))
          .limit(1);
        const sameRenditions =
          current?.status === 'ready' &&
          current.thumbKey === renditions.thumbKey &&
          current.displayKey === renditions.displayKey;
        return sameRenditions ? 'accepted' : 'discarded';
      }

      if (post.status === 'processing') {
        const [unfinished] = await tx
          .select({ id: portfolioMedia.id })
          .from(portfolioMedia)
          .where(and(eq(portfolioMedia.postId, post.id), ne(portfolioMedia.status, 'ready')))
          .limit(1);
        if (unfinished === undefined) {
          await tx
            .update(portfolioPosts)
            .set({ status: 'published', publishedAt: now })
            .where(and(eq(portfolioPosts.id, post.id), eq(portfolioPosts.status, 'processing')));
        }
      }
      return 'accepted';
    });
  }

  /**
   * A photo will never be processed. It becomes `failed` with its code, and a
   * `processing` post fails with it: publishing is all or nothing. A draft's
   * failed photo stays in the draft, for the master to remove.
   */
  async failMedia(mediaId: string, failureCode: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [media] = await tx
        .select({ postId: portfolioMedia.postId })
        .from(portfolioMedia)
        .where(eq(portfolioMedia.id, mediaId))
        .limit(1);
      if (media === undefined) {
        return;
      }
      const [post] = await tx
        .select({ id: portfolioPosts.id, status: portfolioPosts.status })
        .from(portfolioPosts)
        .where(eq(portfolioPosts.id, media.postId))
        .for('update')
        .limit(1);
      if (post === undefined) {
        return;
      }

      const [failed] = await tx
        .update(portfolioMedia)
        .set({ status: 'failed', failureCode })
        .where(
          and(
            eq(portfolioMedia.id, mediaId),
            inArray(portfolioMedia.status, ['uploaded', 'processing']),
          ),
        )
        .returning({ id: portfolioMedia.id });
      if (failed !== undefined && post.status === 'processing') {
        await tx
          .update(portfolioPosts)
          .set({ status: 'failed' })
          .where(and(eq(portfolioPosts.id, post.id), eq(portfolioPosts.status, 'processing')));
      }
    });
  }

  // --- Deletion and sweeps (#311) ----------------------------------------

  /**
   * What a deleted post still holds in storage: every rendition key its
   * photos ever reserved (ready, processing or failed) and every raw upload
   * key. `undefined` unless the post is `deleted` — the deletion job touches
   * nothing else.
   */
  async findDeletedPostObjects(
    postId: string,
  ): Promise<{ publicKeys: string[]; rawKeys: string[] } | undefined> {
    const [post] = await this.db
      .select({ status: portfolioPosts.status })
      .from(portfolioPosts)
      .where(eq(portfolioPosts.id, postId))
      .limit(1);
    if (post?.status !== 'deleted') {
      return undefined;
    }
    const media = await this.db
      .select({
        thumbKey: portfolioMedia.thumbKey,
        displayKey: portfolioMedia.displayKey,
        rawStorageKey: portfolioMedia.rawStorageKey,
      })
      .from(portfolioMedia)
      .where(eq(portfolioMedia.postId, postId));
    return {
      publicKeys: media
        .flatMap((item) => [item.thumbKey, item.displayKey])
        .filter((key): key is string => key !== null),
      rawKeys: media.map((item) => item.rawStorageKey),
    };
  }

  /**
   * The rows go last, and only a `deleted` post's: its photos follow by
   * cascade. **Not while a photo is being worked on** — uploaded or processing
   * and touched since `busySince`. A job that claimed it may still reserve keys
   * and write objects; its row keeps them findable, and the sweep finishes the
   * post once the job is done or dead.
   */
  async hardDeleteDeletedPost(postId: string, busySince: Date): Promise<boolean> {
    const rows = await this.db
      .delete(portfolioPosts)
      .where(
        and(
          eq(portfolioPosts.id, postId),
          eq(portfolioPosts.status, 'deleted'),
          sql`not exists (
            select 1 from portfolio_media m
             where m.post_id = ${portfolioPosts.id}
               and m.status in ('uploaded', 'processing')
               and m.updated_at > ${busySince}
          )`,
        ),
      )
      .returning({ id: portfolioPosts.id });
    return rows.length > 0;
  }

  /**
   * Deleted posts whose deletion job has not finished by `before` — it
   * exhausted its attempts, or was never enqueued. Oldest first, from
   * `portfolio_posts_sweep_idx`.
   */
  async listDeletedPosts(before: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: portfolioPosts.id })
      .from(portfolioPosts)
      .where(and(eq(portfolioPosts.status, 'deleted'), lt(portfolioPosts.updatedAt, before)))
      .orderBy(asc(portfolioPosts.updatedAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * Drafts untouched since `before`, and failed posts that failed before it,
   * become `deleted` — up to `limit` of them, from `portfolio_posts_sweep_idx`.
   *
   * The status, age and removal predicates are on the UPDATE itself, not only
   * in its subquery: under READ COMMITTED a row locked by a concurrent publish
   * is re-checked against the outer WHERE alone once the lock is released, so
   * a draft published in that moment must fail it there. A suspended master's
   * drafts are kept — suspension keeps everything (ADR-0045 § 6), and the
   * master cannot touch them until reinstated.
   */
  async markAbandonedPostsDeleted(before: Date, limit: number, now: Date): Promise<string[]> {
    const abandoned = and(
      inArray(portfolioPosts.status, ['draft', 'failed']),
      lt(portfolioPosts.updatedAt, before),
      isNull(portfolioPosts.removedAt),
      sql`not exists (
        select 1 from masters m
         where m.id = ${portfolioPosts.masterId} and m.verification_status = 'suspended'
      )`,
    );
    const rows = await this.db
      .update(portfolioPosts)
      .set({ status: 'deleted', deletedAt: now })
      .where(
        and(
          abandoned,
          inArray(
            portfolioPosts.id,
            this.db
              .select({ id: portfolioPosts.id })
              .from(portfolioPosts)
              .where(abandoned)
              .orderBy(asc(portfolioPosts.updatedAt))
              .limit(limit),
          ),
        ),
      )
      .returning({ id: portfolioPosts.id });
    return rows.map((row) => row.id);
  }

  /** A deleted account's posts, hidden when it was deleted (`MastersRepository.softDeleteByUserId`). */
  async listDeletedPostsOfMaster(masterId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: portfolioPosts.id })
      .from(portfolioPosts)
      .where(and(eq(portfolioPosts.masterId, masterId), eq(portfolioPosts.status, 'deleted')));
    return rows.map((row) => row.id);
  }

  /** Photos presigned and never uploaded, whose URL expired before `before`. */
  async listAbandonedUploads(
    before: Date,
    limit: number,
  ): Promise<{ id: string; postId: string; rawStorageKey: string }[]> {
    return this.db
      .select({
        id: portfolioMedia.id,
        postId: portfolioMedia.postId,
        rawStorageKey: portfolioMedia.rawStorageKey,
      })
      .from(portfolioMedia)
      .where(
        and(
          eq(portfolioMedia.status, 'awaiting_upload'),
          lt(portfolioMedia.presignExpiresAt, before),
        ),
      )
      .orderBy(asc(portfolioMedia.presignExpiresAt))
      .limit(limit);
  }

  /**
   * Removes one abandoned upload and frees its place in the post. `false`
   * when it was confirmed or removed meanwhile — then nothing changes.
   */
  async removeAbandonedUpload(mediaId: string, postId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: portfolioPosts.id })
        .from(portfolioPosts)
        .where(eq(portfolioPosts.id, postId))
        .for('update');
      const removed = await tx
        .delete(portfolioMedia)
        .where(and(eq(portfolioMedia.id, mediaId), eq(portfolioMedia.status, 'awaiting_upload')))
        .returning({ id: portfolioMedia.id });
      if (removed.length === 0) {
        return false;
      }
      await tx
        .update(portfolioPosts)
        .set({ mediaCount: sql`${portfolioPosts.mediaCount} - 1` })
        .where(eq(portfolioPosts.id, postId));
      return true;
    });
  }

  /**
   * Photos uploaded or processing since before `before`, in a post that is
   * `processing`: their job was lost, and the post waits on them. A draft's
   * photo is left alone — publishing enqueues it again.
   */
  async listStuckMedia(before: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: portfolioMedia.id })
      .from(portfolioMedia)
      .where(
        and(
          inArray(portfolioMedia.status, ['uploaded', 'processing']),
          lt(portfolioMedia.updatedAt, before),
          sql`exists (
            select 1 from portfolio_posts p
             where p.id = ${portfolioMedia.postId} and p.status = 'processing'
          )`,
        ),
      )
      .orderBy(asc(portfolioMedia.updatedAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }
}
