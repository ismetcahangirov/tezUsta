import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type {
  MasterAvatarPresign,
  MasterAvatarUpload,
  PortfolioMediaFailureCode,
} from '@tezusta/types';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { CDN_PURGER } from '../../infra/cdn/cdn-purger.types';
import type { CdnPurger } from '../../infra/cdn/cdn-purger.types';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { MediaJobTargetRegistry } from '../../infra/media/media-job-target';
import type {
  MediaJobSource,
  MediaJobTarget,
  StoredRendition,
} from '../../infra/media/media-job-target';
import { MediaPipelineService } from '../../infra/media/media-pipeline.service';
import { AVATAR_RENDITIONS } from '../../infra/media/media-processor.types';
import type { MediaFailureCode } from '../../infra/media/media-processor.types';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { MediaWorkService } from '../../infra/queue/media-work.service';
import { PermanentJobError } from '../../infra/queue/queue.types';
import type { DeferredJobPayload } from '../../infra/queue/queue.types';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import type { Actor } from '../auth/auth.types';
import { MasterAvatarRepository } from './master-avatar.repository';
import type { AvatarKeys, MasterAvatarUploadRow } from './master-avatar.repository';
import type { PresignAvatarRequest } from './master-avatar.schema';
import { MastersService } from './masters.service';
import {
  PortfolioMasterNotActiveError,
  PortfolioMediaAlreadyConfirmedError,
  verifyUploadedImage,
} from './uploaded-image';

/** The purpose the `media` queue knows an avatar upload by (#305). */
export const AVATAR_PURPOSE = 'master-avatar';

/** The job that deletes an avatar's old renditions and purges them from the CDN. */
export const DELETE_AVATAR_RENDITIONS_JOB = 'delete-avatar-renditions';

const RAW_UPLOAD_PREFIX = 'avatar-incoming';

const cleanupPayloadSchema = z.object({ uploadId: z.uuid() });

/** Why an upload's renditions are to go. */
export type CleanupReason = 'replaced' | 'removed' | 'discarded' | 'failed';

/** The cleanup job's id: one per upload and reason (see `enqueueCleanup`). */
export function avatarCleanupJobId(uploadId: string, reason: CleanupReason): string {
  return `avatar-cleanup-${uploadId}-${reason}`;
}

/** One avatar upload at a time: another is uploaded or processing. */
export class AvatarUploadInProgressError extends AppError {
  constructor() {
    super(
      ERROR_CODES.AVATAR_UPLOAD_IN_PROGRESS,
      'Your previous photo is still being processed. Try again in a moment.',
      409,
    );
    this.name = 'AvatarUploadInProgressError';
    Object.setPrototypeOf(this, AvatarUploadInProgressError.prototype);
  }
}

/**
 * A master's avatar (#309, ADR-0045 § 8): presign, confirm, and remove; the
 * `media` queue makes the 128 and 512 px squares.
 *
 * **The avatar changes only when the new one is ready.** A new upload is
 * processed beside the old avatar, and the two keys on `masters` swap in one
 * update when its renditions are written — so the profile never falls back to
 * initials in between. The old renditions are then deleted and purged by a
 * job of their own; the #311 sweep is the backstop for a job that is lost.
 *
 * Only an active master sets or removes an avatar, the portfolio's rule.
 * Where the avatar is shown is not this service's question: the surfaces a
 * customer sees decide when a master's identity is visible.
 */
@Injectable()
export class MasterAvatarService implements MediaJobTarget, OnModuleInit {
  private readonly logger = new Logger(MasterAvatarService.name);

  constructor(
    private readonly avatars: MasterAvatarRepository,
    private readonly masters: MastersService,
    private readonly pipeline: MediaPipelineService,
    private readonly work: MediaWorkService,
    private readonly targets: MediaJobTargetRegistry,
    private readonly handlers: DeferredJobHandlerRegistry,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(CDN_PURGER) private readonly cdn: CdnPurger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.targets.register(AVATAR_PURPOSE, this);
    this.handlers.register(DELETE_AVATAR_RENDITIONS_JOB, (payload) =>
      this.deleteRenditions(payload),
    );
  }

