import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { CDN_PURGER } from '../../infra/cdn/cdn-purger.types';
import type { CdnPurger } from '../../infra/cdn/cdn-purger.types';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { MediaWorkService } from '../../infra/queue/media-work.service';
import { PermanentJobError } from '../../infra/queue/queue.types';
import type { DeferredJobPayload } from '../../infra/queue/queue.types';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import { MasterAvatarService } from '../masters/master-avatar.service';
import { MASTER_ACCOUNT_DELETED_JOB } from '../masters/masters.service';
import { PortfolioModerationService } from './portfolio-moderation.service';
import { PortfolioRepository } from './portfolio.repository';

/** The job that deletes one deleted post's objects and rows. */
export const DELETE_PORTFOLIO_POST_JOB = 'delete-portfolio-post';

/** A deleted post's job gets this long to finish before the sweep takes it over. */
const DELETION_JOB_GRACE_MS = 15 * 60_000;

/** One sweep run's ceiling per step: `MAINTENANCE_BATCH_SIZE` rows, this many times. */
const MAX_BATCHES_PER_STEP = 10;

const postPayloadSchema = z.object({ postId: z.uuid() });
const accountPayloadSchema = z.object({ masterId: z.uuid(), deletedAt: z.iso.datetime() });

export interface PortfolioSweepCounts {
  readonly abandonedUploads: number;
  readonly abandonedPosts: number;
  readonly deletedPosts: number;
  readonly evidenceMoved: number;
  readonly evidencePurged: number;
  /** Evidence moves and purges that failed this run (#362): alert on it. */
  readonly evidenceFailed: number;
  readonly stuckMedia: number;
  readonly avatarRenditions: number;
  readonly abandonedAvatarUploads: number;
  readonly stuckAvatarUploads: number;
}

/**
 * Everything the portfolio leaves behind leaves storage and the CDN (#311,
 * ADR-0045 § 6).
 *
 * **A deleted post** is cleaned up by a job on the `media` queue, enqueued by
 * the `DELETE` itself: every rendition its photos reserved is deleted from the
 * public bucket and purged from the CDN, every raw upload deleted from the
 * private one, and only then do the rows go. **Objects first, rows last:** a
 * storage or CDN failure throws, the rows stay, and the job — or after its
 * attempts, the sweep — tries again. Rows first would orphan an object nothing
 * points at.
 *
 * **The sweep** (`maintenance-portfolio`, on the retention schedule) is the
 * backstop for everything a job can miss, each step bounded per run:
 *
 * - photos and avatars presigned and never uploaded, with their raw objects;
 * - drafts untouched, and failed posts, past their window — deleted whole;
 * - deleted posts whose job did not finish, including renditions a
 *   completion wrote after losing its race with `DELETE` (#308);
 * - photos stuck in `uploaded`/`processing` in a `processing` post, and
 *   avatar uploads stuck likewise, failed;
 * - avatar renditions that are no longer the avatar.
 *
 * **Never touched:** a published post that is not deleted, a removed post (an
 * admin's evidence, #312), and the current avatar. Suspension keeps
 * everything: the profile stops being served (#310), and reinstating brings
 * it back.
 *
 * Logs carry a post id and counts — never a key or a URL, whose random part
 * is the only thing that keeps a rendition unlisted.
 */
@Injectable()
export class PortfolioCleanupService implements OnModuleInit {
  private readonly logger = new Logger(PortfolioCleanupService.name);
  private failures = 0;

  constructor(
    private readonly portfolio: PortfolioRepository,
    private readonly avatars: MasterAvatarService,
    private readonly moderation: PortfolioModerationService,
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly work: MediaWorkService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(CDN_PURGER) private readonly cdn: CdnPurger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.handlers.register(DELETE_PORTFOLIO_POST_JOB, (payload) => this.runPostDeletion(payload));
    this.handlers.register(MASTER_ACCOUNT_DELETED_JOB, (payload) =>
      this.runAccountDeletion(payload),
    );
  }

