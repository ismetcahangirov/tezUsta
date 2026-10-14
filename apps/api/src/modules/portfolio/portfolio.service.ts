import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CursorPage,
  OwnPortfolioMedia,
  OwnPortfolioPost,
  OwnPortfolioPostStatus,
  PortfolioMediaFailureCode,
  PortfolioMediaUpload,
} from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { LocalizedText } from '../../common/i18n/localized-text.types';
import { resolveLocalizedText } from '../../common/i18n/resolve-localized-text';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { CDN_PURGER } from '../../infra/cdn/cdn-purger.types';
import type { CdnPurger } from '../../infra/cdn/cdn-purger.types';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { PortfolioMediaRow, PortfolioPostRow } from '../../infra/database/schema/portfolio';
import { MediaPipelineService } from '../../infra/media/media-pipeline.service';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import type { Actor } from '../auth/auth.types';
import { MastersService } from '../masters/masters.service';
import {
  PortfolioMasterNotActiveError,
  PortfolioMediaAlreadyConfirmedError,
  verifyUploadedImage,
} from '../masters/uploaded-image';
import { decodePortfolioCursor, encodePortfolioCursor } from './portfolio-cursor';
import {
  PortfolioMediaLimitExceededError,
  PortfolioMediaPositionTakenError,
  PortfolioPostLimitExceededError,
  PortfolioPostNotEditableError,
  PortfolioPostNotReadyError,
  PortfolioServiceNotOfferedError,
} from './portfolio.errors';
import { PortfolioRepository } from './portfolio.repository';
import type {
  CreatePortfolioPostRequest,
  ListPortfolioPostsQuery,
  PresignPortfolioMediaRequest,
  UpdatePortfolioPostRequest,
} from './portfolio.schema';

/** The purpose the `media` queue knows a portfolio photo by (#305). */
export const PORTFOLIO_PHOTO_PURPOSE = 'portfolio-photo';

/** Where a raw portfolio upload waits in the private bucket; the lifecycle rule expires it (#304). */
const RAW_UPLOAD_PREFIX = 'portfolio-incoming';

/**
 * The master's own portfolio (#308, ADR-0045 § 3–4): create a post, presign,
 * upload and confirm its photos, publish it, edit its caption, delete it, and
 * list one's own posts in every state.
 *
 * **Who may write is read from the database on every write**: the caller's
 * master profile, not deleted, with `verification_status = 'active'`. A
 * suspended account never gets this far — `ActorService` answers 401 for it —
 * and a master an admin has suspended still reads their own posts but changes
 * nothing (`PORTFOLIO_MASTER_NOT_ACTIVE`, 403).
 *
 * **A post id is resolved inside the caller's own posts**, so another
 * master's post answers 404, exactly as a post that does not exist does
 * (`requireVisibleOrNotFound`'s convention).
 *
 * **Photos follow ADR-0024's upload** — presign a PUT to the private bucket,
 * confirm against the stored object — and then the `media` queue (#305) makes
 * the public renditions. A post publishes when its last photo is ready, or
 * fails with the first photo that cannot be processed: all or nothing.
 */
