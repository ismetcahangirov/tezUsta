import { Body, Controller, Param, Post } from '@nestjs/common';
import type { ConfirmedMessageAttachment, MessageAttachmentUpload } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { orderIdParamsSchema } from './conversations.schema';
import {
  messageAttachmentParamsSchema,
  presignMessageAttachmentSchema,
} from './message-attachments.schema';
import { MessageAttachmentsService } from './message-attachments.service';

class OrderIdParamsDto extends createZodDto(orderIdParamsSchema) {}
class MessageAttachmentParamsDto extends createZodDto(messageAttachmentParamsSchema) {}
class PresignMessageAttachmentDto extends createZodDto(presignMessageAttachmentSchema) {}

/**
 * Photos in the conversation on one order (issue #181): presign and confirm.
 *
 * **Under `orders/:orderId/messages`, like every other conversation route**,
 * and for `conversations.controller.ts`'s reason: the order is the only
 * identifier a client is given, so there is no conversation id to guess and no
 * second identifier space for authorization to be got wrong in. Sending a
 * confirmed photo is not a route here — it is `POST .../messages` naming it in
 * `attachmentIds` — and there is no download route either: a photo's read URL
 * arrives on the message itself, minted for whoever just proved they are a
 * party by reading the history.
 *
 * `@Roles('customer', 'master')` is the cheap first gate, not the
 * authorization; `ConversationsService#requireParty` is, on every request.
 *
 * **Both routes carry `@RateLimit` on the `document-upload` policy**, the one
 * order-photo presign and confirm already share, and for the reasons
 * `order-photos.controller.ts` gives: a presign is permission to write bytes
 * into a bucket somebody pays for, and a rejected confirm leaves its row in
 * place for a retry, so confirm is otherwise a loop of one billed `HeadObject`
 * and one billed ranged `GET` with nothing else bounding it. One budget across
 * all photo uploads rather than a second policy, because the abuse is the same
 * one and a person uploading photos to an order and to its conversation is one
 * person spending one bucket.
 */
@Roles('customer', 'master')
@Controller('orders/:orderId/messages/attachments')
export class MessageAttachmentsController {
  constructor(private readonly attachments: MessageAttachmentsService) {}

  @RateLimit({ policy: 'document-upload', identifier: rateLimitByUser })
  @Post()
  async presign(
    @CurrentActor() actor: Actor,
    @Param() params: OrderIdParamsDto,
    @Body() body: PresignMessageAttachmentDto,
  ): Promise<MessageAttachmentUpload> {
    return this.attachments.presignUpload(actor, params.orderId, body);
  }

  /**
   * Confirms the upload landed — where the size cap and the magic-byte check
   * actually run, against the real object (ADR-0024).
   */
  @RateLimit({ policy: 'document-upload', identifier: rateLimitByUser })
  @Post(':attachmentId/confirm')
  async confirm(
    @CurrentActor() actor: Actor,
    @Param() params: MessageAttachmentParamsDto,
  ): Promise<ConfirmedMessageAttachment> {
    return this.attachments.confirmUpload(actor, params.orderId, params.attachmentId);
  }
}