  /** Best effort: a lost job is the sweep's. */
  async enqueuePostDeletion(postId: string): Promise<void> {
    try {
      await this.work.enqueue(
        DELETE_PORTFOLIO_POST_JOB,
        { postId },
        `portfolio-post-delete-${postId}`,
      );
    } catch (error) {
      this.logger.warn(
        `Could not enqueue the deletion of portfolio post ${postId}; the sweep will: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Deletes a deleted post's objects, purges their URLs, then its rows.
   * Idempotent: a post already gone, or not deleted, is left alone.
   */
  async deletePost(postId: string): Promise<boolean> {
    const objects = await this.portfolio.findDeletedPostObjects(postId);
    if (objects === undefined) {
      return false;
    }
    if (objects.publicKeys.length > 0) {
      await this.storage.deletePublic(objects.publicKeys);
      await this.cdn.purgeUrls(objects.publicKeys.map((key) => this.storage.publicUrl(key)));
    }
    for (const key of objects.rawKeys) {
      await this.storage.delete(key);
    }
    const deleted = await this.portfolio.hardDeleteDeletedPost(
      postId,
      new Date(Date.now() - DELETION_JOB_GRACE_MS),
    );
    if (deleted) {
      this.logger.log(
        `Portfolio post ${postId}: deleted ${String(objects.publicKeys.length)} renditions and ${String(
          objects.rawKeys.length,
        )} raw uploads`,
      );
    }
    return deleted;
  }

  /**
   * A deleted account's portfolio (ADR-0045 § 6). Its posts were hidden when
   * the account was deleted, in the same transaction; this deletes their
   * objects and rows, and every avatar rendition the account had.
   */
  async deleteAccountPortfolio(masterId: string, deletedAt: Date): Promise<number> {
    const postIds = await this.portfolio.listDeletedPostsOfMaster(masterId);
    for (const postId of postIds) {
      await this.deletePost(postId);
    }
    await this.avatars.deleteAllRenditionsOf(masterId, deletedAt);
    return postIds.length;
  }

  /** The `maintenance-portfolio` job. */
  async sweep(): Promise<PortfolioSweepCounts> {
    const { batchSize } = this.config.maintenance;
    const { uploadAbandonedAfterHours, draftAbandonedAfterHours, processingStuckAfterHours } =
      this.config.portfolio;
    const now = Date.now();
    const uploadCutoff = new Date(now - uploadAbandonedAfterHours * 3_600_000);
    const draftCutoff = new Date(now - draftAbandonedAfterHours * 3_600_000);
    const stuckCutoff = new Date(now - processingStuckAfterHours * 3_600_000);
    const jobGraceCutoff = new Date(now - DELETION_JOB_GRACE_MS);

    const counts: PortfolioSweepCounts = {
      abandonedUploads: await this.inBatches(batchSize, (limit) =>
        this.sweepAbandonedUploads(uploadCutoff, limit),
      ),
      stuckMedia: await this.inBatches(batchSize, async (limit) => {
        const ids = await this.portfolio.listStuckMedia(stuckCutoff, limit);
        for (const mediaId of ids) {
          await this.isolated('stuck photo', mediaId, () =>
            this.portfolio.failMedia(mediaId, 'processing_failed'),
          );
        }
        return ids.length;
      }),
      abandonedPosts: await this.inBatches(batchSize, async (limit) => {
        const ids = await this.portfolio.markAbandonedPostsDeleted(draftCutoff, limit, new Date());
        for (const postId of ids) {
          await this.isolated('abandoned post', postId, () => this.deletePost(postId));
        }
        return ids.length;
      }),
      // A deleted post whose job did not finish — including every post of a
      // deleted account, hidden at deletion, whose account job was lost.
      deletedPosts: await this.inBatches(batchSize, async (limit) => {
        const ids = await this.portfolio.listDeletedPosts(jobGraceCutoff, limit);
        for (const postId of ids) {
          await this.isolated('deleted post', postId, () => this.deletePost(postId));
        }
        return ids.length;
      }),
      // A removed post's evidence (#312, ADR-0045 § 6): a move that failed at
      // removal is retried, and evidence past its retention is deleted,
      // moved or not (#362).
      ...(await this.moderation
        .sweepEvidence(batchSize, (postId, error) => {
          this.failures += 1;
          this.logger.warn(
            `Portfolio sweep: evidence of post ${postId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .then(({ moved, purged, failed }) => ({
          evidenceMoved: moved,
          evidencePurged: purged,
          evidenceFailed: failed,
        }))),
      avatarRenditions: await this.inBatches(batchSize, (limit) =>
        this.avatars.sweepStaleRenditions(jobGraceCutoff, limit),
      ),
      abandonedAvatarUploads: await this.inBatches(batchSize, (limit) =>
        this.avatars.sweepAbandonedUploads(uploadCutoff, limit),
      ),
      stuckAvatarUploads: await this.inBatches(batchSize, (limit) =>
        this.avatars.sweepStuckUploads(stuckCutoff, limit),
      ),
    };

    if (this.failures > 0) {
      this.logger.warn(
        `Portfolio sweep: ${String(this.failures)} item(s) failed and wait for the next run`,
      );
      this.failures = 0;
    }
    // Its own line, to alert on (#362): evidence that cannot move or be
    // purged is evidence kept past what ADR-0045 § 6 promises, or a removed
    // photo still public.
    if (counts.evidenceFailed > 0) {
      this.logger.warn(
        `Portfolio sweep: evidenceFailed ${String(counts.evidenceFailed)} — removed posts whose evidence could not be moved or purged`,
      );
    }
    if (Object.values(counts).some((count) => count > 0)) {
      this.logger.log(
        `Portfolio sweep: ${Object.entries(counts)
          .map(([step, count]) => `${step} ${String(count)}`)
          .join(', ')}`,
      );
    }
    return counts;
  }

  private async runPostDeletion(raw: DeferredJobPayload): Promise<void> {
    const parsed = postPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PermanentJobError('The portfolio post deletion payload is malformed');
    }
    await this.deletePost(parsed.data.postId);
  }

