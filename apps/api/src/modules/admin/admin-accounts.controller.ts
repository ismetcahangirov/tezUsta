import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import type { AdminAccount, AdminInvitationIssued } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { AdminActor } from './admin.types';
import {
  adminAccountIdParamsSchema,
  adminAccountReasonSchema,
  inviteAdminSchema,
  setAdminRolesSchema,
} from './admin-accounts.schema';
import { AdminAccountsService } from './admin-accounts.service';
import { RequireAdminPermission } from './admin-permission.decorator';
import { CurrentAdmin } from './current-admin.decorator';

class AdminAccountIdParamsDto extends createZodDto(adminAccountIdParamsSchema) {}
class AdminAccountReasonDto extends createZodDto(adminAccountReasonSchema) {}
class InviteAdminDto extends createZodDto(inviteAdminSchema) {}
class SetAdminRolesDto extends createZodDto(setAdminRolesSchema) {}

/**
 * Admin account management (ADR-0043 § 1, § 3) — `admins.manage`, which only
 * `super_admin` holds. The setup link in an invitation or reset answer is
 * shown once and never stored in clear.
 */
@Controller('admin/admins')
@RequireAdminPermission('admins.manage')
export class AdminAccountsController {
  constructor(private readonly accounts: AdminAccountsService) {}

  @Get()
  list(): Promise<AdminAccount[]> {
    return this.accounts.list();
  }

  @Post()
  invite(
    @CurrentAdmin() admin: AdminActor,
    @Body() body: InviteAdminDto,
  ): Promise<AdminInvitationIssued> {
    return this.accounts.invite(admin, body);
  }

  @HttpCode(200)
  @Post(':id/disable')
  disable(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminAccountIdParamsDto,
    @Body() body: AdminAccountReasonDto,
  ): Promise<AdminAccount> {
    return this.accounts.disable(admin, params.id, body.reason);
  }

  @HttpCode(200)
  @Post(':id/enable')
  enable(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminAccountIdParamsDto,
    @Body() body: AdminAccountReasonDto,
  ): Promise<AdminAccount> {
    return this.accounts.enable(admin, params.id, body.reason);
  }

  @Put(':id/roles')
  setRoles(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminAccountIdParamsDto,
    @Body() body: SetAdminRolesDto,
  ): Promise<AdminAccount> {
    return this.accounts.setRoles(admin, params.id, body.roles, body.reason);
  }

  @HttpCode(200)
  @Post(':id/reset-second-factor')
  resetSecondFactor(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminAccountIdParamsDto,
    @Body() body: AdminAccountReasonDto,
  ): Promise<AdminInvitationIssued> {
    return this.accounts.resetSecondFactor(admin, params.id, body.reason);
  }
}
