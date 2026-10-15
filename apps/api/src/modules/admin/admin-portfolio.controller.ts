import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { AdminPortfolioPost, AdminPortfolioPostDetail, CursorPage } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { AdminActor } from './admin.types';
import {
  adminMasterAvatarParamsSchema,
  adminPortfolioPostParamsSchema,
  listAdminPortfolioQuerySchema,
  removalReasonSchema,
} from './admin-portfolio.schema';
import { AdminPortfolioService } from './admin-portfolio.service';
import { RequireAdminPermission } from './admin-permission.decorator';
import { CurrentAdmin } from './current-admin.decorator';

class ListAdminPortfolioQueryDto extends createZodDto(listAdminPortfolioQuerySchema) {}
class AdminPortfolioPostParamsDto extends createZodDto(adminPortfolioPostParamsSchema) {}
class AdminMasterAvatarParamsDto extends createZodDto(adminMasterAvatarParamsSchema) {}
class RemovalReasonDto extends createZodDto(removalReasonSchema) {}

/**
 * Portfolio moderation (#312, ADR-0045 § 6, § 8). Every route needs
 * `portfolio.moderate` — moderator and super_admin — and is denied to every
 * other role by the permission guard (ADR-0043). Being under `/admin`, the
 * admin authentication guard applies from the matched route (#269).
 */
@Controller('admin')
export class AdminPortfolioController {
  constructor(private readonly portfolio: AdminPortfolioService) {}

  /** Every post, newest first, with its master and its removal, if any. */
  @RequireAdminPermission('portfolio.moderate')
  @Get('portfolio/posts')
  async list(@Query() query: ListAdminPortfolioQueryDto): Promise<CursorPage<AdminPortfolioPost>> {
    return this.portfolio.list(query);
  }

  /** One post and its photos: public URLs while live, presigned while kept as evidence. */
  @RequireAdminPermission('portfolio.moderate')
  @Get('portfolio/posts/:postId')
  async get(@Param() params: AdminPortfolioPostParamsDto): Promise<AdminPortfolioPostDetail> {
    return this.portfolio.get(params.postId);
  }

  /**
   * Removes a published post with a mandatory reason. `POST` to a `removal`
   * sub-resource, as a review's: nothing is deleted from the record. 200 —
   * the removal is a state of the post.
   */
  @RequireAdminPermission('portfolio.moderate')
  @HttpCode(200)
  @Post('portfolio/posts/:postId/removal')
  async remove(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminPortfolioPostParamsDto,
    @Body() body: RemovalReasonDto,
  ): Promise<AdminPortfolioPostDetail> {
    return this.portfolio.removePost(admin, params.postId, body);
  }

  /** Removes a master's avatar with a mandatory reason (ADR-0045 § 8). 204: nothing to return. */
  @RequireAdminPermission('portfolio.moderate')
  @HttpCode(204)
  @Post('masters/:masterId/avatar/removal')
  async removeAvatar(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminMasterAvatarParamsDto,
    @Body() body: RemovalReasonDto,
  ): Promise<void> {
    await this.portfolio.removeAvatar(admin, params.masterId, body);
  }
}