  private async runAccountDeletion(raw: DeferredJobPayload): Promise<void> {
    const parsed = accountPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PermanentJobError('The account deletion payload is malformed');
    }
    await this.deleteAccountPortfolio(parsed.data.masterId, new Date(parsed.data.deletedAt));
  }

  /**
   * One item's failure is that item's: it is logged by id and left for the
   * next run, and the sweep carries on. Without this, one post the CDN
   * refuses would sit at the head of its step and stop every step after it,
   * every run.
   */
  private async isolated(what: string, id: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.failures += 1;
      this.logger.warn(
        `Portfolio sweep: ${what} ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Abandoned photo uploads: the raw object first, then the row and its slot. */
  private async sweepAbandonedUploads(before: Date, limit: number): Promise<number> {
    const uploads = await this.portfolio.listAbandonedUploads(before, limit);
    for (const upload of uploads) {
      await this.isolated('abandoned upload', upload.id, async () => {
        await this.storage.delete(upload.rawStorageKey);
        await this.portfolio.removeAbandonedUpload(upload.id, upload.postId);
      });
    }
    return uploads.length;
  }

  /**
   * Runs one step in batches until a batch comes back short, at most
   * {@link MAX_BATCHES_PER_STEP} times — the rest waits for the next run.
   */
  private async inBatches(
    batchSize: number,
    step: (limit: number) => Promise<number>,
  ): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_STEP; batch += 1) {
      const done = await step(batchSize);
      total += done;
      if (done < batchSize) {
        break;
      }
    }
    return total;
  }
}
