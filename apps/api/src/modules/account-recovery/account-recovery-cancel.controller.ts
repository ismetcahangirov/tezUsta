import { randomBytes } from 'node:crypto';

import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { Public } from '../auth/public.decorator';
import { cancelPagePolicy, renderCancelPage } from './account-recovery-cancel-page';
import { CancelByLinkDto } from './account-recovery.schema';
import { AccountRecoveryService } from './account-recovery.service';

/**
 * The cancel link in the notice the old address receives when a recovery's
 * hold starts (#515, ADR-0074 § 2).
 *
 * Both routes are `@Public()`: whoever follows the link may have no session,
 * and is exactly the person who may not be able to sign in. The `POST` is
 * rate-limited per IP under sign-in's policy, which is what guessing a token
 * would be; a 256-bit token cannot be guessed anyway, and every answer is the
 * same `204`.
 */
@Public()
@Controller('account-recovery/cancel')
export class AccountRecoveryCancelController {
  constructor(private readonly recoveries: AccountRecoveryService) {}

  @Get()
  page(@Res({ passthrough: true }) reply: FastifyReply): string {
    const nonce = randomBytes(16).toString('base64');
    void reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', cancelPagePolicy(nonce))
      .header('Cache-Control', 'no-store');
    return renderCancelPage(nonce);
  }

  /** `204` whatever the token names: unknown, used, spent and good look the same. */
  @Post()
  @HttpCode(204)
  @RateLimit({ policy: 'sign-in' })
  async cancel(@Body() body: CancelByLinkDto): Promise<void> {
    await this.recoveries.cancelByLink(body.token);
  }
}
