import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { parseAcceptLanguage } from '../../common/i18n/accept-language';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { Public } from '../auth/public.decorator';
import {
  catalogueListQuerySchema,
  serviceIdParamsSchema,
  serviceListQuerySchema,
} from './services.schema';
import { CATALOGUE_CACHE_TTL_SECONDS, ServicesService } from './services.service';
import type { CursorPage, ServiceCategoryResponse, ServiceResponse } from './services.types';

class CategoryListQueryDto extends createZodDto(catalogueListQuerySchema) {}
class ServiceListQueryDto extends createZodDto(serviceListQuerySchema) {}
class ServiceIdParamsDto extends createZodDto(serviceIdParamsSchema) {}

/**
 * The service catalogue, read-only and unauthenticated
 * ([ADR-0020](docs/decisions/ADR-0020-public-cached-service-catalogue.md)).
 *
 * **These are the first unauthenticated business endpoints in the API, and the
 * choice is deliberate.** A customer has to be able to see what TezUsta does
 * before deciding whether to create an account, and gating the catalogue behind
 * a phone number would mean asking for one before offering anything. What is
 * exposed is a list of services and reference prices — a menu — which is
 * exactly what the product advertises publicly anyway. Nothing here is scoped
 * to a user, so there is no ownership dimension to get wrong.
 *
 * `@Public()` sits on each method rather than on the class, for the reason
 * `HealthController` gives: a route added here later has to opt out of
 * authentication deliberately, not inherit an exemption nobody chose for it.
 *
 * The response carries only the fields in `services.types.ts` — no `is_active`,
 * no timestamps, no internal identifiers beyond the ids the client needs to ask
 * follow-up questions with. That narrowing happens in the repository's
 * projection, so this layer has nothing to leak.
 */
@Controller('services')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  /**
   * Declared before `:id` deliberately. Fastify's router prefers a static
   * segment over a parameter, so the order is not load-bearing today — but a
   * reader should not have to know that to be sure `/services/categories` is
   * not being parsed as a service id.
   */
  @Public()
  @Get('categories')
  async listCategories(
    @Query() query: CategoryListQueryDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CursorPage<ServiceCategoryResponse>> {
    applyCatalogueCacheHeaders(reply);
    return this.services.listCategories(query, parseAcceptLanguage(acceptLanguage));
  }

  @Public()
  @Get()
  async listServices(
    @Query() query: ServiceListQueryDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CursorPage<ServiceResponse>> {
    applyCatalogueCacheHeaders(reply);
    return this.services.listServices(query, parseAcceptLanguage(acceptLanguage));
  }

  @Public()
  @Get(':id')
  async getService(
    @Param() params: ServiceIdParamsDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ServiceResponse> {
    applyCatalogueCacheHeaders(reply);
    return this.services.getServiceById(params.id, parseAcceptLanguage(acceptLanguage));
  }
}

/**
 * **`Vary: Accept-Language` is not optional here.**
 *
 * The response body is translated, so `Cache-Control: public` without it tells
 * every shared cache between the server and the phone that one stored copy
 * serves everybody — and the first Azerbaijani response would then be handed to
 * a caller who asked for English, for the next minute. `Vary` is what makes the
 * language part of the cache key rather than an accident of who arrived first.
 *
 * `public` rather than `private` because nothing in a catalogue response is
 * scoped to a user; there is no per-caller content for an intermediary to leak.
 * The max-age matches the server-side TTL, so a client and the server never
 * disagree by more than the window either one is already tolerating.
 */
function applyCatalogueCacheHeaders(reply: FastifyReply): void {
  reply.header('cache-control', `public, max-age=${String(CATALOGUE_CACHE_TTL_SECONDS)}`);
  reply.header('vary', 'Accept-Language');
}
