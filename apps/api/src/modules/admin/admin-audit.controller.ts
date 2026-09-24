import { Controller, Get, Query } from '@nestjs/common';
import type { AdminAuditEntry, CursorPage } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { listAdminAuditLogQuerySchema } from './admin-audit.schema';
import { AdminAuditService } from './admin-audit.service';
import { RequireAdminPermission } from './admin-permission.decorator';

class ListAdminAuditLogQueryDto extends createZodDto(listAdminAuditLogQuerySchema) {}

/**
 * The audit log, for `super_admin` (ADR-0043 § 1, `audit.read`).
 *
 * Reading the log is not itself logged: it holds no personal data beyond the
 * admins' own names and the ids of what they acted on, and a log of reads of
 * the log would grow with every page an investigator turns.
 */
@Controller('admin/audit-log')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @RequireAdminPermission('audit.read')
  @Get()
  list(@Query() query: ListAdminAuditLogQueryDto): Promise<CursorPage<AdminAuditEntry>> {
    return this.audit.list(query);
  }
}
