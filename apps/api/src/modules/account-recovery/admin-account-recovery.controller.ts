import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type {
  AdminAccountRecovery,
  AdminAccountRecoveryEmails,
  AdminAccountRecoveryPhoto,
  AdminAccountRecoveryPhotoDownload,
  AdminAccountRecoveryPhotoUpload,
} from '@tezusta/types';

import { RequireAdminPermission } from '../admin/admin-permission.decorator';
import type { AdminActor } from '../admin/admin.types';
import { CurrentAdmin } from '../admin/current-admin.decorator';
import { AccountRecoveryPhotosService } from './account-recovery-photos.service';
import {
  OpenRecoveryDto,
  PresignRecoveryPhotoDto,
  RecoveryIdParamsDto,
  RecoveryPhotoParamsDto,
  RecoveryReasonDto,
  VerifyRecoveryDto,
} from './account-recovery.schema';
import { AccountRecoveryService } from './account-recovery.service';

/**
 * Support-mediated account recovery in the admin panel (#515,
 * [ADR-0074](docs/decisions/ADR-0074-account-recovery-and-email-change.md) § 3).
 *
 * Authenticated by its `/admin` path like every admin route. Every handler
 * needs `accounts.recover` (support and super_admin); approving the move
 * additionally needs the `super_admin` role and a different admin from the
 * opener, which the service checks because no permission can say "not you".
 * The two whole addresses are behind `pii.read`, with a reason.
 */
@Controller('admin/account-recoveries')
export class AdminAccountRecoveryController {
  constructor(
    private readonly recoveries: AccountRecoveryService,
    private readonly photos: AccountRecoveryPhotosService,
  ) {}

  /** Every open request, oldest first. */
  @RequireAdminPermission('accounts.recover')
  @Get()
  list(): Promise<AdminAccountRecovery[]> {
    return this.recoveries.listOpen();
  }

  @RequireAdminPermission('accounts.recover')
  @Post()
  open(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: OpenRecoveryDto,
  ): Promise<AdminAccountRecovery> {
    return this.recoveries.open(admin, body);
  }

  @RequireAdminPermission('accounts.recover')
  @Get(':id')
  detail(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: RecoveryIdParamsDto,
  ): Promise<AdminAccountRecovery> {
    return this.recoveries.detail(admin, params.id);
  }

  @RequireAdminPermission('accounts.recover')
  @HttpCode(200)
  @Post(':id/code')
  resendCode(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: RecoveryIdParamsDto,
  ): Promise<AdminAccountRecovery> {
    return this.recoveries.resendCode(admin, params.id);
  }

  @RequireAdminPermission('accounts.recover')
  @HttpCode(200)
  @Post(':id/verify')
  verify(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: RecoveryIdParamsDto,
    @Body() body: VerifyRecoveryDto,
  ): Promise<AdminAccountRecovery> {
    return this.recoveries.verify(admin, params.id, body.code);
  }

  @RequireAdminPermission('accounts.recover')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: RecoveryIdParamsDto,
    @Body() body: RecoveryReasonDto,
  ): Promise<AdminAccountRecovery> {
    return this.recoveries.cancel(admin, params.id, body.reason);
  }

  /** `super_admin`, not the opener, after the hold (ADR-0074 § 2). */
  @RequireAdminPermission('accounts.recover')
  @HttpCode(200)
  @Post(':id/approve')
  approve(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: RecoveryIdParamsDto,
    @Body() body: RecoveryReasonDto,
  ): Promise<AdminAccountRecovery> {
    return this.recoveries.approve(admin, params.id, body.reason);
  }

  /** Both whole addresses, with a mandatory reason (ADR-0043 § 6). */
  @RequireAdminPermission('pii.read')
  @HttpCode(200)
  @Post(':id/emails')
  revealEmails(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: RecoveryIdParamsDto,
    @Body() body: RecoveryReasonDto,
  ): Promise<AdminAccountRecoveryEmails> {
    return this.recoveries.revealEmails(admin, params.id, body.reason);
  }

  /** The stored evidence photos of a master's request (#524), without links. */
  @RequireAdminPermission('accounts.recover')
  @Get(':id/photos')
  listPhotos(@Param() params: RecoveryIdParamsDto): Promise<AdminAccountRecoveryPhoto[]> {
    return this.photos.list(params.id);
  }

  /** A presigned PUT for one photo, while the request is open. */
  @RequireAdminPermission('accounts.recover')
  @Post(':id/photos')
  presignPhoto(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: RecoveryIdParamsDto,
    @Body() body: PresignRecoveryPhotoDto,
  ): Promise<AdminAccountRecoveryPhotoUpload> {
    return this.photos.presign(admin, params.id, body);
  }

  /** Checks the uploaded bytes and stores the photo, audited. */
  @RequireAdminPermission('accounts.recover')
  @HttpCode(200)
  @Post(':id/photos/:photoId/confirm')
  confirmPhoto(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: RecoveryPhotoParamsDto,
  ): Promise<AdminAccountRecoveryPhoto> {
    return this.photos.confirm(admin, params.id, params.photoId);
  }

  /** A short-lived read link; each one issued is audited against the photo. */
  @RequireAdminPermission('accounts.recover')
  @Get(':id/photos/:photoId/download')
  downloadPhoto(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: RecoveryPhotoParamsDto,
  ): Promise<AdminAccountRecoveryPhotoDownload> {
    return this.photos.presignDownload(admin, params.id, params.photoId);
  }
}
