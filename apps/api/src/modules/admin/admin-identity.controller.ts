import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { AdminMe } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { adminPasswordChangeSchema } from './admin-auth.schema';
import { AdminPasswordService } from './admin-password.service';
import { AnyAdmin } from './admin-permission.decorator';
import type { AdminActor } from './admin.types';
import { CurrentAdmin } from './current-admin.decorator';

class AdminPasswordChangeDto extends createZodDto(adminPasswordChangeSchema) {}

/**
 * Who the signed-in admin is and what they may do (ADR-0043 § 1).
 *
 * The panel reads `permissions` to decide which navigation to show. That is a
 * convenience and never the check — every handler is guarded on the server
 * whatever the panel hides.
 */
@Controller('admin')
export class AdminIdentityController {
  constructor(private readonly passwords: AdminPasswordService) {}

  @AnyAdmin()
  @Get('me')
  me(@CurrentAdmin() admin: AdminActor): AdminMe {
    return {
      id: admin.adminUserId,
      email: admin.email,
      displayName: admin.displayName,
      roles: admin.roles,
      permissions: admin.permissions,
    };
  }

  /**
   * Changes your own password (#329): the current one and a fresh code, never
   * the session alone. Every other session of yours ends; this one stays.
   */
  @AnyAdmin()
  @HttpCode(204)
  @Post('me/password')
  async changePassword(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: AdminPasswordChangeDto,
  ): Promise<void> {
    await this.passwords.changeOwn(admin, body);
  }
}