  /**
   * A presigned upload. A previous presign never uploaded is replaced; one
   * already uploaded or processing is not — it finishes first.
   */
  async presign(actor: Actor, input: PresignAvatarRequest): Promise<MasterAvatarPresign> {
    const masterId = await this.requireWriter(actor);

    const inFlight = await this.avatars.findInFlight(masterId);
    if (inFlight !== undefined) {
      if (inFlight.status !== 'awaiting_upload') {
        throw new AvatarUploadInProgressError();
      }
      if (await this.avatars.deleteAbandoned(inFlight.id)) {
        await this.storage.delete(inFlight.rawStorageKey);
      }
    }

    const { presignTtlSeconds } = this.config.storage;
    const maxBytes = this.config.portfolio.imageMaxBytes;
    const rawStorageKey = `${RAW_UPLOAD_PREFIX}/${uuidV7()}`;
    const row = await this.avatars.createPending({
      masterId,
      rawStorageKey,
      declaredContentType: input.contentType,
      presignExpiresAt: new Date(Date.now() + presignTtlSeconds * 1000),
    });
    if (row === 'in_flight') {
      throw new AvatarUploadInProgressError();
    }

    const presigned = await this.storage.presignUpload({
      key: rawStorageKey,
      contentType: input.contentType,
      ttlSeconds: presignTtlSeconds,
      maxBytes,
    });
    return {
      uploadId: row.id,
      uploadUrl: presigned.url,
      expiresAt: presigned.expiresAt.toISOString(),
      contentType: input.contentType,
      maxBytes,
    };
  }

