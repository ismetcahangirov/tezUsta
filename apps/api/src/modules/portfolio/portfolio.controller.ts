import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type {
  CursorPage,
  OwnPortfolioMedia,
  OwnPortfolioPost,
  PortfolioMediaUpload,
} from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { parseAcceptLanguage } from '../../common/i18n/accept-language';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import {
  createPortfolioPostSchema,
  listPortfolioPostsQuerySchema,
  mediaParamsSchema,
  postIdParamsSchema,
  presignPortfolioMediaSchema,
  updatePortfolioPostSchema,
} from './portfolio.schema';
import { PortfolioService } from './portfolio.service';

class CreatePortfolioPostDto extends createZodDto(createPortfolioPostSchema) {}
class UpdatePortfolioPostDto extends createZodDto(updatePortfolioPostSchema) {}
class PresignPortfolioMediaDto extends createZodDto(presignPortfolioMediaSchema) {}
class PostIdParamsDto extends createZodDto(postIdParamsSchema) {}
class MediaParamsDto extends createZodDto(mediaParamsSchema) {}
class ListPortfolioPostsQueryDto extends createZodDto(listPortfolioPostsQuerySchema) {}

/**
 * The master's own portfolio (#308). Every route is the caller's own: there is
 * no master id in the path, and a post id is looked up among the caller's
 * posts.
 *
 * Rate limits:
 * - `portfolio-upload` on presign and confirm — each is permission to write
 *   to, or a billed read of, the bucket;
 * - `portfolio-write` on every other write.
 *
 * The two reads are not limited, like every other own-resource read here. The
 * editor's polling of one post is bounded by the client (RTK Query, #317's
 * processing budget), and the read is two indexed queries.
 */
@Controller('masters/me/portfolio/posts')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @RateLimit({ policy: 'portfolio-write', identifier: rateLimitByUser })
  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body() body: CreatePortfolioPostDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<OwnPortfolioPost> {
    return this.portfolio.createPost(actor, body, parseAcceptLanguage(acceptLanguage));
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query() query: ListPortfolioPostsQueryDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<CursorPage<OwnPortfolioPost>> {
    return this.portfolio.listOwn(actor, query, parseAcceptLanguage(acceptLanguage));
  }

  /** The editor's polling target while photos process. */
  @Get(':postId')
  async get(
    @CurrentActor() actor: Actor,
    @Param() params: PostIdParamsDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<OwnPortfolioPost> {
    return this.portfolio.getOwn(actor, params.postId, parseAcceptLanguage(acceptLanguage));
  }

  @RateLimit({ policy: 'portfolio-write', identifier: rateLimitByUser })
  @Patch(':postId')
  async update(
    @CurrentActor() actor: Actor,
    @Param() params: PostIdParamsDto,
    @Body() body: UpdatePortfolioPostDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<OwnPortfolioPost> {
    return this.portfolio.updatePost(
      actor,
      params.postId,
      body,
      parseAcceptLanguage(acceptLanguage),
    );
  }

  @RateLimit({ policy: 'portfolio-write', identifier: rateLimitByUser })
  @Delete(':postId')
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param() params: PostIdParamsDto): Promise<void> {
    await this.portfolio.deletePost(actor, params.postId);
  }

  @RateLimit({ policy: 'portfolio-write', identifier: rateLimitByUser })
  @Post(':postId/publish')
  @HttpCode(200)
  async publish(
    @CurrentActor() actor: Actor,
    @Param() params: PostIdParamsDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<OwnPortfolioPost> {
    return this.portfolio.publish(actor, params.postId, parseAcceptLanguage(acceptLanguage));
  }

  @RateLimit({ policy: 'portfolio-upload', identifier: rateLimitByUser })
  @Post(':postId/media')
  async presign(
    @CurrentActor() actor: Actor,
    @Param() params: PostIdParamsDto,
    @Body() body: PresignPortfolioMediaDto,
  ): Promise<PortfolioMediaUpload> {
    return this.portfolio.presignMedia(actor, params.postId, body);
  }

  @RateLimit({ policy: 'portfolio-upload', identifier: rateLimitByUser })
  @Post(':postId/media/:mediaId/confirm')
  @HttpCode(200)
  async confirm(
    @CurrentActor() actor: Actor,
    @Param() params: MediaParamsDto,
  ): Promise<OwnPortfolioMedia> {
    return this.portfolio.confirmMedia(actor, params.postId, params.mediaId);
  }

  @RateLimit({ policy: 'portfolio-write', identifier: rateLimitByUser })
  @Delete(':postId/media/:mediaId')
  @HttpCode(204)
  async removeMedia(@CurrentActor() actor: Actor, @Param() params: MediaParamsDto): Promise<void> {
    await this.portfolio.deleteMedia(actor, params.postId, params.mediaId);
  }
}
