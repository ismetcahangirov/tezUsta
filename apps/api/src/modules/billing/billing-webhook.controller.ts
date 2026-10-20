import { Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { WebhookHeaders } from '../../infra/billing/billing.types';
import { Public } from '../auth/public.decorator';
import { rawBodyOf } from './billing-raw-body.hook';
import { billingWebhookParamsSchema } from './billing.schema';
import { BillingWebhookService } from './billing-webhook.service';

class BillingWebhookParamsDto extends createZodDto(billingWebhookParamsSchema) {}

/**
 * A delivery that did not prove it came from the provider. One answer for
 * every reason, as the LiveKit webhook gives: a forger learns nothing about
 * which check failed.
 */
class BillingWebhookRejectedError extends AppError {
  constructor() {
    super(ERROR_CODES.UNAUTHORIZED, 'Authentication required.', 401);
    this.name = 'BillingWebhookRejectedError';
    Object.setPrototypeOf(this, BillingWebhookRejectedError.prototype);
  }
}

/**
 * `POST /webhooks/billing/:provider` — the billing provider telling us what
 * happened to a payment (issue #323).
 *
 * **Public, and unauthenticated until the signature is checked**, like
 * `POST /webhooks/livekit`: `@Public()` only moves the consumer guard aside;
 * the authentication is the provider's signature over the raw body, checked
 * before anything is read. A provider name other than the configured one is a
 * 404, so the URL says nothing about which providers exist.
 *
 * 200 only after every write has committed. A genuine event subscriptions do
 * not act on is a 200 too, so the provider stops retrying it.
 *
 * **Bounded by body size, not a rate limit**, for the LiveKit webhook's
 * reason: the one legitimate sender delivers in bursts, and a per-IP budget
 * would drop real payments when they matter most. What a forger can spend is
 * one HMAC over at most 64 KiB, with no database read before it passes.
 */
@Public()
@Controller('webhooks/billing')
export class BillingWebhookController {
  constructor(private readonly webhooks: BillingWebhookService) {}

  @HttpCode(200)
  @Post(':provider')
  async receive(
    @Param() params: BillingWebhookParamsDto,
    @Req() request: FastifyRequest,
    @Headers() headers: WebhookHeaders,
  ): Promise<{ readonly received: true }> {
    const outcome = await this.webhooks.apply(params.provider, rawBodyOf(request), headers);
    if (outcome === 'not_found') {
      throw new NotFoundError();
    }
    if (outcome === 'invalid') {
      throw new BillingWebhookRejectedError();
    }
    return { received: true };
  }
}
