import { Controller, Get, Param } from '@nestjs/common';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { orderPhotoParamsSchema } from '../orders/order-photos.schema';
import { AdminOrderPhotosService } from './admin-order-photos.service';
import type { AdminActor } from './admin.types';
import { RequireAdminPermission } from './admin-permission.decorator';
import { CurrentAdmin } from './current-admin.decorator';

class OrderPhotoParamsDto extends createZodDto(orderPhotoParamsSchema) {}

/**
 * Admin reads of order problem photos — a **separate, separately-guarded
 * surface** (`docs/product/admin-flow.md`, non-negotiable 6), the same rule
 * `AdminMastersController` follows. No `@Roles()` and no `@Public()`: every
 * route under `/admin` is authenticated by `AdminAuthenticationGuard` because
 * of its path, not a decorator (see that controller's class comment for the
 * full reasoning).
 */
@Controller('admin/orders')
export class AdminOrderPhotosController {
  constructor(private readonly photos: AdminOrderPhotosService) {}

  @RequireAdminPermission('orders.read')
  @Get(':orderId/photos/:photoId/download')
  async download(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: OrderPhotoParamsDto,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.photos.presignDownload(admin, params.orderId, params.photoId);
  }
}
