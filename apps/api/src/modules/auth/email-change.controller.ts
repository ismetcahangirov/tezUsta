import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from './auth.types';
import { CurrentActor } from './current-actor.decorator';
import type { EmailChangeStarted } from './email-change.service';
import { EmailChangeService } from './email-change.service';
import { EmailChangeConfirmDto, EmailChangeStartDto } from './email-change.schema';

/**
 * A signed-in customer or master changes their sign-in address (#514,
 * [ADR-0074](docs/decisions/ADR-0074-account-recovery-and-email-change.md) § 1).
 *
 * Authenticated, with no role requirement: an account that has not chosen a
 * role yet still owns its address. App sessions only; the web subscription
 * page does not opt in.
 *
 * Both routes are rate-limited **per user**, under the two policies sign-in
 * uses: starting a change mails two addresses, so it spends the
 * `otp-request` budget; confirming checks codes, so it spends `sign-in`'s.
 * The per-change attempt cap inside the service bounds guessing one pair.
 */
@Controller('me/email-change')
export class EmailChangeController {
  constructor(private readonly changes: EmailChangeService) {}

  @Post()
  @HttpCode(200)
  @RateLimit({ policy: 'otp-request', identifier: rateLimitByUser })
  start(
    @CurrentActor() actor: Actor,
    @Body() body: EmailChangeStartDto,
  ): Promise<EmailChangeStarted> {
    return this.changes.start(actor.userId, body.newEmail);
  }

  /** `204`: every session, this one included, has just been revoked. The client signs in again. */
  @Post('confirm')
  @HttpCode(204)
  @RateLimit({ policy: 'sign-in', identifier: rateLimitByUser })
  async confirm(@CurrentActor() actor: Actor, @Body() body: EmailChangeConfirmDto): Promise<void> {
    await this.changes.confirm(actor.userId, body.currentCode, body.newCode);
  }
}
