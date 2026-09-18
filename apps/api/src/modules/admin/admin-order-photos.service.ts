import { Inject, Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors/not-found.error';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import { OrderPhotosService } from '../orders/order-photos.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';

/**
 * Admin reads of order problem photos (issue #83) — the third audience
 * `ADR-0005`'s controls table names alongside the owning customer and the
 * assigned master.
 *
 * A tiny surface, deliberately: this is the one capability the acceptance
 * criteria actually require (a short-lived, audited read), not a moderation
 * queue or a dispute-review UI. Those belong to the admin panel (EPIC 13) and
 * dispute handling (EPIC 8), neither of which exists yet — building them now,
 * ahead of the order-lifecycle work they depend on, is exactly what
 * CLAUDE.md §20 forbids ("implementing a dependent feature before its
 * prerequisite exists"). A single audited download endpoint is not that: it
 * is the same capability `AdminMastersService#presignDocument` already
 * grants for verification documents, mirrored onto the second kind of photo
 * this codebase stores.
 */
@Injectable()
export class AdminOrderPhotosService {
  constructor(
    private readonly orderPhotos: OrderPhotosService,
    private readonly admins: AdminRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * A short-lived read URL for one photo, audited against the photo itself —
   * not the order — so the trail answers "who looked at this photograph of
   * somebody's home" rather than only "who opened this order's file". Same
   * reasoning `AdminMastersService#presignDocument`'s doc comment gives.
   *
   * **Audited on both outcomes, including a 404.** An admin session probing
   * guessed order and photo ids would otherwise leave no trace at all until
   * the first one happened to resolve — the audit trail is supposed to be
   * the record of what an admin looked at, and "tried to look at, and
   * failed" is part of that record too. `order_photo.read.not_found` carries
   * that distinction in the action name itself, so a reviewer of the log
   * does not need to cross-reference `order_photos` to tell a real read from
   * a guess.
   *
   * The successful path keeps its original order — presign, *then* audit,
   * *then* return — for the reason `AdminMastersService#act`'s doc comment
   * gives: writing the audit entry after the thing it describes actually
   * happened means the only failure mode is a read that succeeded whose
   * audit write then errored, which is loud and recoverable, rather than a
   * record of a read that never completed.
   */
  async presignDownload(
    admin: AdminActor,
    orderId: string,
    photoId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const photo = await this.orderPhotos.findPhotoForModeration(orderId, photoId);

    if (photo === undefined || photo.status !== 'attached') {
      // Nothing is behind an unconfirmed or unattached key, and a photo id
      // that is not attached to *this* order is not this order's business
      // either. Both are 404, for the same reason they are on the customer's
      // own routes — but unlike those routes, this attempt is still an
      // admin action and still gets a row.
      await this.admins.appendAudit({
        adminUserId: admin.adminUserId,
        action: 'order_photo.read.not_found',
        targetType: 'order_photo',
        targetId: photoId,
      });
      throw new NotFoundError();
    }

    const presigned = await this.storage.presignDownload({
      key: photo.storageKey,
      ttlSeconds: this.config.storage.downloadTtlSeconds,
    });

    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'order_photo.read',
      targetType: 'order_photo',
      targetId: photo.id,
    });

    return { url: presigned.url, expiresAt: presigned.expiresAt.toISOString() };
  }
}
