import { Controller, Get, Query } from '@nestjs/common';
import type { AdminDashboard } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { adminDashboardQuerySchema } from './admin-dashboard.schema';
import { AdminDashboardService } from './admin-dashboard.service';
import { RequireAdminPermission } from './admin-permission.decorator';

class AdminDashboardQueryDto extends createZodDto(adminDashboardQuerySchema) {}

/**
 * The operational dashboard (`admin-flow.md` § 6, issue #246) — every role
 * holds `dashboard.read`. Counts only: no order, person or position leaves
 * this route, so reading it is not audited.
 */
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @RequireAdminPermission('dashboard.read')
  @Get()
  read(@Query() query: AdminDashboardQueryDto): Promise<AdminDashboard> {
    return this.dashboard.read(query);
  }
}
