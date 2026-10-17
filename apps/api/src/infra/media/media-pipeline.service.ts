import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { DeferredJobHandlerRegistry } from '../queue/deferred-job-handler.registry';
import { MediaWorkService } from '../queue/media-work.service';
import { PermanentJobError } from '../queue/queue.types';
import type { DeferredJobContext, DeferredJobPayload } from '../queue/queue.types';
import {
  ObjectTooLargeError,
  PUBLIC_MEDIA_CACHE_CONTROL,
  STORAGE_PROVIDER,
} from '../storage/storage.types';
import type { StorageProvider } from '../storage/storage.types';
import { MediaJobTargetRegistry } from './media-job-target';
import type { MediaJobSource, MediaJobTarget, StoredRendition } from './media-job-target';
import { MEDIA_PROCESSOR, MediaProcessingError } from './media-processor.types';
import type { MediaFailureCode, MediaProcessor } from './media-processor.types';

/** The one job name on the `media` queue. */
export const PROCESS_MEDIA_JOB = 'process-media';

/** A run with no queue around it: its first attempt is its last. */
const SINGLE_ATTEMPT: DeferredJobContext = { attempt: 1, maxAttempts: 1 };

/** DI token for the directory temp files go under; the OS temp dir unless a test overrides it. */
export const MEDIA_TEMP_ROOT = Symbol('MEDIA_TEMP_ROOT');

/**
 * A job carries the purpose and the item's id, nothing else. Parsed, because
 * a payload has been through Redis and is no more trusted than a request body.
 */
const mediaJobPayloadSchema = z.object({
  purpose: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  itemId: z.uuid(),
});

/**
 * The media job, from raw upload to renditions (ADR-0045 § 5): public ones
 * for the portfolio and the avatar, private ones for order and conversation
 * photos, which are re-encoded only to lose their metadata (#318).
 *
 * 1. Ask the owner what to process (`load`). Nothing → the job is done.
 * 2. Download the raw object from the private bucket into a temp directory of
 *    its own, under the owner's byte cap.
 * 3. Render it.
 * 4. Reserve the rendition keys on the item, then write each rendition under
 *    them, to the bucket the owner named.
 * 5. Hand the renditions to the owner (`complete`).
 * 6. Delete the raw object: it is five to twenty times the size of the
 *    renditions, and it carries GPS.
 * 7. Remove the temp directory, whatever happened.
 *
 * **Failures.** An image that cannot be processed fails at once: the owner
 * is told (`fail`), the raw object is deleted, and the job ends without a
 * retry. Anything else — storage down, disk full — is retried up to
 * `QUEUE_JOB_ATTEMPTS`, writing over the same reserved keys; the last attempt
 * tells the owner `processing_failed` rather than leaving the item
 * `processing` for ever.
 *
 * **Temp files.** The raw photo sits in the worker's temp directory while it
 * is processed, GPS and all. A worker killed mid-job leaves it there, so the
 * worker's temp storage must be ephemeral: a container's own filesystem, not
 * a volume that outlives it.
 */
