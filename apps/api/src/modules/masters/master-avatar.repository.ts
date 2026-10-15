import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { isUniqueViolationOn } from '../../infra/database/database-error';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, Transaction } from '../../infra/database/database.types';
import { masters } from '../../infra/database/schema/masters';
import { masterAvatarUploads } from '../../infra/database/schema/portfolio';

export type MasterAvatarUploadRow = typeof masterAvatarUploads.$inferSelect;

const IN_FLIGHT = ['awaiting_upload', 'uploaded', 'processing'] as const;

export interface AvatarKeys {
  readonly thumbKey: string;
  readonly displayKey: string;
}

/**
 * The avatar's tables (#309, ADR-0045 § 8): `master_avatar_uploads`, one row
 * per upload, and the current avatar's two keys on `masters`.
 *
 * **The avatar changes in one UPDATE of `masters`**, both keys together, so
 * the profile goes from the old photo to the new one with nothing in between
 * — never to the initials fallback. The old upload keeps its keys until its
 * renditions are deleted (`renditions_deleted_at`), which is how the cleanup
 * job, and the #311 sweep behind it, find them.
 */
@Injectable()
export class MasterAvatarRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async findInFlight(masterId: string): Promise<MasterAvatarUploadRow | undefined> {
    const [row] = await this.db
      .select()
      .from(masterAvatarUploads)
      .where(
        and(
          eq(masterAvatarUploads.masterId, masterId),
          inArray(masterAvatarUploads.status, [...IN_FLIGHT]),
        ),
      )
      .limit(1);
    return row;
  }

  /** Drops a presign that was never uploaded. Nothing else is deleted from this table. */
  async deleteAbandoned(uploadId: string): Promise<boolean> {
    const rows = await this.db
      .delete(masterAvatarUploads)
      .where(
        and(
          eq(masterAvatarUploads.id, uploadId),
          eq(masterAvatarUploads.status, 'awaiting_upload'),
        ),
      )
      .returning({ id: masterAvatarUploads.id });
    return rows.length > 0;
  }

  /**
   * A new pending upload, or `in_flight` when another one got there first —
   * `master_avatar_uploads_in_flight_unique` decides, not a prior read.
   */
  async createPending(input: {
    masterId: string;
    rawStorageKey: string;
    declaredContentType: string;
    presignExpiresAt: Date;
  }): Promise<MasterAvatarUploadRow | 'in_flight'> {
    try {
      const [row] = await this.db
        .insert(masterAvatarUploads)
        .values({ id: uuidV7(), ...input })
        .returning();
      if (row === undefined) {
        throw new Error('insert into master_avatar_uploads returned no row');
      }
      return row;
    } catch (error) {
      if (isUniqueViolationOn(error, 'master_avatar_uploads_in_flight_unique')) {
        return 'in_flight';
      }
      throw error;
    }
  }

  async findOwnUpload(
    masterId: string,
    uploadId: string,
  ): Promise<MasterAvatarUploadRow | undefined> {
    const [row] = await this.db
      .select()
      .from(masterAvatarUploads)
      .where(and(eq(masterAvatarUploads.id, uploadId), eq(masterAvatarUploads.masterId, masterId)))
      .limit(1);
    return row;
  }

  async confirm(input: {
    uploadId: string;
    sizeBytes: number;
    verifiedContentType: string;
  }): Promise<MasterAvatarUploadRow | undefined> {
    const [row] = await this.db
      .update(masterAvatarUploads)
      .set({
        status: 'uploaded',
        rawSizeBytes: input.sizeBytes,
        verifiedContentType: input.verifiedContentType,
      })
      .where(
        and(
          eq(masterAvatarUploads.id, input.uploadId),
          eq(masterAvatarUploads.status, 'awaiting_upload'),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Ends every upload still in flight, as `failed` with `cancelled`: the
   * master removed their avatar, and a photo that finishes afterwards must not
   * put one back. Its job then finds nothing to claim, or has its renditions
   * discarded at completion.
   */
  async cancelInFlight(
    masterId: string,
    tx: Pick<Database, 'update'> = this.db,
  ): Promise<MasterAvatarUploadRow[]> {
    return tx
      .update(masterAvatarUploads)
      .set({ status: 'failed', failureCode: 'cancelled' })
      .where(
        and(
          eq(masterAvatarUploads.masterId, masterId),
          inArray(masterAvatarUploads.status, [...IN_FLIGHT]),
        ),
      )
      .returning();
  }

  /**
   * Clears the avatar. Returns the upload whose renditions it was, so they can
   * be deleted; `undefined` when there was no avatar — removal is idempotent.
   */
  async removeAvatar(masterId: string): Promise<string | undefined> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockAvatar(tx, masterId);
      if (current === undefined) {
        return undefined;
      }
      await this.clearAvatar(tx, masterId);
      return this.findUploadByThumbKey(tx, masterId, current);
    });
  }

  /**
   * An admin's removal (#312): uploads in flight are cancelled, the avatar
   * cleared and `record` — the audit — written, in one transaction, so no
   * completion can slip a photo back in between. `undefined` when there was
   * no avatar; otherwise the upload its renditions belong to, if one still
   * names them, and the cancelled uploads whose raw objects are to go.
   */
  async removeAvatarByAdmin(
    masterId: string,
    record: (tx: Transaction) => Promise<void>,
  ): Promise<{ uploadId: string | undefined; cancelled: MasterAvatarUploadRow[] } | undefined> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockAvatar(tx, masterId);
      if (current === undefined) {
        return undefined;
      }
      const cancelled = await this.cancelInFlight(masterId, tx);
      await this.clearAvatar(tx, masterId);
      await record(tx);
      return { uploadId: await this.findUploadByThumbKey(tx, masterId, current), cancelled };
    });
  }

  /** The current avatar's thumb key, with the master's row locked; `undefined` when there is none. */
  private async lockAvatar(tx: Transaction, masterId: string): Promise<string | undefined> {
    const [current] = await tx
      .select({ thumbKey: masters.avatarThumbKey })
      .from(masters)
      .where(eq(masters.id, masterId))
      .for('no key update')
      .limit(1);
    return current?.thumbKey ?? undefined;
  }

  private async clearAvatar(tx: Transaction, masterId: string): Promise<void> {
    await tx
      .update(masters)
      .set({ avatarThumbKey: null, avatarDisplayKey: null })
      .where(eq(masters.id, masterId));
  }

  // --- The `media` worker's side ----------------------------------------

  /** `uploaded` → `processing`, or a retry of one `processing`; nothing for a deleted master. */
  async claimForProcessing(
    uploadId: string,
  ): Promise<
    { rawStorageKey: string; thumbKey: string | null; displayKey: string | null } | undefined
  > {
    const [row] = await this.db
      .update(masterAvatarUploads)
      .set({ status: 'processing' })
      .where(
        and(
          eq(masterAvatarUploads.id, uploadId),
          inArray(masterAvatarUploads.status, ['uploaded', 'processing']),
        ),
      )
      .returning({
        rawStorageKey: masterAvatarUploads.rawStorageKey,
        thumbKey: masterAvatarUploads.thumbKey,
        displayKey: masterAvatarUploads.displayKey,
      });
    return row;
  }

  async reserveKeys(uploadId: string, keys: AvatarKeys): Promise<void> {
    await this.db
      .update(masterAvatarUploads)
      .set(keys)
      .where(
        and(eq(masterAvatarUploads.id, uploadId), eq(masterAvatarUploads.status, 'processing')),
      );
  }

  /**
   * The upload is ready, and becomes the avatar: both keys swap in one update
   * of `masters`. Returns the previous avatar's upload, whose renditions are
   * now to be deleted.
   *
   * `discarded` when the upload was cancelled meanwhile, or the master deleted
   * — unless a second run of the same job finds it already `ready` with these
   * very keys, which are the avatar's now and must not be deleted.
   */
  async complete(
    uploadId: string,
    keys: AvatarKeys,
  ): Promise<{ kind: 'accepted'; previousUploadId: string | undefined } | { kind: 'discarded' }> {
    return this.db.transaction(async (tx) => {
      const [ready] = await tx
        .update(masterAvatarUploads)
        .set({ status: 'ready', ...keys })
        .where(
          and(eq(masterAvatarUploads.id, uploadId), eq(masterAvatarUploads.status, 'processing')),
        )
        .returning({ masterId: masterAvatarUploads.masterId });

      if (ready === undefined) {
        const [current] = await tx
          .select()
          .from(masterAvatarUploads)
          .where(eq(masterAvatarUploads.id, uploadId))
          .limit(1);
        const same =
          current?.status === 'ready' &&
          current.thumbKey === keys.thumbKey &&
          current.displayKey === keys.displayKey;
        return same ? { kind: 'accepted', previousUploadId: undefined } : { kind: 'discarded' };
      }

      const [master] = await tx
        .select({ thumbKey: masters.avatarThumbKey })
        .from(masters)
        .where(and(eq(masters.id, ready.masterId), isNull(masters.deletedAt)))
        .for('no key update')
        .limit(1);
      if (master === undefined) {
        // A deleted master gets no avatar; the upload's renditions go.
        await tx
          .update(masterAvatarUploads)
          .set({ status: 'failed', failureCode: 'cancelled' })
          .where(eq(masterAvatarUploads.id, uploadId));
        return { kind: 'discarded' };
      }

      await tx
        .update(masters)
        .set({ avatarThumbKey: keys.thumbKey, avatarDisplayKey: keys.displayKey })
        .where(eq(masters.id, ready.masterId));

      const previousUploadId =
        master.thumbKey === null
          ? undefined
          : await this.findUploadByThumbKey(tx, ready.masterId, master.thumbKey, uploadId);
      return { kind: 'accepted', previousUploadId };
    });
  }

  /** Whether the upload was still in flight; a finished one is left as it is. */
  async fail(uploadId: string, failureCode: string): Promise<boolean> {
    const rows = await this.db
      .update(masterAvatarUploads)
      .set({ status: 'failed', failureCode })
      .where(
        and(
          eq(masterAvatarUploads.id, uploadId),
          inArray(masterAvatarUploads.status, ['uploaded', 'processing']),
        ),
      )
      .returning({ id: masterAvatarUploads.id });
    return rows.length > 0;
  }

  // --- Cleanup ---------------------------------------------------------

  /**
   * The keys of an upload's renditions, if they are still to be deleted: the
   * upload has keys, they are not deleted yet, and they are not the avatar
   * now. A replaced, removed, failed or cancelled upload qualifies; the
   * current avatar never does.
   */
  async findRenditionsToDelete(uploadId: string): Promise<AvatarKeys | undefined> {
    const [row] = await this.db
      .select({
        thumbKey: masterAvatarUploads.thumbKey,
        displayKey: masterAvatarUploads.displayKey,
        deletedAt: masterAvatarUploads.renditionsDeletedAt,
        currentThumbKey: masters.avatarThumbKey,
      })
      .from(masterAvatarUploads)
      .innerJoin(masters, eq(masters.id, masterAvatarUploads.masterId))
      .where(eq(masterAvatarUploads.id, uploadId))
      .limit(1);
    if (
      row === undefined ||
      row.thumbKey === null ||
      row.displayKey === null ||
      row.deletedAt !== null ||
      row.currentThumbKey === row.thumbKey
    ) {
      return undefined;
    }
    return { thumbKey: row.thumbKey, displayKey: row.displayKey };
  }

  async markRenditionsDeleted(uploadId: string, now: Date): Promise<void> {
    await this.db
      .update(masterAvatarUploads)
      .set({ renditionsDeletedAt: now })
      .where(
        and(eq(masterAvatarUploads.id, uploadId), isNull(masterAvatarUploads.renditionsDeletedAt)),
      );
  }

  private async findUploadByThumbKey(
    tx: Pick<Database, 'select'>,
    masterId: string,
    thumbKey: string,
    exceptUploadId?: string,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: masterAvatarUploads.id })
      .from(masterAvatarUploads)
      .where(
        and(
          eq(masterAvatarUploads.masterId, masterId),
          eq(masterAvatarUploads.thumbKey, thumbKey),
          exceptUploadId === undefined ? undefined : ne(masterAvatarUploads.id, exceptUploadId),
        ),
      )
      .limit(1);
    return row?.id;
  }

  // --- Sweeps (#311) -------------------------------------------------------

  /**
   * Uploads whose renditions are still in storage but are not the avatar any
   * more — replaced, removed, failed or cancelled — untouched since `before`.
   * From `master_avatar_uploads_renditions_live_idx`; the current avatar is
   * excluded in the query, so it never fills a batch the sweep cannot clear.
   */
  async listStaleRenditions(before: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: masterAvatarUploads.id })
      .from(masterAvatarUploads)
      .innerJoin(masters, eq(masters.id, masterAvatarUploads.masterId))
      .where(
        and(
          isNotNull(masterAvatarUploads.thumbKey),
          isNull(masterAvatarUploads.renditionsDeletedAt),
          lt(masterAvatarUploads.updatedAt, before),
          // An upload still in flight may yet become the avatar.
          inArray(masterAvatarUploads.status, ['ready', 'failed']),
          sql`${masters.avatarThumbKey} is distinct from ${masterAvatarUploads.thumbKey}`,
        ),
      )
      .orderBy(asc(masterAvatarUploads.updatedAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** Presigned and never uploaded, the URL expired before `before`. */
  async listAbandoned(
    before: Date,
    limit: number,
  ): Promise<{ id: string; rawStorageKey: string }[]> {
    return this.db
      .select({ id: masterAvatarUploads.id, rawStorageKey: masterAvatarUploads.rawStorageKey })
      .from(masterAvatarUploads)
      .where(
        and(
          eq(masterAvatarUploads.status, 'awaiting_upload'),
          lt(masterAvatarUploads.presignExpiresAt, before),
        ),
      )
      .orderBy(asc(masterAvatarUploads.presignExpiresAt))
      .limit(limit);
  }

  /** Uploaded or processing since before `before`: the job was lost. */
  async listStuck(before: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: masterAvatarUploads.id })
      .from(masterAvatarUploads)
      .where(
        and(
          inArray(masterAvatarUploads.status, ['uploaded', 'processing']),
          lt(masterAvatarUploads.updatedAt, before),
        ),
      )
      .orderBy(asc(masterAvatarUploads.updatedAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /**
   * A deleted account's finished uploads whose renditions are still in
   * storage — made before `createdBefore`, so a profile created again keeps
   * an upload it started since, and never one still in flight.
   */
  async listLiveRenditionsOfMaster(masterId: string, createdBefore: Date): Promise<string[]> {
    const rows = await this.db
      .select({ id: masterAvatarUploads.id })
      .from(masterAvatarUploads)
      .where(
        and(
          eq(masterAvatarUploads.masterId, masterId),
          isNotNull(masterAvatarUploads.thumbKey),
          isNull(masterAvatarUploads.renditionsDeletedAt),
          inArray(masterAvatarUploads.status, ['ready', 'failed']),
          sql`${masterAvatarUploads.createdAt} <= ${createdBefore}`,
        ),
      );
    return rows.map((row) => row.id);
  }
}
