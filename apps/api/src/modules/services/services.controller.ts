import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import type { CursorPage, Service, ServiceCategory, ServicePriceRange } from '@tezusta/types';
import type { FastifyReply } from 'fastify';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { parseAcceptLanguage } from '../../common/i18n/accept-language';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import { Public } from '../auth/public.decorator';
import {
  catalogueListQuerySchema,
  serviceIdParamsSchema,
  serviceListQuerySchema,
} from './services.schema';
import { CATALOGUE_CACHE_TTL_SECONDS, ServicesService } from './services.service';

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
 * The response carries only the fields the `@tezusta/types` contract names — no
 * `is_active`, no timestamps, no internal identifiers beyond the ids the client
 * needs to ask follow-up questions with. That narrowing happens in the
 * repository's projection, so this layer has nothing to leak.
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
  ): Promise<CursorPage<ServiceCategory>> {
    const page = await this.services.listCategories(query, parseAcceptLanguage(acceptLanguage));
    applyCatalogueCacheHeaders(reply);
    return page;
  }

  @Public()
  @Get()
  async listServices(
    @Query() query: ServiceListQueryDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CursorPage<Service>> {
    const page = await this.services.listServices(query, parseAcceptLanguage(acceptLanguage));
    applyCatalogueCacheHeaders(reply);
    return page;
  }

  @Public()
  @Get(':id')
  async getService(
    @Param() params: ServiceIdParamsDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Service> {
    const service = await this.services.getServiceById(
      params.id,
      parseAcceptLanguage(acceptLanguage),
    );
    applyCatalogueCacheHeaders(reply);
    return service;
  }

  /**
   * The indicative price range (issue #84), `@Public()` for the same reason
   * `GET /services/:id` is
   * ([ADR-0020](docs/decisions/ADR-0020-public-cached-service-catalogue.md)):
   * the answer does not differ by who is asking. It is an aggregate over
   * masters who offer this service, not a row scoped to any caller — the same
   * boundary ADR-0020 draws between "no ownership dimension" and "the moment a
   * response would differ by who is asking, this decision no longer applies".
   * A customer also reaches this step of `docs/product/customer-flow.md`
   * before creating an order, but never before one — requiring a session here
   * would gate a read the answer itself does not need gating.
   *
   * **Deliberately uncached at the HTTP layer.** `applyCatalogueCacheHeaders`
   * is for the other three routes, whose bodies come from `CacheService`'s
   * sixty-second read-through; this one is computed fresh on every call
   * (`ServicesService.getPriceRange`), and telling a shared cache to hold it
   * for a minute would contradict the one property ADR-0013 asks of this read
   * model — that it be live.
   *
   * **`@RateLimit`, unlike the other three catalogue routes.** ADR-0020
   * tolerated no limit there because the first page is answered from cache;
   * that mitigation cannot apply to a route ADR-0013 requires to be computed
   * live on every call, so a budget is the only defence this one has against
   * an unauthenticated caller running a join-plus-aggregate over what will
   * become the schema's largest table
   * (`infra/rate-limit/rate-limit.config.ts`). `rateLimitByUser` identifies a
   * signed-in caller by their token's `sub`; an anonymous caller — the common
   * case, since this route needs no session — makes it return `undefined`,
   * which is legitimate and simply leaves the per-IP half of the policy as
   * the one in force, not a way to bypass it.
   */
  @Public()
  @RateLimit({ policy: 'price-range', identifier: rateLimitByUser })
  @Get(':id/price-range')
  async getPriceRange(@Param() params: ServiceIdParamsDto): Promise<ServicePriceRange> {
    return this.services.getPriceRange(params.id);
  }
}

/**
 * **Called after the handler's work, never before it.**
 *
 * `AllExceptionsFilter` reuses the same `FastifyReply`, and Fastify keeps
 * headers that are already set — so setting these first meant a 404, a 422 and
 * a 500 all went out carrying `Cache-Control: public, max-age=60`. A publicly
 * cacheable 404 is the worst of those: a service an admin is about to activate
 * would read as missing to every intermediary and every client for a minute
 * after it went live, and nothing in the system could invalidate that. Only a
 * successful response is cacheable, so only a successful response says so.
 *
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

  // Appended rather than assigned. `reply.header` replaces, and the day
  // `@fastify/cors` lands with a reflected origin it will have set
  // `Vary: Origin` on exactly these three `Cache-Control: public` routes —
  // silently clobbering it would make a shared cache serve one origin's
  // response to another.
  const existingVary = reply.getHeader('vary');
  const parts = typeof existingVary === 'string' && existingVary.length > 0 ? [existingVary] : [];
  if (!parts.some((part) => part.toLowerCase().includes('accept-language'))) {
    parts.push('Accept-Language');
  }
  reply.header('vary', parts.join(', '));
}
