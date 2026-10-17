import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type {
  AdminPortfolioEvidence,
  AdminPortfolioMedia,
  AdminPortfolioPost,
  AdminPortfolioPostDetail,
  CursorPage,
} from '@tezusta/types';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { CDN_PURGER } from '../../infra/cdn/cdn-purger.types';
import type { CdnPurger } from '../../infra/cdn/cdn-purger.types';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { Transaction } from '../../infra/database/database.types';
import type { PortfolioMediaRow, PortfolioPostRow } from '../../infra/database/schema/portfolio';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { MediaWorkService } from '../../infra/queue/media-work.service';
import { PermanentJobError } from '../../infra/queue/queue.types';
import type { DeferredJobPayload } from '../../infra/queue/queue.types';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import { decodeAdminPortfolioCursor, encodeAdminPortfolioCursor } from './portfolio-cursor';
import { PortfolioModerationRepository } from './portfolio-moderation.repository';
import type { AdminPostRow, AdminPostStatusFilter } from './portfolio-moderation.repository';

/** Where a removed post's renditions are kept: the private bucket, under their own public key. */
const EVIDENCE_PREFIX = 'portfolio-evidence';

/** A rendition is a few hundred kilobytes; this refuses anything that is not one. */
const RENDITION_MAX_BYTES = 10 * 1024 * 1024;

/** The job, on the `media` queue, that moves one removed post's renditions. */
export const MOVE_PORTFOLIO_EVIDENCE_JOB = 'move-portfolio-evidence';

/** A removal's job gets this long to move the evidence before the sweep takes it over. */
const MOVE_JOB_GRACE_MS = 15 * 60_000;

const movePayloadSchema = z.object({ postId: z.uuid() });

export function evidenceMoveJobId(postId: string): string {
  return `portfolio-evidence-move-${postId}`;
}

export class PortfolioPostAlreadyRemovedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.PORTFOLIO_POST_ALREADY_REMOVED,
      'This post has already been removed. The first removal and its reason are the record.',
      409,
    );
    this.name = 'PortfolioPostAlreadyRemovedError';
    Object.setPrototypeOf(this, PortfolioPostAlreadyRemovedError.prototype);
  }
}

export class PortfolioPostNotRemovableError extends AppError {
  constructor(status: string) {
    super(
      ERROR_CODES.PORTFOLIO_POST_NOT_REMOVABLE,
      'Only a published post can be removed; nobody else can see this one.',
      409,
      { status },
    );
    this.name = 'PortfolioPostNotRemovableError';
    Object.setPrototypeOf(this, PortfolioPostNotRemovableError.prototype);
  }
}

/**
 * Portfolio moderation (#312, ADR-0045 § 6): a moderator finds and inspects
 * any post, and removes a published one with a mandatory reason.
 *
 * **A removal hides the post at once** — `removed_at` is set in the same
 * transaction as the audit row, and every reader filters on it — **and keeps
 * its photos as evidence**: the renditions are copied to the private bucket,
 * deleted from the public one and purged from the CDN, so nobody can reach
 * them by URL; a moderator reads them through short-lived presigned URLs. After
 * `PORTFOLIO_REMOVED_RETENTION_DAYS` the sweep deletes them. The row, with
 * its caption, reason and remover, is kept for good: the audit points at it.
 *
 * The move is a job on the `media` queue, enqueued once the removal commits —
 * it is a dozen object copies and a CDN call, not work for a request — and
 * the sweep takes over any move its job did not finish. Until it succeeds the
 * post is already hidden everywhere; only a URL somebody was handed before
 * keeps working, which ADR-0045 § 5 accepts.
 */
@Injectable()
export class PortfolioModerationService implements OnModuleInit {
  private readonly logger = new Logger(PortfolioModerationService.name);

  constructor(
    private readonly posts: PortfolioModerationRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(CDN_PURGER) private readonly cdn: CdnPurger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly work: MediaWorkService,
  ) {}

  onModuleInit(): void {
    this.handlers.register(MOVE_PORTFOLIO_EVIDENCE_JOB, (payload) => this.runMove(payload));
  }

