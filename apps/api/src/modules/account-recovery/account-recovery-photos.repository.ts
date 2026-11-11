import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, lte } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type {
  AccountRecoveryPhotoKindName,
  AccountRecoveryPhotoRow,
} from '../../infra/database/schema/account-recovery';
import { accountRecoveryPhotos } from '../../infra/database/schema/account-recovery';
import { adminUsers } from '../../infra/database/schema/admin';

/** A stored photo with the name of the admin who added it, for the panel. */
export interface StoredRecoveryPhoto extends AccountRecoveryPhotoRow {
  readonly uploadedByName: string | null;
}

/**
 * The evidence photos of a recovery request (#524). Every query is scoped by
 * the request id, so a photo id from another request names nothing here.
 */
@Injectable()
export class AccountRecoveryPhotosRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async findByKind(
    recoveryId: string,
    kind: AccountRecoveryPhotoKindName,
  ): Promise<AccountRecoveryPhotoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(accountRecoveryPhotos)
      .where(
        and(eq(accountRecoveryPhotos.recoveryId, recoveryId), eq(accountRecoveryPhotos.kind, kind)),
      )
      .limit(1);
    return row;
  }

  async find(recoveryId: string, photoId: string): Promise<AccountRecoveryPhotoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(accountRecoveryPhotos)
      .where(
        and(
          eq(accountRecoveryPhotos.recoveryId, recoveryId),
          eq(accountRecoveryPhotos.id, photoId),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Inserts the pending row. `undefined` when the kind's slot is already
   * held: two admins presigning at once both pass the service's read, and
   * the unique index leaves one row.
   */
  async createPending(input: {
    recoveryId: string;
    kind: AccountRecoveryPhotoKindName;
    storageKey: string;
    declaredContentType: string;
    uploadedByAdminId: string;
    presignExpiresAt: Date;
  }): Promise<AccountRecoveryPhotoRow | undefined> {
    const [row] = await this.db
      .insert(accountRecoveryPhotos)
      .values({ id: uuidV7(), ...input })
      .onConflictDoNothing()
      .returning();
    return row;
  }

  /** Deletes a presign nobody confirmed. `false` when it was confirmed meanwhile. */
  async deleteAwaiting(photoId: string): Promise<boolean> {
    const rows = await this.db
      .delete(accountRecoveryPhotos)
      .where(
        and(
          eq(accountRecoveryPhotos.id, photoId),
          eq(accountRecoveryPhotos.status, 'awaiting_upload'),
        ),
      )
      .returning({ id: accountRecoveryPhotos.id });
    return rows.length > 0;
  }

  /** Moves a checked upload to `stored`, once: a second confirm finds nothing to move. */
  async markStored(input: {
    photoId: string;
    sizeBytes: number;
    verifiedContentType: string;
    now: Date;
  }): Promise<AccountRecoveryPhotoRow | undefined> {
    const [row] = await this.db
      .update(accountRecoveryPhotos)
      .set({
        status: 'stored',
        sizeBytes: input.sizeBytes,
        verifiedContentType: input.verifiedContentType,
        storedAt: input.now,
      })
      .where(
        and(
          eq(accountRecoveryPhotos.id, input.photoId),
          eq(accountRecoveryPhotos.status, 'awaiting_upload'),
        ),
      )
      .returning();
    return row;
  }

  async listStored(recoveryId: string): Promise<StoredRecoveryPhoto[]> {
    const rows = await this.db
      .select({ photo: accountRecoveryPhotos, uploadedByName: adminUsers.displayName })
      .from(accountRecoveryPhotos)
      .leftJoin(adminUsers, eq(adminUsers.id, accountRecoveryPhotos.uploadedByAdminId))
      .where(
        and(
          eq(accountRecoveryPhotos.recoveryId, recoveryId),
          eq(accountRecoveryPhotos.status, 'stored'),
        ),
      )
      .orderBy(asc(accountRecoveryPhotos.kind));
    return rows.map(({ photo, uploadedByName }) => ({ ...photo, uploadedByName }));
  }

  /** Presigns whose URL stopped working before `cutoff` and were never confirmed. */
  async listAbandoned(cutoff: Date, limit: number): Promise<{ id: string }[]> {
    return this.db
      .select({ id: accountRecoveryPhotos.id })
      .from(accountRecoveryPhotos)
      .where(
        and(
          eq(accountRecoveryPhotos.status, 'awaiting_upload'),
          lte(accountRecoveryPhotos.presignExpiresAt, cutoff),
        ),
      )
      .orderBy(asc(accountRecoveryPhotos.presignExpiresAt))
      .limit(limit);
  }

  /**
   * Row and object together, as `MasterVerificationRepository` does: a
   * storage failure rolls the delete back, so the next run tries again
   * instead of leaving bytes nothing names.
   */
  async deleteAbandoned(
    photoId: string,
    deleteObject: (storageKey: string) => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(accountRecoveryPhotos)
        .where(
          and(
            eq(accountRecoveryPhotos.id, photoId),
            eq(accountRecoveryPhotos.status, 'awaiting_upload'),
          ),
        )
        .returning({ storageKey: accountRecoveryPhotos.storageKey });
      if (row === undefined) {
        return false;
      }
      await deleteObject(row.storageKey);
      return true;
    });
  }
}
