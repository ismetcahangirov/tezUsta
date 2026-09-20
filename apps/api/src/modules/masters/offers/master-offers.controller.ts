import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { AcceptedOffer, Address, DeclinedOffer, MasterOffer } from '@tezusta/types';

import { RateLimit } from '../../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../../auth/auth.types';
import { CurrentActor } from '../../auth/current-actor.decorator';
import { Roles } from '../../auth/roles.decorator';
import { offerIdParamsSchema, offerResponseSchema } from './master-offers.schema';
import { MasterOffersService } from './master-offers.service';

class OfferIdParamsDto extends createZodDto(offerIdParamsSchema) {}
class OfferResponseDto extends createZodDto(offerResponseSchema) {}

/**
 * The master's offer feed, decline and accept (issue #101).
 *
 * `/masters/me/offers`, with no master id anywhere in it — the responding
 * master is the caller, resolved from the actor, for the reason
 * `master-location.controller.ts` gives: a route that can be *asked* whose
 * offers to act on is a route that can be asked the wrong name.
 *
 * Every route carries `@Roles('master')`. That is not the authorization — a
 * role claim in a token is a cache, not an authority
 * (`docs/architecture/authentication.md`) — it is the cheap first filter, and
 * the service re-reads verification and the whole dispatch predicate from the
 * database before anything is claimed.
 *
 * **Every route is rate-limited, under two policies rather than one.** Accept
 * and decline carry `offer-response`, because on a first-accept-wins model an
 * unthrottled `accept` loop is how one scripted client takes every job in the
 * city. The feed carries `offer-feed`, which is sized from the **polling
 * interval** instead: a master polling it is doing exactly what the product
 * asks of them until the realtime channel (EPIC 9) arrives, so the budget is
 * set where honest polling cannot reach it (five seconds apart, with
 * headroom) rather than where abuse begins. One shared policy could do
 * neither job — see `MASTER_OFFER_FEED_RATE_LIMIT_PER_USER_HOUR`.
 *
 * That the read is cheap is not a reason to leave it unbounded, and the
 * reverse argument is what made this route unlimited at first: the feed was
 * costing a photo query per card, so "it is only a keyset read" was not true
 * either. It is two statements now — the offers off
 * `order_offers_master_status_created_idx`, bounded to `MAX_FEED_OFFERS`, and
 * one batched photo read — and it is still bounded.
 */
@Controller('masters/me/offers')
export class MasterOffersController {
  constructor(private readonly offers: MasterOffersService) {}

  /**
   * The caller's own live offers, newest first.
   *
   * **No cursor.** A feed is a live working set rather than a history: an
   * offer that scrolled out of view has expired by the time anyone asks for
   * page two, so a cursor would be an API for reading offers that no longer
   * exist.
   */
  @Roles('master')
  @RateLimit({ policy: 'offer-feed', identifier: rateLimitByUser })
  @Get()
  async list(@CurrentActor() actor: Actor): Promise<MasterOffer[]> {
    return this.offers.listOwn(actor);
  }

  /**
   * Declines an offer. Permanent — this master is never offered this order
   * again, in any later round (ADR-0009).
   *
   * `@HttpCode(200)` because Nest answers a `@Post()` with 201 by default and
   * nothing is created; a decline is a statement about a row that already
   * exists.
   */
  @Roles('master')
  @RateLimit({ policy: 'offer-response', identifier: rateLimitByUser })
  @HttpCode(200)
  @Post(':offerId/decline')
  async decline(
    @CurrentActor() actor: Actor,
    @Param() params: OfferIdParamsDto,
    @Body() _body: OfferResponseDto,
  ): Promise<DeclinedOffer> {
    return this.offers.decline(actor, params.offerId);
  }

  /**
   * Accepts an offer — the race ADR-0009 calls the single most important
   * invariant in the backend.
   *
   * `@HttpCode(200)` for the same reason as decline, and it matters more here:
   * a 201 would tell every client and every proxy that a resource came into
   * being, when what happened is that an existing order changed hands. The
   * thing that did come into being is an assignment, and it is addressed by
   * the order that already existed.
   */
  @Roles('master')
  @RateLimit({ policy: 'offer-response', identifier: rateLimitByUser })
  @HttpCode(200)
  @Post(':offerId/accept')
  async accept(
    @CurrentActor() actor: Actor,
    @Param() params: OfferIdParamsDto,
    @Body() _body: OfferResponseDto,
  ): Promise<AcceptedOffer> {
    return this.offers.accept(actor, params.offerId);
  }

  /**
   * The customer's exact address, for the master who won this offer.
   *
   * A **separate read**, not a field that was always on the card: the address
   * is revealed at the accept and to nobody else
   * (`docs/product/master-flow.md`). It exists alongside the accept response —
   * which also carries it — so a master who restarts their app does not lose
   * the only copy of where they are driving.
   */
  @Roles('master')
  @Get(':offerId/address')
  async address(@CurrentActor() actor: Actor, @Param() params: OfferIdParamsDto): Promise<Address> {
    return this.offers.getAddress(actor, params.offerId);
  }
}
