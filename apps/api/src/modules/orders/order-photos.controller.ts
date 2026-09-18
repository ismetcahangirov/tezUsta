import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { OrderPhoto, OrderPhotoDownload, OrderPhotoUpload } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import {
  attachOrderPhotoSchema,
  orderIdParamsSchema,
  orderPhotoParamsSchema,
  photoIdParamsSchema,
  presignOrderPhotoSchema,
} from './order-photos.schema';
import { OrderPhotosService } from './order-photos.service';

class PresignOrderPhotoDto extends createZodDto(presignOrderPhotoSchema) {}
class PhotoIdParamsDto extends createZodDto(photoIdParamsSchema) {}
class OrderIdParamsDto extends createZodDto(orderIdParamsSchema) {}
class OrderPhotoParamsDto extends createZodDto(orderPhotoParamsSchema) {}
class AttachOrderPhotoDto extends createZodDto(attachOrderPhotoSchema) {}

/**
 * Order problem photos (issue #83): presign, confirm, attach, read.
 *
 * **Presign and confirm are not scoped to an order.** A photo is issued to
 * the calling customer, and attach is a separate, explicit step — see
 * `order-photos.service.ts`'s class comment for why. `orders/photos/...`
 * sits ahead of `orders/:id` in the reading order for the reason
 * `orders.controller.ts` already gives for its own routes: `photos` is a
 * literal segment, so Fastify's router disambiguates it from a parameter
 * regardless of registration order, but the reading order still matters to
 * whoever adds the next route.
 *
 * Nothing here is `@Public()`. `presign`, `confirm` and `download` all carry
 * `@RateLimit` on the `document-upload` policy shared with
 * `master-verification.controller.ts` — the same shape of abuse, permission
 * to touch a bucket somebody pays for. `master-verification.controller.ts`
 * rate-limits only its presign route, and gets away with it because
 * `master_documents_pending_upload_unique` already bounds a master to one
 * outstanding presign per document type; a rejected confirm there is
 * therefore also bounded by how many presigns exist to retry. This module
 * has the equivalent bound now (`order_photos_pending_upload_unique`), but a
 * rejected confirm deliberately leaves the row in `awaiting_upload` so the
 * same presigned URL can be retried — which makes `confirm` a loop of one
 * billed `HeadObject` plus one billed ranged `GET` against R2 with no other
 * limit on how many times it runs. `download` mints a fresh presigned URL on
 * every call with no cap of its own either. Neither is free to leave open.
 */
@Controller('orders')
export class OrderPhotosController {
  constructor(private readonly photos: OrderPhotosService) {}

  @RateLimit({ policy: 'document-upload', identifier: rateLimitByUser })
  @Post('photos/presign')
  async presign(
    @CurrentActor() actor: Actor,
    @Body() body: PresignOrderPhotoDto,
  ): Promise<OrderPhotoUpload> {
    return this.photos.presignUpload(actor, body);
  }

  /**
   * Confirms the upload landed, and is where every server-side control on the
   * file actually runs — size against the real object, and the leading bytes
   * against the type the URL was signed for.
   */
  @RateLimit({ policy: 'document-upload', identifier: rateLimitByUser })
  @Post('photos/:photoId/confirm')
  async confirm(
    @CurrentActor() actor: Actor,
    @Param() params: PhotoIdParamsDto,
  ): Promise<OrderPhoto> {
    return this.photos.confirmUpload(actor, params.photoId);
  }

  /** Attaches one of the caller's own confirmed photos to one of their own orders. */
  @Post(':orderId/photos')
  async attach(
    @CurrentActor() actor: Actor,
    @Param() params: OrderIdParamsDto,
    @Body() body: AttachOrderPhotoDto,
  ): Promise<OrderPhoto> {
    return this.photos.attach(actor, params.orderId, body);
  }

  /** Every photo attached to the order — visible to its customer and its assigned master. */
  @Get(':orderId/photos')
  async list(
    @CurrentActor() actor: Actor,
    @Param() params: OrderIdParamsDto,
  ): Promise<OrderPhoto[]> {
    return this.photos.listForOrder(actor, params.orderId);
  }

  @RateLimit({ policy: 'document-upload', identifier: rateLimitByUser })
  @Get(':orderId/photos/:photoId/download')
  async download(
    @CurrentActor() actor: Actor,
    @Param() params: OrderPhotoParamsDto,
  ): Promise<OrderPhotoDownload> {
    return this.photos.presignDownload(actor, params.orderId, params.photoId);
  }
}
