import { Controller, Get, Query } from '@nestjs/common';
import type { AdminCallRecord, CursorPage } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { listAdminCallsQuerySchema } from './admin-calls.schema';
import { AdminCallsService } from './admin-calls.service';
import type { AdminActor } from './admin.types';
import { RequireAdminPermission } from './admin-permission.decorator';
import { CurrentAdmin } from './current-admin.decorator';

class ListAdminCallsQueryDto extends createZodDto(listAdminCallsQuerySchema) {}

/**
 * `GET /admin/calls` — every call record, filterable and cursor-paginated
 * (issue #186).
 *
 * No `@Roles()` and no `@Public()`, like every admin controller: the route is
 * authenticated by `AdminAuthenticationGuard` because of its `/admin` path, a
 * consumer token fails the admin audience check, and
 * `admin-verification.e2e.test.ts` walks the live route table to prove this
 * route is among the guarded ones.
 *
 * **What an admin sees is who, when, how long and the outcome** — profile ids
 * and display names, never a phone number, an account id or a room token
 * (`CallRecordsService`). There is nothing else to see: calls are not
 * recorded (ADR-0034 § 2).
 *
 * **Every read is audited** (`AdminCallsService`): one `admin_audit_log` row
 * per request, with the filters used.
 */
@Controller('admin/calls')
export class AdminCallsController {
  constructor(private readonly calls: AdminCallsService) {}

  @RequireAdminPermission('calls.read')
  @Get()
  async list(
    @CurrentAdmin() admin: AdminActor,
    @Query() query: ListAdminCallsQueryDto,
  ): Promise<CursorPage<AdminCallRecord>> {
    return this.calls.list(admin, query);
  }
}
