import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { Public } from '../auth/public.decorator';
import { CallReconciliationService } from './call-reconciliation.service';

/**
 * A delivery that did not prove it came from the media server — no header, a
 * bad signature, a body that does not match its signed hash, or a body that
 * arrived as something other than `application/webhook+json` and so could
 * not be checked at all. One answer for every case: a forger learns nothing
 * about which check they failed.
 */
class WebhookRejectedError extends AppError {
  constructor() {
    super(ERROR_CODES.UNAUTHORIZED, 'Authentication required.', 401);
    this.name = 'WebhookRejectedError';
    Object.setPrototypeOf(this, WebhookRejectedError.prototype);
  }
}

/**
 * `POST /webhooks/livekit` — the media server telling us a room finished
 * (issue #186).
 *
 * **Public, and unauthenticated until the signature is checked.** `@Public()`
 * only takes the consumer guard out of the way; the authentication is the
 * provider's signature check, and it runs before anything reads the database
 * (`CallReconciliationService.applyWebhook`). A delivery that fails it is a
 * 401 and changes nothing.
 *
 * `ignored` — a genuine event this system does not act on — is a 200, not an
 * error: LiveKit retries anything else, and retrying an event nobody wants is
 * load for nothing.
 *
 * **Bounded by body size, not by a rate limit.** The only legitimate sender is
 * the media server, from one address, and it sends in bursts exactly when the
 * system is busiest — a per-IP budget would drop real room-finished events at
 * the moment they matter, and the webhook is only an optimisation over the
 * reaper anyway. What an attacker can spend here is one HMAC or JWT check over
 * at most `WEBHOOK_BODY_LIMIT_BYTES`, with no database read before it passes.
 */
@Public()
@Controller('webhooks/livekit')
export class CallMediaWebhookController {
  constructor(private readonly reconciliation: CallReconciliationService) {}

  @HttpCode(200)
  @Post()
  async receive(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<{ readonly received: true }> {
    // Anything but the raw string `WebhookBodyParser` produces was parsed by
    // somebody else, and its signature can no longer be checked.
    if (typeof body !== 'string') {
      throw new WebhookRejectedError();
    }

    const outcome = await this.reconciliation.applyWebhook({ body, authorization });
    if (outcome === 'invalid') {
      throw new WebhookRejectedError();
    }
    return { received: true };
  }
}