@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    private readonly portfolio: PortfolioRepository,
    private readonly masters: MastersService,
    private readonly pipeline: MediaPipelineService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(CDN_PURGER) private readonly cdn: CdnPurger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createPost(
    actor: Actor,
    input: CreatePortfolioPostRequest,
    languages: readonly string[],
  ): Promise<OwnPortfolioPost> {
    const masterId = await this.requireWriter(actor);
    const caption = this.checkCaption(input.caption ?? null);
    const serviceId = input.serviceId ?? null;
    if (serviceId !== null) {
      await this.requireOfferedService(masterId, serviceId);
    }

    const row = await this.portfolio.createPost({ masterId, caption, serviceId });
    const [post] = await this.presentMany([row], languages);
    if (post === undefined) {
      throw new Error('a created post could not be presented');
    }
    return post;
  }

  async presignMedia(
    actor: Actor,
    postId: string,
    input: PresignPortfolioMediaRequest,
  ): Promise<PortfolioMediaUpload> {
    const masterId = await this.requireWriter(actor);
    const { maxItemsPerPost, imageMaxBytes } = this.config.portfolio;
    if (input.position >= maxItemsPerPost) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        `A photo's position is 0 to ${String(maxItemsPerPost - 1)}.`,
        422,
        { maxItems: maxItemsPerPost },
      );
    }

    const { presignTtlSeconds } = this.config.storage;
    // Server-generated and opaque. The URL is signed for this master alone,
    // and the key never reaches a public URL: renditions get keys of their own.
    const rawStorageKey = `${RAW_UPLOAD_PREFIX}/${uuidV7()}`;
    const presignExpiresAt = new Date(Date.now() + presignTtlSeconds * 1000);

    // The row first: a presigned URL with no row behind it could never be
    // confirmed, and its object would wait for the lifecycle rule.
    const outcome = await this.portfolio.addPendingMedia({
      masterId,
      postId,
      position: input.position,
      declaredContentType: input.contentType,
      rawStorageKey,
      presignExpiresAt,
      maxItems: maxItemsPerPost,
    });
    switch (outcome.kind) {
      case 'not_found':
        throw new NotFoundError();
      case 'not_editable':
        throw new PortfolioPostNotEditableError();
      case 'limit_exceeded':
        throw new PortfolioMediaLimitExceededError(maxItemsPerPost);
      case 'position_taken':
        throw new PortfolioMediaPositionTakenError();
      case 'created':
        break;
    }

    const presigned = await this.storage.presignUpload({
      key: rawStorageKey,
      contentType: input.contentType,
      ttlSeconds: presignTtlSeconds,
      maxBytes: imageMaxBytes,
    });
    return {
      mediaId: outcome.row.id,
      uploadUrl: presigned.url,
      expiresAt: presigned.expiresAt.toISOString(),
      contentType: input.contentType,
      maxBytes: imageMaxBytes,
    };
  }

  /**
   * Confirms that a photo's bytes arrived, and checks them: the stored size
   * against `PORTFOLIO_IMAGE_MAX_BYTES`, then the leading bytes against the
   * type the URL was signed for — `OrderPhotosService#confirmUpload`'s order
   * and reasoning. A refused object is deleted and the row stays
   * `awaiting_upload`, so the same URL can be retried. A passed one is
   * `uploaded` and goes to the `media` queue.
   */
  async confirmMedia(actor: Actor, postId: string, mediaId: string): Promise<OwnPortfolioMedia> {
    const masterId = await this.requireWriter(actor);
    const found = await this.portfolio.findOwnMedia(masterId, postId, mediaId);
    if (found === undefined) {
      throw new NotFoundError();
    }
    const { post, media } = found;
    if (post.status !== 'draft') {
      throw new PortfolioPostNotEditableError();
    }
    if (media.status !== 'awaiting_upload') {
      throw new PortfolioMediaAlreadyConfirmedError();
    }

    const verified = await verifyUploadedImage({
      storage: this.storage,
      key: media.rawStorageKey,
      declaredContentType: media.declaredContentType,
      maxBytes: this.config.portfolio.imageMaxBytes,
      onRefused: (reason) => {
        this.logger.warn(`portfolio photo upload rejected (${reason}) for photo ${media.id}`);
      },
    });

    const confirmed = await this.portfolio.confirmMedia({
      mediaId: media.id,
      sizeBytes: verified.sizeBytes,
      verifiedContentType: verified.contentType,
    });
    if (confirmed === undefined) {
      throw new PortfolioMediaAlreadyConfirmedError();
    }

    await this.enqueue(confirmed.id);
    return this.presentMedia(confirmed);
  }

  /**
   * Submits a draft. `PORTFOLIO_MAX_POSTS` is enforced inside the publishing
   * transaction (`PortfolioRepository#publish`). Photos still uploaded or
   * processing are enqueued again: their jobs are idempotent and keyed by the
   * photo, so this only revives a job that was lost.
   */
  async publish(
    actor: Actor,
    postId: string,
    languages: readonly string[],
  ): Promise<OwnPortfolioPost> {
    const masterId = await this.requireWriter(actor);
    const { maxPosts } = this.config.portfolio;
    const outcome = await this.portfolio.publish({ masterId, postId, maxPosts, now: new Date() });
    switch (outcome.kind) {
      case 'not_found':
        throw new NotFoundError();
      case 'not_editable':
        throw new PortfolioPostNotEditableError();
      case 'not_ready':
        throw new PortfolioPostNotReadyError();
      case 'limit_exceeded':
        throw new PortfolioPostLimitExceededError(maxPosts);
      case 'master_not_active':
        throw new PortfolioMasterNotActiveError(outcome.verificationStatus);
      case 'processing':
        for (const mediaId of await this.portfolio.listUnfinishedMediaIds(outcome.row.id)) {
          await this.enqueue(mediaId);
        }
        break;
      case 'published':
        break;
    }
    return this.readOwn(masterId, outcome.row.id, languages);
  }

  async updatePost(
    actor: Actor,
    postId: string,
    input: UpdatePortfolioPostRequest,
    languages: readonly string[],
  ): Promise<OwnPortfolioPost> {
    const masterId = await this.requireWriter(actor);
    const caption = input.caption === undefined ? undefined : this.checkCaption(input.caption);
    if (input.serviceId !== undefined && input.serviceId !== null) {
      await this.requireOfferedService(masterId, input.serviceId);
    }

    const result = await this.portfolio.updatePost({
      masterId,
      postId,
      ...(caption === undefined ? {} : { caption }),
      ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }),
    });
    if (result === 'not_found') {
      throw new NotFoundError();
    }
    if (result === 'not_editable') {
      throw new PortfolioPostNotEditableError();
    }
    return this.readOwn(masterId, result.id, languages);
  }

  /** Idempotent. The renditions are the sweep's (#311), which finds deleted posts by their index. */
  async deletePost(actor: Actor, postId: string): Promise<void> {
    const masterId = await this.requireWriter(actor);
    const outcome = await this.portfolio.deletePost({ masterId, postId, now: new Date() });
    if (outcome === 'not_found') {
      throw new NotFoundError();
    }
    if (outcome === 'removed') {
      throw new PortfolioPostNotEditableError();
    }
  }

  /**
   * Removes a photo from a draft. The row goes first, atomically with the
   * post's count; its objects follow, best effort. A rendition left behind by
   * a storage failure is the one cost — and a draft's renditions were never
   * shown to anyone but their master.
   */
  async deleteMedia(actor: Actor, postId: string, mediaId: string): Promise<void> {
    const masterId = await this.requireWriter(actor);
    const outcome = await this.portfolio.removeDraftMedia({ masterId, postId, mediaId });
    if (outcome.kind === 'not_found') {
      throw new NotFoundError();
    }
    if (outcome.kind === 'not_editable') {
      throw new PortfolioPostNotEditableError();
    }
    await this.cleanUpMediaObjects(outcome.row);
  }

  async listOwn(
    actor: Actor,
    query: ListPortfolioPostsQuery,
    languages: readonly string[],
  ): Promise<CursorPage<OwnPortfolioPost>> {
    const masterId = await this.requireReader(actor);
    const rows = await this.portfolio.listOwnPosts({
      masterId,
      afterPostId: decodePortfolioCursor(query.cursor),
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const items = await this.presentMany(page, languages);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodePortfolioCursor(last.id) : null,
    };
  }

  async getOwn(
    actor: Actor,
    postId: string,
    languages: readonly string[],
  ): Promise<OwnPortfolioPost> {
    const masterId = await this.requireReader(actor);
    return this.readOwn(masterId, postId, languages);
  }

  private async readOwn(
    masterId: string,
    postId: string,
    languages: readonly string[],
  ): Promise<OwnPortfolioPost> {
    const row = await this.portfolio.findOwnPost(masterId, postId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    const [post] = await this.presentMany([row], languages);
    if (post === undefined) {
      throw new NotFoundError();
    }
    return post;
  }

  /**
   * Hands a photo to the `media` queue, best effort. The row has already
   * committed, so failing the request here would turn a Redis blip into a
   * 500 the client cannot retry — its retry would meet `uploaded` or
   * `processing` and a 409. A photo whose enqueue was lost is enqueued again
   * when its post is published, which is the point the editor waits on.
   */
  private async enqueue(mediaId: string): Promise<void> {
    try {
      await this.pipeline.enqueue(PORTFOLIO_PHOTO_PURPOSE, mediaId);
    } catch (error) {
      this.logger.warn(
        `Could not enqueue portfolio photo ${mediaId}; publish enqueues it again: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** A caller who may change a portfolio: an active master, read now. */
  private async requireWriter(actor: Actor): Promise<string> {
    const master = await this.masters.findOwnStatus(actor);
    if (master === undefined) {
      throw new PortfolioMasterNotActiveError(null);
    }
    if (master.verificationStatus !== 'active') {
      throw new PortfolioMasterNotActiveError(master.verificationStatus);
    }
    return master.id;
  }

  /** A caller who may read their own portfolio: any master with a profile. */
  private async requireReader(actor: Actor): Promise<string> {
    const master = await this.masters.findOwnStatus(actor);
    if (master === undefined) {
      throw new NotFoundError();
    }
    return master.id;
  }

  private async requireOfferedService(masterId: string, serviceId: string): Promise<void> {
    if (!(await this.masters.offersActiveService(masterId, serviceId))) {
      throw new PortfolioServiceNotOfferedError();
    }
  }

  /** `PORTFOLIO_CAPTION_MAX_CHARS`, which the schema cannot know. */
  private checkCaption(caption: string | null): string | null {
    const max = this.config.portfolio.captionMaxChars;
    // Code points, as the column's `char_length` counts them, not UTF-16
    // units: an emoji is one character to the master and to Postgres.
    if (caption !== null && [...caption].length > max) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        `A caption is at most ${String(max)} characters.`,
        422,
        { maxChars: max },
      );
    }
    return caption;
  }

  private async cleanUpMediaObjects(media: PortfolioMediaRow): Promise<void> {
    const keys = [media.thumbKey, media.displayKey].filter((key): key is string => key !== null);
    try {
      await this.storage.delete(media.rawStorageKey);
      if (keys.length > 0) {
        await this.storage.deletePublic(keys);
        await this.cdn.purgeUrls(keys.map((key) => this.storage.publicUrl(key)));
      }
    } catch (error) {
      this.logger.warn(
        `Could not remove the objects of deleted portfolio photo ${media.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async presentMany(
    rows: readonly PortfolioPostRow[],
    languages: readonly string[],
  ): Promise<OwnPortfolioPost[]> {
    const [media, names] = await Promise.all([
      this.portfolio.listMediaForPosts(rows.map((row) => row.id)),
      this.portfolio.findServiceNames(
        rows.map((row) => row.serviceId).filter((id): id is string => id !== null),
      ),
    ]);
    const byPost = new Map<string, PortfolioMediaRow[]>();
    for (const item of media) {
      const list = byPost.get(item.postId) ?? [];
      list.push(item);
      byPost.set(item.postId, list);
    }
    return rows.map((row) => this.present(row, byPost.get(row.id) ?? [], languages, names));
  }

  private present(
    row: PortfolioPostRow,
    media: readonly PortfolioMediaRow[],
    languages: readonly string[],
    names: ReadonlyMap<string, LocalizedText> = new Map(),
  ): OwnPortfolioPost {
    const serviceName = row.serviceId === null ? undefined : names.get(row.serviceId);
    const firstFailure = media.find((item) => item.status === 'failed');
    return {
      id: row.id,
      // `deleted` never reaches here: every read filters it out.
      status: row.status as OwnPortfolioPostStatus,
      caption: row.caption,
      service:
        row.serviceId === null || serviceName === undefined
          ? null
          : { serviceId: row.serviceId, name: resolveLocalizedText(serviceName, languages) },
      media: media.map((item) => this.presentMedia(item)),
      failureCode:
        row.status === 'failed'
          ? ((firstFailure?.failureCode ?? 'processing_failed') as PortfolioMediaFailureCode)
          : null,
      removedAt: row.removedAt === null ? null : row.removedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    };
  }

  /** Public URLs only once `ready`; the keys themselves never leave the server (ADR-0045 § 5). */
  private presentMedia(item: PortfolioMediaRow): OwnPortfolioMedia {
    const ready = item.status === 'ready' && item.thumbKey !== null && item.displayKey !== null;
    return {
      id: item.id,
      position: item.position,
      status: item.status,
      failureCode: item.failureCode as PortfolioMediaFailureCode | null,
      thumbUrl: ready && item.thumbKey !== null ? this.storage.publicUrl(item.thumbKey) : null,
      displayUrl:
        ready && item.displayKey !== null ? this.storage.publicUrl(item.displayKey) : null,
      width: ready ? item.width : null,
      height: ready ? item.height : null,
    };
  }
}
