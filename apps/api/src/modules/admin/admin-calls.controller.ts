import { Controller, Get, Query } from '@nestjs/common';
import type { AdminCallRecord, CursorPage } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { CallRecordsService } from '../calls/call-records.service';
import { listAdminCallsQuerySchema } from './admin-calls.schema';

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
 * Not written to `admin_audit_log`. The audit trail records admin *actions*
 * and the reads whose attempt is itself a disclosure — a photograph of
 * somebody's home, an identity document. A list of call times between two
 * parties to a job is the metadata the order screen already implies; if it
 * is ever judged otherwise, the audit write belongs here, in the controller's
 * service, and needs its action added to the table's CHECK.
 */
@Controller('admin/calls')
export class AdminCallsController {
  constructor(private readonly records: CallRecordsService) {}

  @Get()
  async list(@Query() query: ListAdminCallsQueryDto): Promise<CursorPage<AdminCallRecord>> {
    return this.records.forAdmin(
      {
        orderId: query.orderId,
        status: query.status,
        startedFrom: query.from === undefined ? undefined : new Date(query.from),
        startedBefore: query.to === undefined ? undefined : new Date(query.to),
        masterId: query.masterId,
        customerId: query.customerId,
      },
      query,
    );
  }
}
