import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { AdminReportDetail, AdminReportSummary, CursorPage } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { AdminActor } from './admin.types';
import { RequireAdminPermission } from './admin-permission.decorator';
import {
  claimReportSchema,
  closeReportSchema,
  listReportsQuerySchema,
  reportIdParamsSchema,
} from './admin-reports.schema';
import { AdminReportsService } from './admin-reports.service';
import { CurrentAdmin } from './current-admin.decorator';

class ListReportsQueryDto extends createZodDto(listReportsQuerySchema) {}
class ReportIdParamsDto extends createZodDto(reportIdParamsSchema) {}
class ClaimReportDto extends createZodDto(claimReportSchema) {}
class CloseReportDto extends createZodDto(closeReportSchema) {}

/**
 * The report queue (#330, ADR-0053): `reports.read` to see it,
 * `reports.handle` to claim and close. Support, moderator and super_admin
 * hold both.
 */
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly reports: AdminReportsService) {}

  @RequireAdminPermission('reports.read')
  @Get()
  list(@Query() query: ListReportsQueryDto): Promise<CursorPage<AdminReportSummary>> {
    return this.reports.list(query);
  }

  @RequireAdminPermission('reports.read')
  @Get(':id')
  detail(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: ReportIdParamsDto,
  ): Promise<AdminReportDetail> {
    return this.reports.detail(admin, params.id);
  }

  @RequireAdminPermission('reports.handle')
  @HttpCode(204)
  @Post(':id/claim')
  async claim(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: ReportIdParamsDto,
    @Body() _body: ClaimReportDto,
  ): Promise<void> {
    await this.reports.claim(admin, params.id);
  }

  @RequireAdminPermission('reports.handle')
  @HttpCode(204)
  @Post(':id/close')
  async close(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: ReportIdParamsDto,
    @Body() body: CloseReportDto,
  ): Promise<void> {
    await this.reports.close(admin, params.id, body);
  }
}
