import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import type {
  MasterDocument,
  MasterDocumentDownload,
  MasterDocumentUpload,
  MasterVerificationSubmission,
} from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { documentIdParamsSchema, presignDocumentSchema } from './master-verification.schema';
import { MasterVerificationService } from './master-verification.service';

class PresignDocumentDto extends createZodDto(presignDocumentSchema) {}
class DocumentIdParamsDto extends createZodDto(documentIdParamsSchema) {}

/**
 * The master's own verification surface: upload evidence, look at it, submit
 * it for review.
 *
 * **No admin action is reachable from here.** `docs/product/admin-flow.md`
 * § non-negotiable 6 — "admin endpoints are a separate, separately-guarded
 * surface, never a role flag on a customer-facing endpoint" — so approving,
 * rejecting and suspending live in issue #39's `/admin/masters`.
 *
 * Every route carries `@Roles('master')`. Reaching any of them without a
 * master profile is a 404 from the service anyway, but the role gate is the
 * cheaper and more explicit of the two, and defence in depth on the endpoints
 * that handle identity documents is not the place to economise.
 */
@Controller('masters/me')
export class MasterVerificationController {
  constructor(private readonly verification: MasterVerificationService) {}

  /**
   * The only rate-limited route in the masters module.
   *
   * Every call mints permission to write bytes into a bucket somebody pays
   * for, which is `geocode`'s shape of abuse rather than a credential attack
   * (`infra/rate-limit/rate-limit.config.ts`). Identified by user id, so a
   * master with three devices gets one budget rather than three.
   */
  @Roles('master')
  @RateLimit({ policy: 'document-upload', identifier: rateLimitByUser })
  @Post('documents/presign')
  async presign(
    @CurrentActor() actor: Actor,
    @Body() body: PresignDocumentDto,
  ): Promise<MasterDocumentUpload> {
    return this.verification.presignUpload(actor, body);
  }

  /**
   * Confirms the upload landed, and is where every server-side control on the
   * file actually runs — size against the real object, and the leading bytes
   * against the type the URL was signed for.
   */
  @Roles('master')
  @Post('documents/:id/confirm')
  async confirm(
    @CurrentActor() actor: Actor,
    @Param() params: DocumentIdParamsDto,
  ): Promise<MasterDocument> {
    return this.verification.confirmUpload(actor, params.id);
  }

  @Roles('master')
  @Get('documents')
  async list(@CurrentActor() actor: Actor): Promise<MasterDocument[]> {
    return this.verification.listDocuments(actor);
  }

  @Roles('master')
  @Get('documents/:id/download')
  async download(
    @CurrentActor() actor: Actor,
    @Param() params: DocumentIdParamsDto,
  ): Promise<MasterDocumentDownload> {
    return this.verification.presignDownload(actor, params.id);
  }

  @Roles('master')
  @Delete('documents/:id')
  @HttpCode(204)
  async withdraw(
    @CurrentActor() actor: Actor,
    @Param() params: DocumentIdParamsDto,
  ): Promise<void> {
    await this.verification.withdrawDocument(actor, params.id);
  }

  @Roles('master')
  @Post('verification/submit')
  async submit(@CurrentActor() actor: Actor): Promise<MasterVerificationSubmission> {
    return this.verification.submitForReview(actor);
  }
}
