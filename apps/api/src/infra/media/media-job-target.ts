import { Injectable } from '@nestjs/common';

import type { MediaFailureCode, RenditionSpec } from './media-processor.types';

/** What the pipeline needs to process one upload. */
export interface MediaJobSource {
  /** The raw upload, in the private bucket. */
  readonly rawKey: string;
  /** The byte cap the download enforces. */
  readonly maxBytes: number;
  /** The first segment of every rendition key: `portfolio` or `avatars` (ADR-0045 § 5). */
  readonly keyPrefix: string;
  readonly renditions: readonly RenditionSpec[];
  /**
   * The keys an earlier attempt reserved, by rendition name, if any. Handed
   * back so that a retry writes over the same objects instead of orphaning
   * them under new keys.
   */
  readonly reservedKeys?: Readonly<Record<string, string>>;
}

/** A rendition in the public bucket. Its key, never a URL: the URL is built when a response is. */
export interface StoredRendition {
  readonly name: string;
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/**
 * The owner of one kind of upload, as the pipeline sees it: a portfolio photo
 * (#308), an avatar (#309).
 *
 * The pipeline knows how to turn bytes into renditions and nothing about the
 * rows those bytes belong to. The owner knows the rows and nothing about
 * `sharp`. This interface is the whole conversation between them, and it is
 * keyed by an id — a job carries ids, never objects
 * (`backend-architecture.md` § Background jobs).
 *
 * Every method must be **idempotent**: a job can be retried after any of them
 * has run.
 */
export interface MediaJobTarget {
  /**
   * The upload to process, or `undefined` when there is nothing to do — the
   * item was deleted while it waited, or an earlier attempt already finished
   * it. `undefined` ends the job quietly, without touching storage.
   */
  load(itemId: string): Promise<MediaJobSource | undefined>;

  /**
   * Records the rendition keys, by name, **before** anything is written under
   * them — the #307 schema's rule that keys are written before their objects,
   * so a crash between the two still leaves a row the sweep (#311) can
   * delete from. `load` hands them back on a retry.
   */
  reserveKeys(itemId: string, keys: Readonly<Record<string, string>>): Promise<void>;

  /**
   * The renditions are public under these keys. `accepted` when the item took
   * them; `discarded` when it no longer wants them — deleted mid-processing —
   * in which case the pipeline deletes them again. No URL was ever handed out
   * for them, so there is nothing to purge.
   */
  complete(
    itemId: string,
    renditions: readonly StoredRendition[],
  ): Promise<'accepted' | 'discarded'>;

  /**
   * The upload will never be processed: the image is at fault, or every
   * attempt failed. The item must leave `processing` here, so that a client
   * polling it sees the failure rather than waiting for ever.
   */
  fail(itemId: string, code: MediaFailureCode): Promise<void>;
}

/**
 * Where the owners of each kind of upload register, by name, without
 * `infra/media` importing them — the shape of `DeferredJobHandlerRegistry`,
 * for its reason: `infra/` fans out into `modules/`, never back.
 */
@Injectable()
export class MediaJobTargetRegistry {
  private readonly targets = new Map<string, MediaJobTarget>();

  /** Registering a purpose twice is a programming error, not a merge. */
  register(purpose: string, target: MediaJobTarget): void {
    if (this.targets.has(purpose)) {
      throw new Error(`A media job target for "${purpose}" is already registered`);
    }
    this.targets.set(purpose, target);
  }

  resolve(purpose: string): MediaJobTarget | undefined {
    return this.targets.get(purpose);
  }
}