  /** The portfolio's confirm (`verifyUploadedImage`), then the `media` queue. */
  async confirm(actor: Actor, uploadId: string): Promise<MasterAvatarUpload> {
    const masterId = await this.requireWriter(actor);
    const upload = await this.avatars.findOwnUpload(masterId, uploadId);
    if (upload === undefined) {
      throw new NotFoundError();
    }
    if (upload.status !== 'awaiting_upload') {
      throw new PortfolioMediaAlreadyConfirmedError();
    }

    const verified = await verifyUploadedImage({
      storage: this.storage,
      key: upload.rawStorageKey,
      declaredContentType: upload.declaredContentType,
      maxBytes: this.config.portfolio.imageMaxBytes,
      onRefused: (reason) => {
        this.logger.warn(`avatar upload rejected (${reason}) for upload ${upload.id}`);
      },
    });

    const confirmed = await this.avatars.confirm({
      uploadId: upload.id,
      sizeBytes: verified.sizeBytes,
      verifiedContentType: verified.contentType,
    });
    if (confirmed === undefined) {
      throw new PortfolioMediaAlreadyConfirmedError();
    }
    try {
      await this.pipeline.enqueue(AVATAR_PURPOSE, confirmed.id);
    } catch (error) {
      // The row is committed; a 500 here could not be retried (a second
      // confirm meets `uploaded`). A lost job is #311's stuck-upload sweep.
      this.logger.warn(
        `Could not enqueue avatar upload ${confirmed.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return toUploadResponse(confirmed);
  }

  /** An upload's progress, for the app to wait on. Readable by its master whatever their status. */
  async getUpload(actor: Actor, uploadId: string): Promise<MasterAvatarUpload> {
    const master = await this.masters.findOwnStatus(actor);
    if (master === undefined) {
      throw new NotFoundError();
    }
    const upload = await this.avatars.findOwnUpload(master.id, uploadId);
    if (upload === undefined) {
      throw new NotFoundError();
    }
    return toUploadResponse(upload);
  }

  /** Removes the avatar, and any upload still in flight. Idempotent. */
  async remove(actor: Actor): Promise<void> {
    const masterId = await this.requireWriter(actor);
    for (const cancelled of await this.avatars.cancelInFlight(masterId)) {
      await this.storage.delete(cancelled.rawStorageKey).catch(() => undefined);
    }
    const previous = await this.avatars.removeAvatar(masterId);
    if (previous !== undefined) {
      await this.enqueueCleanup(previous, 'removed');
    }
  }

  // --- MediaJobTarget ----------------------------------------------------

  async load(itemId: string): Promise<MediaJobSource | undefined> {
    const upload = await this.avatars.claimForProcessing(itemId);
    if (upload === undefined) {
      return undefined;
    }
    return {
      rawKey: upload.rawStorageKey,
      maxBytes: this.config.portfolio.imageMaxBytes,
      keyPrefix: 'avatars',
      renditions: AVATAR_RENDITIONS,
      ...(upload.thumbKey !== null && upload.displayKey !== null
        ? { reservedKeys: { thumb: upload.thumbKey, display: upload.displayKey } }
        : {}),
    };
  }

  async reserveKeys(itemId: string, keys: Readonly<Record<string, string>>): Promise<void> {
    await this.avatars.reserveKeys(itemId, toAvatarKeys(keys));
  }

  async complete(
    itemId: string,
    renditions: readonly StoredRendition[],
  ): Promise<'accepted' | 'discarded'> {
    const keys = toAvatarKeys(
      Object.fromEntries(renditions.map((rendition) => [rendition.name, rendition.key])),
    );
    const outcome = await this.avatars.complete(itemId, keys);
    if (outcome.kind === 'discarded') {
      // The worker deletes the objects; this records that they are gone.
      await this.enqueueCleanup(itemId, 'discarded');
      return 'discarded';
    }
    if (outcome.previousUploadId !== undefined) {
      await this.enqueueCleanup(outcome.previousUploadId, 'replaced');
    }
    return 'accepted';
  }

  async fail(itemId: string, code: MediaFailureCode): Promise<void> {
    if (await this.avatars.fail(itemId, code)) {
      await this.enqueueCleanup(itemId, 'failed');
    }
  }

  // --- Cleanup ---------------------------------------------------------

  /**
   * Deletes one upload's renditions and purges their URLs, unless they are
   * the avatar now or already gone. Idempotent, so a retried job or the #311
   * sweep can run it again.
   */
  async deleteRenditions(raw: DeferredJobPayload): Promise<void> {
    const parsed = cleanupPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PermanentJobError('The avatar cleanup payload is malformed');
    }
    const { uploadId } = parsed.data;
    const keys = await this.avatars.findRenditionsToDelete(uploadId);
    if (keys === undefined) {
      return;
    }
    const all = [keys.thumbKey, keys.displayKey];
    await this.storage.deletePublic(all);
    await this.cdn.purgeUrls(all.map((key) => this.storage.publicUrl(key)));
    await this.avatars.markRenditionsDeleted(uploadId, new Date());
  }

  // --- Sweeps (#311), called by the portfolio sweep ---------------------

  /**
   * Deletes the renditions of uploads that are no longer the avatar. Returns
   * how many were deleted. A storage failure stops the run; the rest wait for
   * the next one.
   */
  async sweepStaleRenditions(before: Date, limit: number): Promise<number> {
    const ids = await this.avatars.listStaleRenditions(before, limit);
    for (const uploadId of ids) {
      await this.deleteRenditions({ uploadId }).catch((error: unknown) => {
        this.logger.warn(
          `Avatar sweep: upload ${uploadId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return ids.length;
  }

  /** Removes uploads presigned and never uploaded: the raw object first, then the row. */
  async sweepAbandonedUploads(before: Date, limit: number): Promise<number> {
    let removed = 0;
    for (const upload of await this.avatars.listAbandoned(before, limit)) {
      await this.storage.delete(upload.rawStorageKey);
      if (await this.avatars.deleteAbandoned(upload.id)) {
        removed += 1;
      }
    }
    return removed;
  }

  /** Fails uploads whose job was lost, so the app stops waiting on them. */
  async sweepStuckUploads(before: Date, limit: number): Promise<number> {
    const ids = await this.avatars.listStuck(before, limit);
    for (const uploadId of ids) {
      await this.fail(uploadId, 'processing_failed');
    }
    return ids.length;
  }

  /** A deleted account's every finished rendition, at once (ADR-0045 § 6). */
  async deleteAllRenditionsOf(masterId: string, deletedAt: Date): Promise<void> {
    for (const uploadId of await this.avatars.listLiveRenditionsOfMaster(masterId, deletedAt)) {
      await this.deleteRenditions({ uploadId });
    }
  }

  /**
   * Best effort: the #311 sweep finds any upload whose renditions are still
   * live. The job id carries the reason as well as the upload, because BullMQ
   * keeps finished jobs and ignores an `add` under an id it still holds: a
   * cleanup that found nothing to do — the upload was still the avatar —
   * must not swallow the one enqueued when it is replaced.
   */
  private async enqueueCleanup(uploadId: string, reason: CleanupReason): Promise<void> {
    try {
      await this.work.enqueue(
        DELETE_AVATAR_RENDITIONS_JOB,
        { uploadId },
        avatarCleanupJobId(uploadId, reason),
      );
    } catch (error) {
      this.logger.warn(
        `Could not enqueue the cleanup of avatar upload ${uploadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

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
}

function toAvatarKeys(keys: Readonly<Record<string, string>>): AvatarKeys {
  const thumbKey = keys.thumb;
  const displayKey = keys.display;
  if (thumbKey === undefined || displayKey === undefined) {
    throw new Error('An avatar needs both its thumb and display renditions');
  }
  return { thumbKey, displayKey };
}

function toUploadResponse(row: MasterAvatarUploadRow): MasterAvatarUpload {
  return {
    uploadId: row.id,
    status: row.status,
    failureCode: row.failureCode as PortfolioMediaFailureCode | 'cancelled' | null,
  };
}
