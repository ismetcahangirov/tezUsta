import { Controller, Get, Query } from '@nestjs/common';
import type { AdminDashboard } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { adminDashboardQuerySchema } from './admin-dashboard.schema';
import { AdminDashboardService } from './admin-dashboard.service';
import type { AdminActor } from './admin.types';
import { RequireAdminPermission } from './admin-permission.decorator';
import { CurrentAdmin } from './current-admin.decorator';

class AdminDashboardQueryDto extends createZodDto(adminDashboardQuerySchema) {}

/**
 * The operational dashboard (`admin-flow.md` § 6, issue #246) — every role
 * holds `dashboard.read`. Counts only: no order or position leaves this
 * route, so reading it is not audited.
 *
 * The one exception is the reports section (#330): it names people reported
 * more than once, so it is filled only for an admin who holds
 * `reports.read`, and is `null` for everyone else.
 */
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @RequireAdminPermission('dashboard.read')
  @Get()
  read(
    @CurrentAdmin() admin: AdminActor,
    @Query() query: AdminDashboardQueryDto,
  ): Promise<AdminDashboard> {
    return this.dashboard.read(query, { reports: admin.permissions.includes('reports.read') });
  }
}
