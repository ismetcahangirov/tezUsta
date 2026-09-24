import { Controller, Get } from '@nestjs/common';
import type { AdminMe } from '@tezusta/types';

import { AnyAdmin } from './admin-permission.decorator';
import type { AdminActor } from './admin.types';
import { CurrentAdmin } from './current-admin.decorator';

/**
 * Who the signed-in admin is and what they may do (ADR-0043 § 1).
 *
 * The panel reads `permissions` to decide which navigation to show. That is a
 * convenience and never the check — every handler is guarded on the server
 * whatever the panel hides.
 */
@Controller('admin')
export class AdminIdentityController {
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
}
