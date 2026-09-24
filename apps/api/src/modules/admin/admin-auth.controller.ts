import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { AdminSetupStart } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import {
  adminSetupCompleteSchema,
  adminSetupStartSchema,
  setupTokenIdentifier,
} from './admin-auth.schema';
import { PublicAdminRoute } from './admin-public.decorator';
import { AdminSetupService } from './admin-setup.service';

class AdminSetupStartDto extends createZodDto(adminSetupStartSchema) {}
class AdminSetupCompleteDto extends createZodDto(adminSetupCompleteSchema) {}

/**
 * The admin credential surface (ADR-0043 § 3–4): the routes an admin reaches
 * **before** holding a session. Each is `@PublicAdminRoute()` — skipping the
 * admin guards and nothing else — authenticates its own caller, and carries
 * its own rate limit.
 */
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly setup: AdminSetupService) {}

  /** Checks a setup link and offers an authenticator secret. Writes nothing. */
  @PublicAdminRoute()
  @RateLimit({ policy: 'admin-setup', identifier: setupTokenIdentifier })
  @HttpCode(200)
  @Post('setup/start')
  start(@Body() body: AdminSetupStartDto): Promise<AdminSetupStart> {
    return this.setup.start(body.token);
  }

  /** Sets the password and proves the authenticator; spends the link. */
  @PublicAdminRoute()
  @RateLimit({ policy: 'admin-setup', identifier: setupTokenIdentifier })
  @HttpCode(204)
  @Post('setup/complete')
  async complete(@Body() body: AdminSetupCompleteDto): Promise<void> {
    await this.setup.complete(body);
  }
}
