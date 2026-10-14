import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { MasterAvatarPresign, MasterAvatarUpload } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { avatarUploadParamsSchema, presignAvatarSchema } from './master-avatar.schema';
import { MasterAvatarService } from './master-avatar.service';

class PresignAvatarDto extends createZodDto(presignAvatarSchema) {}
class AvatarUploadParamsDto extends createZodDto(avatarUploadParamsSchema) {}

/**
 * The caller's own avatar (#309). `GET /masters/me` carries the avatar's URLs;
 * these routes change it. Presign and confirm share the portfolio's
 * `portfolio-upload` budget, and removal its `portfolio-write`.
 */
@Controller('masters/me/avatar')
export class MasterAvatarController {
  constructor(private readonly avatars: MasterAvatarService) {}

  @RateLimit({ policy: 'portfolio-upload', identifier: rateLimitByUser })
  @Post('presign')
  async presign(
    @CurrentActor() actor: Actor,
    @Body() body: PresignAvatarDto,
  ): Promise<MasterAvatarPresign> {
    return this.avatars.presign(actor, body);
  }

  @RateLimit({ policy: 'portfolio-upload', identifier: rateLimitByUser })
  @Post(':uploadId/confirm')
  @HttpCode(200)
  async confirm(
    @CurrentActor() actor: Actor,
    @Param() params: AvatarUploadParamsDto,
  ): Promise<MasterAvatarUpload> {
    return this.avatars.confirm(actor, params.uploadId);
  }

  /** The upload's progress, while the app waits for the new avatar. */
  @Get(':uploadId')
  async get(
    @CurrentActor() actor: Actor,
    @Param() params: AvatarUploadParamsDto,
  ): Promise<MasterAvatarUpload> {
    return this.avatars.getUpload(actor, params.uploadId);
  }

  @RateLimit({ policy: 'portfolio-write', identifier: rateLimitByUser })
  @Delete()
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor): Promise<void> {
    await this.avatars.remove(actor);
  }
}
