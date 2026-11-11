import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AdminAccountRecoveryPhoto,
  AdminAccountRecoveryPhotoDownload,
  AdminAccountRecoveryPhotoUpload,
} from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { uuidV7 } from '../../common/ids/uuid-v7';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { AccountRecoveryPhotoRow } from '../../infra/database/schema/account-recovery';
import {
  IMAGE_SIGNATURE_BYTES,
  sniffImageContentType,
} from '../../infra/storage/image-content-type';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import { AdminRepository } from '../admin/admin.repository';
import type { AdminActor } from '../admin/admin.types';
import {
  UploadAlreadyConfirmedError,
  UploadContentMismatchError,
  UploadNotFoundInStorageError,
  UploadTooLargeError,
} from '../masters/master-verification.service';
import type { StoredRecoveryPhoto } from './account-recovery-photos.repository';
import { AccountRecoveryPhotosRepository } from './account-recovery-photos.repository';
import type { PresignRecoveryPhotoRequest } from './account-recovery.schema';
import { AccountRecoveryRepository } from './account-recovery.repository';
import type { AccountRecoveryView } from './account-recovery.repository';
import { AccountRecoveryNotAllowedNowError, recoveryStatus } from './account-recovery.service';

/** The audit target of a photo: its reads are traced to the photo, as a master document's are. */
const PHOTO_AUDIT_TARGET = 'account_recovery_photo';

export class AccountRecoveryPhotosMasterOnlyError extends AppError {
  constructor() {
    super(
      ERROR_CODES.ACCOUNT_RECOVERY_PHOTOS_MASTER_ONLY,
      'Photos are evidence for a master’s account only.',
      409,
    );
    this.name = 'AccountRecoveryPhotosMasterOnlyError';
    Object.setPrototypeOf(this, AccountRecoveryPhotosMasterOnlyError.prototype);
  }
}

export class AccountRecoveryPhotoExistsError extends AppError {
  constructor() {
    super(
      ERROR_CODES.ACCOUNT_RECOVERY_PHOTO_EXISTS,
      'A photo of this kind is already on the request.',
      409,
    );
    this.name = 'AccountRecoveryPhotoExistsError';
    Object.setPrototypeOf(this, AccountRecoveryPhotoExistsError.prototype);
  }
}

/**
 * The evidence photos of a master's recovery request (#524,
 * [ADR-0074](docs/decisions/ADR-0074-account-recovery-and-email-change.md)
 * § 2): a fresh selfie holding the ID card, and the card's front.
 *
 * The upload is the master documents' (ADR-0023, ADR-0024), not a second
 * pipeline: a presigned PUT to the private bucket from the admin's browser,
 * then a confirm that checks the real size against the cap and the leading
 * bytes against the declared type, and deletes what fails. Keys are made
 * here and never leave the API.
 *
 * - **Who:** `accounts.recover`, enforced by the controller.
 * - **When:** photos are added only while the request is open; reads stay
 *   possible after, because the request is the record of the move.
 * - **One of each kind**, never replaced: a stored photo is what the request
 *   was opened on.
 * - **Never logged, never audited as bytes.** The audit log records who
 *   added and who read which photo; the log lines carry no key.
 */
@Injectable()
export class AccountRecoveryPhotosService {
  private readonly logger = new Logger(AccountRecoveryPhotosService.name);