  async list(query: {
    masterId?: string | undefined;
    status?: AdminPostStatusFilter | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<CursorPage<AdminPortfolioPost>> {
    const rows = await this.posts.list({
      masterId: query.masterId,
      status: query.status,
      from: query.from,
      to: query.to,
      after: decodeAdminPortfolioCursor(query.cursor),
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toAdminPost),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeAdminPortfolioCursor({ createdAt: last.createdAtExact, id: last.post.id })
          : null,
    };
  }

  async get(postId: string): Promise<AdminPortfolioPostDetail> {
    const row = await this.posts.find(postId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    const media = await this.posts.listMedia(postId);
    const source = photoSourceOf(row.post, this.retainedSince());
    return {
      ...toAdminPost(row),
      media: await Promise.all(media.map((item) => this.toAdminMedia(item, source))),
    };
  }

  /**
   * Removes a published post. `record` writes the audit row inside the
   * removal's transaction; the evidence move is enqueued after the commit.
   */
  async remove(input: {
    postId: string;
    adminId: string;
    reason: string;
    record: (tx: Transaction, before: PortfolioPostRow) => Promise<void>;
  }): Promise<AdminPortfolioPostDetail> {
    const outcome = await this.posts.remove({ ...input, now: new Date() });
    switch (outcome.kind) {
      case 'missing':
        throw new NotFoundError();
      case 'already_removed':
        throw new PortfolioPostAlreadyRemovedError();
      case 'not_published':
        throw new PortfolioPostNotRemovableError(outcome.status);
      case 'removed':
        break;
    }
    try {
      await this.work.enqueue(
        MOVE_PORTFOLIO_EVIDENCE_JOB,
        { postId: input.postId },
        evidenceMoveJobId(input.postId),
      );
    } catch (error) {
      this.logger.warn(
        `Could not enqueue the evidence move of removed post ${input.postId}; the sweep will: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return this.get(input.postId);
  }

  /**
   * Copies a removed post's renditions to the private bucket, deletes the
   * public ones and purges their URLs, then records the move. Idempotent: a
   * rendition already copied is copied again, one already gone is skipped.
   *
   * A post whose evidence is already purged is left alone. If the purge lands
   * while this runs, the private copies just written are deleted again, so
   * nothing is left in the private bucket that no row points at (#362).
   */
  async moveEvidence(postId: string): Promise<void> {
    if (await this.posts.isEvidencePurged(postId)) {
      return;
    }
    const keys = await this.posts.renditionKeys(postId);
    for (const key of keys) {
      await this.storage.copyPublicToPrivate({
        publicKey: key,
        privateKey: evidenceKey(key),
        maxBytes: RENDITION_MAX_BYTES,
      });
    }
    // Recorded before the public copies go, so a move that stops after this
    // is read from the private bucket (#369).
    await this.posts.markEvidenceCopied(postId, new Date());
    if (keys.length > 0) {
      await this.storage.deletePublic(keys);
      await this.cdn.purgeUrls(keys.map((key) => this.storage.publicUrl(key)));
    }
    if (
      !(await this.posts.markEvidenceMoved(postId, new Date())) &&
      (await this.posts.isEvidencePurged(postId))
    ) {
      await this.deletePrivateEvidence(keys);
    }
  }

  /**
   * Deletes a removed post's evidence once its retention has passed, wherever
   * it is (#362). A move that never finished may have left private copies,
   * public ones, or both, so an unmoved post's public copies are deleted and
   * purged too, before the private ones: a move running at the same time
   * then finds nothing left to copy.
   *
   * The post is marked purged only once all of it has succeeded, the CDN
   * purge included: a removed photo must not stay at the edge with nothing
   * left to retry it. Until then it is retried each run, behind the posts
   * not yet tried, as a failing move is.
   */
  async purgeEvidence(post: { id: string; moved: boolean }): Promise<void> {
    const keys = await this.posts.renditionKeys(post.id);
    if (!post.moved && keys.length > 0) {
      await this.storage.deletePublic(keys);
      await this.deletePrivateEvidence(keys);
      await this.cdn.purgeUrls(keys.map((key) => this.storage.publicUrl(key)));
    } else {
      await this.deletePrivateEvidence(keys);
    }
    await this.posts.markEvidencePurged(post.id, new Date());
  }

  /**
   * The sweep's two evidence steps; returns how many posts each finished, and
   * how many failed, for alerting (#362).
   *
   * Purging runs first, and the move takes only posts still within their
   * retention, so evidence past it is deleted rather than moved and then
   * deleted, and a post whose move never succeeds still goes on time. Each
   * post is recorded as tried before it runs, so one that fails goes to the
   * back of the next run's queue.
   */
  async sweepEvidence(
    limit: number,
    onFailure: (postId: string, error: unknown) => void,
  ): Promise<{
    moved: number;
    purged: number;
    failed: number;
  }> {
    let failed = 0;
    const attempt = async (postId: string, work: () => Promise<void>): Promise<boolean> => {
      try {
        await this.posts.markEvidenceAttempted(postId, new Date());
        await work();
        return true;
      } catch (error) {
        failed += 1;
        onFailure(postId, error);
        return false;
      }
    };
    const retainedSince = this.retainedSince();

    let purged = 0;
    for (const post of await this.posts.listEvidenceToPurge(retainedSince, limit)) {
      if (await attempt(post.id, () => this.purgeEvidence(post))) {
        purged += 1;
      }
    }

    let moved = 0;
    const toMove = await this.posts.listEvidenceToMove(
      retainedSince,
      new Date(Date.now() - MOVE_JOB_GRACE_MS),
      limit,
    );
    for (const postId of toMove) {
      if (await attempt(postId, () => this.moveEvidence(postId))) {
        moved += 1;
      }
    }
    return { moved, purged, failed };
  }

  /** Removals before this are past `PORTFOLIO_REMOVED_RETENTION_DAYS`. */
  private retainedSince(): Date {
    return new Date(Date.now() - this.config.portfolio.removedRetentionDays * 86_400_000);
  }

  private async deletePrivateEvidence(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await this.storage.delete(evidenceKey(key));
    }
  }

  private async runMove(raw: DeferredJobPayload): Promise<void> {
    const parsed = movePayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PermanentJobError('The evidence move payload is malformed');
    }
    // A throw is retried by the queue, then left for the sweep.
    await this.moveEvidence(parsed.data.postId);
  }

  /**
   * A live post's photos by their public URLs, kept evidence by presigned
   * URLs from the private bucket, and nothing once there is nothing to show.
   */
  private async toAdminMedia(
    item: PortfolioMediaRow,
    source: PhotoSource,
  ): Promise<AdminPortfolioMedia> {
    const base = {
      id: item.id,
      position: item.position,
      status: item.status,
      width: item.width,
      height: item.height,
    };
    if (item.thumbKey === null || item.displayKey === null || item.status !== 'ready') {
      return { ...base, thumbUrl: null, displayUrl: null };
    }
    switch (source) {
      case 'private': {
        const ttlSeconds = this.config.storage.downloadTtlSeconds;
        const [thumb, display] = await Promise.all([
          this.storage.presignDownload({ key: evidenceKey(item.thumbKey), ttlSeconds }),
          this.storage.presignDownload({ key: evidenceKey(item.displayKey), ttlSeconds }),
        ]);
        return { ...base, thumbUrl: thumb.url, displayUrl: display.url };
      }
      case 'none':
        return { ...base, thumbUrl: null, displayUrl: null };
      case 'public':
        return {
          ...base,
          thumbUrl: this.storage.publicUrl(item.thumbKey),
          displayUrl: this.storage.publicUrl(item.displayKey),
        };
    }
  }
}

/** Where a moderator reads a post's photos from. */
type PhotoSource = 'public' | 'private' | 'none';

/**
 * A live post's photos are public. A removed post's are wherever its move
 * got to (#369): public until the copy, private from then on, and gone once
 * purged — or once past retention, when the purge has deleted them or is
 * about to, even if its CDN purge has not succeeded yet.
 */
function photoSourceOf(post: PortfolioPostRow, retainedSince: Date): PhotoSource {
  if (post.removedAt === null) {
    return 'public';
  }
  if (post.evidencePurgedAt !== null) {
    return 'none';
  }
  if (post.evidenceMovedAt !== null) {
    return 'private';
  }
  if (post.removedAt < retainedSince) {
    return 'none';
  }
  return post.evidenceCopiedAt === null ? 'public' : 'private';
}

function evidenceKey(publicKey: string): string {
  return `${EVIDENCE_PREFIX}/${publicKey}`;
}

function evidenceOf(post: PortfolioPostRow): AdminPortfolioEvidence {
  if (post.removedAt === null) {
    return 'none';
  }
  if (post.evidencePurgedAt !== null) {
    return 'purged';
  }
  return post.evidenceMovedAt === null ? 'pending_move' : 'kept';
}

function toAdminPost(row: AdminPostRow): AdminPortfolioPost {
  const { post } = row;
  return {
    id: post.id,
    masterId: post.masterId,
    masterName: row.masterName,
    masterStatus: row.masterStatus,
    status: post.status,
    caption: post.caption,
    mediaCount: post.mediaCount,
    createdAt: post.createdAt.toISOString(),
    publishedAt: post.publishedAt === null ? null : post.publishedAt.toISOString(),
    removedAt: post.removedAt === null ? null : post.removedAt.toISOString(),
    removedByAdminId: post.removedByAdminId,
    removalReason: post.removalReason,
    evidence: evidenceOf(post),
  };
}