@Injectable()
export class MediaPipelineService implements OnModuleInit {
  private readonly logger = new Logger(MediaPipelineService.name);
  private readonly tempRoot: string;

  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(MEDIA_PROCESSOR) private readonly processor: MediaProcessor,
    private readonly targets: MediaJobTargetRegistry,
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly work: MediaWorkService,
    @Optional() @Inject(MEDIA_TEMP_ROOT) tempRoot?: string,
  ) {
    this.tempRoot = tempRoot ?? tmpdir();
  }

  onModuleInit(): void {
    this.handlers.register(PROCESS_MEDIA_JOB, (payload, context) => this.run(payload, context));
  }

  /**
   * Enqueues one upload. The job id is `<purpose>-<itemId>`, so a confirm that
   * runs twice enqueues once — and has no `:`, which BullMQ refuses.
   */
  async enqueue(purpose: string, itemId: string): Promise<void> {
    const payload = mediaJobPayloadSchema.parse({ purpose, itemId });
    await this.work.enqueue(PROCESS_MEDIA_JOB, payload, `${purpose}-${itemId}`);
  }

  /** The job body. Public so that a test can run it without a queue. */
  async run(raw: DeferredJobPayload, context: DeferredJobContext = SINGLE_ATTEMPT): Promise<void> {
    const parsed = mediaJobPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PermanentJobError('The media job payload is malformed');
    }
    const { purpose, itemId } = parsed.data;

    const target = this.targets.resolve(purpose);
    if (target === undefined) {
      // A deploy in which the job outlived the code that owned it, as
      // `UnknownDeferredJobError` describes. Retrying cannot register it.
      throw new PermanentJobError(`No media job target is registered for "${purpose}"`);
    }

    const source = await target.load(itemId);
    if (source === undefined) {
      return;
    }

    let workDir: string | undefined;
    // The keys exist from the moment they are reserved; only renditions
    // written before `complete` was called are this run's to discard.
    let reserved: readonly string[] = [];
    let completeCalled = false;
    try {
      workDir = await mkdtemp(path.join(this.tempRoot, 'tezusta-media-'));
      const rawPath = path.join(workDir, 'raw');
      const downloaded = await this.storage.download({
        key: source.rawKey,
        toPath: rawPath,
        maxBytes: source.maxBytes,
      });
      if (downloaded === undefined) {
        throw new MediaProcessingError('missing');
      }

      const rendered = await this.processor.renderImage({
        inputPath: rawPath,
        outputDir: workDir,
        renditions: source.renditions,
      });

      const keys = await this.keysFor(target, itemId, source);
      const destination = source.destination ?? 'public';
      reserved = Object.values(keys);
      const stored: StoredRendition[] = [];
      for (const rendition of rendered) {
        const key = keys[rendition.name];
        if (key === undefined) {
          throw new Error(`No key was reserved for the "${rendition.name}" rendition`);
        }
        if (destination === 'private') {
          await this.storage.putPrivate({
            key,
            filePath: rendition.filePath,
            contentType: 'image/webp',
          });
        } else {
          await this.storage.putPublic({
            key,
            filePath: rendition.filePath,
            contentType: 'image/webp',
            cacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
          });
        }
        stored.push({
          name: rendition.name,
          key,
          width: rendition.width,
          height: rendition.height,
          bytes: rendition.bytes,
        });
      }

      completeCalled = true;
      const outcome = await target.complete(itemId, stored);
      if (outcome === 'discarded') {
        await this.discard(reserved, destination);
      }
      await this.deleteRaw(source.rawKey);
    } catch (error) {
      await this.handleFailure(error, {
        target,
        itemId,
        rawKey: source.rawKey,
        context,
        // Once `complete` has been called it may have committed, even if it
        // then threw, and a ready item may now point at these keys. They are
        // left alone: the item records them, and the sweep (#311) owns them.
        discardable: completeCalled ? [] : reserved,
        destination: source.destination ?? 'public',
      });
    } finally {
      if (workDir !== undefined) {
        await rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch(
          (error: unknown) => {
            this.logger.warn(
              `Could not remove a media temp directory: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          },
        );
      }
    }
  }

  /**
   * The rendition keys for this upload, recorded on the item **before** any
   * object is written under them, as the #307 schema expects.
   *
   * A retry reuses the keys an earlier attempt reserved, so it overwrites the
   * same objects rather than minting new ones. A worker killed between a
   * write and `complete` therefore leaves nothing the item does not name, and
   * the sweep (#311) can delete it from the row.
   *
   * New keys get one random segment per upload, shared by its renditions: a
   * URL names neither the master nor the post (ADR-0045 § 5).
   */
  private async keysFor(
    target: MediaJobTarget,
    itemId: string,
    source: MediaJobSource,
  ): Promise<Readonly<Record<string, string>>> {
    const existing = source.reservedKeys;
    if (existing !== undefined && source.renditions.every((spec) => spec.name in existing)) {
      return existing;
    }
    const token = randomBytes(16).toString('hex');
    const keys = Object.fromEntries(
      source.renditions.map((spec) => [
        spec.name,
        `${source.keyPrefix}/${token}/${spec.name}.webp`,
      ]),
    );
    await target.reserveKeys(itemId, keys);
    return keys;
  }

  /**
   * Decides whether a failure is the end. Rethrows in every case: BullMQ has
   * to see the job fail, retried or not.
   *
   * Before the end, renditions stay where they are: the retry overwrites the
   * same reserved keys. At the end — the image's fault, or the last attempt —
   * they are deleted, best effort; the item names them either way.
   */
  private async handleFailure(error: unknown, failure: FailureContext): Promise<never> {
    const code = failureCodeOf(error);
    const permanent = code !== undefined;
    const lastAttempt = failure.context.attempt >= failure.context.maxAttempts;

    if (!permanent && !lastAttempt) {
      throw error;
    }

    await this.discard(failure.discardable, failure.destination);
    await failure.target.fail(failure.itemId, code ?? 'processing_failed');
    // The raw upload will never be processed now, and it carries GPS.
    await this.deleteRaw(failure.rawKey);
    throw permanent ? new PermanentJobError(`Media processing failed: ${code}`) : error;
  }

  /**
   * Best effort. The renditions are already public and the owner has been
   * told, so failing the job here would only re-run work that succeeded. A
   * raw object left behind is caught by the private bucket's one-day
   * lifecycle rule (`docs/engineering/public-media.md` § 2.4) and the sweeps.
   */
  private async deleteRaw(rawKey: string): Promise<void> {
    try {
      await this.storage.delete(rawKey);
    } catch (error) {
      this.logger.warn(
        `Could not delete a raw upload after processing; the lifecycle rule will: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Best effort, for the same reason, and because the original error is the one worth reporting. */
  private async discard(keys: readonly string[], destination: 'public' | 'private'): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    try {
      if (destination === 'private') {
        for (const key of keys) {
          await this.storage.delete(key);
        }
      } else {
        await this.storage.deletePublic(keys);
      }
    } catch (error) {
      this.logger.warn(
        `Could not delete ${String(keys.length)} rendition(s) of a failed media job: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

interface FailureContext {
  readonly target: MediaJobTarget;
  readonly itemId: string;
  readonly rawKey: string;
  readonly context: DeferredJobContext;
  readonly discardable: readonly string[];
  readonly destination: 'public' | 'private';
}

/** The stable code for a failure the image caused, or `undefined` for one it did not. */
function failureCodeOf(error: unknown): MediaFailureCode | undefined {
  if (error instanceof MediaProcessingError) {
    return error.code;
  }
  if (error instanceof ObjectTooLargeError) {
    return 'too_large';
  }
  return undefined;
}