  constructor(
    private readonly recoveries: AccountRecoveryRepository,
    private readonly photos: AccountRecoveryPhotosRepository,
    private readonly admins: AdminRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async presign(
    admin: AdminActor,
    recoveryId: string,
    input: PresignRecoveryPhotoRequest,
    now: Date = new Date(),
  ): Promise<AdminAccountRecoveryPhotoUpload> {
    await this.requireOpenMasterRequest(recoveryId, now);

    const existing = await this.photos.findByKind(recoveryId, input.kind);
    if (existing?.status === 'stored') {
      throw new AccountRecoveryPhotoExistsError();
    }
    if (existing !== undefined) {
      // An earlier presign nobody confirmed holds the slot, and may have
      // bytes behind it. Clear both before minting a replacement.
      if (await this.photos.deleteAwaiting(existing.id)) {
        await this.storage.delete(existing.storageKey);
      }
    }

    const { presignTtlSeconds, verificationDocumentMaxBytes } = this.config.storage;
    const storageKey = `account-recoveries/${recoveryId}/${uuidV7()}`;
    const presigned = await this.storage.presignUpload({
      key: storageKey,
      contentType: input.contentType,
      ttlSeconds: presignTtlSeconds,
      maxBytes: verificationDocumentMaxBytes,
    });

    const row = await this.photos.createPending({
      recoveryId,
      kind: input.kind,
      storageKey,
      declaredContentType: input.contentType,
      uploadedByAdminId: admin.adminUserId,
      presignExpiresAt: presigned.expiresAt,
    });
    if (row === undefined) {
      // Another admin presigned or stored this kind between the read and the insert.
      throw new AccountRecoveryPhotoExistsError();
    }

    return {
      photoId: row.id,
      uploadUrl: presigned.url,
      expiresAt: presigned.expiresAt.toISOString(),
      contentType: input.contentType,
      maxBytes: verificationDocumentMaxBytes,
    };
  }

  /**
   * Turns an upload into evidence, or refuses and deletes it. The checks run
   * in the master documents' order: the size from `head`, then twelve bytes
   * sniffed, then the conditional move.
   */
  async confirm(
    admin: AdminActor,
    recoveryId: string,
    photoId: string,
    now: Date = new Date(),
  ): Promise<AdminAccountRecoveryPhoto> {
    await this.requireOpenMasterRequest(recoveryId, now);
    const photo = await this.photos.find(recoveryId, photoId);
    if (photo === undefined) {
      throw new NotFoundError();
    }
    if (photo.status !== 'awaiting_upload') {
      throw new UploadAlreadyConfirmedError();
    }

    const head = await this.storage.head(photo.storageKey);
    if (head === undefined) {
      throw new UploadNotFoundInStorageError();
    }

    const maxBytes = this.config.storage.verificationDocumentMaxBytes;
    if (head.sizeBytes > maxBytes) {
      await this.discard(photo, 'oversize');
      throw new UploadTooLargeError(head.sizeBytes, maxBytes);
    }

    const prefix = await this.storage.readPrefix(photo.storageKey, IMAGE_SIGNATURE_BYTES);
    const sniffed = prefix === undefined ? null : sniffImageContentType(prefix);
    if (sniffed === null || sniffed !== photo.declaredContentType) {
      await this.discard(photo, 'content-mismatch');
      throw new UploadContentMismatchError();
    }

    const stored = await this.photos.markStored({
      photoId: photo.id,
      sizeBytes: head.sizeBytes,
      verifiedContentType: sniffed,
      now,
    });
    if (stored === undefined) {
      throw new UploadAlreadyConfirmedError();
    }

    await this.admins.appendAudit(
      {
        adminUserId: admin.adminUserId,
        action: 'account.recovery.photo.add',
        targetType: PHOTO_AUDIT_TARGET,
        targetId: stored.id,
      },
      now,
    );

    return toPhotoResponse({ ...stored, uploadedByName: admin.displayName });
  }

  /** The stored photos' facts. No bytes and no link, so not audited; each view is. */
  async list(recoveryId: string): Promise<AdminAccountRecoveryPhoto[]> {
    await this.require(recoveryId);
    const rows = await this.photos.listStored(recoveryId);
    return rows.map(toPhotoResponse);
  }

  /**
   * A short-lived link to one stored photo. **Audited against the photo**, so
   * the trail answers who looked at this identity document. Allowed after the
   * request closed: it is the record of what was decided.
   */
  async presignDownload(
    admin: AdminActor,
    recoveryId: string,
    photoId: string,
  ): Promise<AdminAccountRecoveryPhotoDownload> {
    await this.require(recoveryId);
    const photo = await this.photos.find(recoveryId, photoId);
    if (photo === undefined || photo.status !== 'stored') {
      throw new NotFoundError();
    }

    const presigned = await this.storage.presignDownload({
      key: photo.storageKey,
      ttlSeconds: this.config.storage.downloadTtlSeconds,
    });

    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'account.recovery.photo.read',
      targetType: PHOTO_AUDIT_TARGET,
      targetId: photo.id,
    });

    return { url: presigned.url, expiresAt: presigned.expiresAt.toISOString() };
  }

  private async require(recoveryId: string): Promise<AccountRecoveryView> {
    const row = await this.recoveries.find(recoveryId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }

  private async requireOpenMasterRequest(
    recoveryId: string,
    now: Date,
  ): Promise<AccountRecoveryView> {
    const row = await this.require(recoveryId);
    if (row.cancelledAt !== null || row.movedAt !== null) {
      throw new AccountRecoveryNotAllowedNowError(recoveryStatus(row, now));
    }
    if (row.masterId === null) {
      throw new AccountRecoveryPhotosMasterOnlyError();
    }
    return row;
  }

  /**
   * Deletes the object that failed and keeps the row, as master documents do:
   * the presigned URL still works, so a retry lands on a key this service
   * knows. The reason is logged with the request id, never the key.
   */
  private async discard(photo: AccountRecoveryPhotoRow, reason: string): Promise<void> {
    await this.storage.delete(photo.storageKey);
    this.logger.warn(
      `recovery photo rejected (${reason}) for request ${photo.recoveryId}, kind ${photo.kind}`,
    );
  }
}

/** The key and both content types stay out, as they do for master documents. */
function toPhotoResponse(row: StoredRecoveryPhoto): AdminAccountRecoveryPhoto {
  if (row.sizeBytes === null || row.storedAt === null) {
    // The table's CHECK makes a stored row carry both.
    throw new Error('A stored recovery photo has no size or time.');
  }
  return {
    id: row.id,
    kind: row.kind,
    sizeBytes: row.sizeBytes,
    uploadedByAdminId: row.uploadedByAdminId,
    uploadedByName: row.uploadedByName,
    storedAt: row.storedAt.toISOString(),
  };
}
