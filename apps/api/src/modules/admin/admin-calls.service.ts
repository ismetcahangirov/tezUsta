import { Injectable } from '@nestjs/common';
import type { AdminCallRecord, CursorPage } from '@tezusta/types';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { CallRecordsService } from '../calls/call-records.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import type { ListAdminCallsQuery } from './admin-calls.schema';

/** The audit verb for one read of `GET /admin/calls`. */
export const ADMIN_CALLS_LIST_ACTION = 'call.list';

/**
 * An admin reading call records (issue #186) — and **every read is audited**.
 *
 * Who rang whom about which job, when and for how long is personal data about
 * two people, and `docs/engineering/security.md` is explicit that for an admin
 * "a read is an action": actor, action, target, reason, timestamp. So each
 * successful request writes one `admin_audit_log` row, after the read, the
 * ordering `AdminOrderPhotosService` uses — a read that failed disclosed
 * nothing, and a row for it would record a disclosure that did not happen.
 *
 * **The target is the narrowest thing the admin asked about**: the order if
 * they filtered by one, else the master, else the customer. An unscoped
 * listing has no single subject, and `target_id` is a non-null uuid, so it is
 * recorded as a `call_list` target with an id minted for that read — unique,
 * so it never groups with anything, and the investigation view ("everything
 * this admin did") is by actor anyway.
 *
 * **The filters go in `reason`**, as ids, statuses and timestamps only — the
 * same values the admin typed, never a name or a phone number. It is the one
 * column that can say *what* was looked at, which is the question an audit
 * of a read has to answer.
 */
@Injectable()
export class AdminCallsService {
  constructor(
    private readonly records: CallRecordsService,
    private readonly admins: AdminRepository,
  ) {}

  async list(admin: AdminActor, query: ListAdminCallsQuery): Promise<CursorPage<AdminCallRecord>> {
    const page = await this.records.forAdmin(
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

    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: ADMIN_CALLS_LIST_ACTION,
      ...auditTarget(query),
      reason: describeFilters(query),
    });

    return page;
  }
}

function auditTarget(query: ListAdminCallsQuery): { targetType: string; targetId: string } {
  if (query.orderId !== undefined) {
    return { targetType: 'order', targetId: query.orderId };
  }
  if (query.masterId !== undefined) {
    return { targetType: 'master', targetId: query.masterId };
  }
  if (query.customerId !== undefined) {
    return { targetType: 'customer', targetId: query.customerId };
  }
  return { targetType: 'call_list', targetId: uuidV7() };
}

/**
 * `orderId=…; status=…; …`, in a fixed order, naming only what was set. Every
 * value was validated as a uuid, an enum member, an ISO timestamp or a number,
 * so the whole string is bounded well under the column's 600 characters.
 */
export function describeFilters(query: ListAdminCallsQuery): string {
  const parts: string[] = [];
  const add = (name: string, value: string | number | undefined): void => {
    if (value !== undefined) {
      parts.push(`${name}=${String(value)}`);
    }
  };
  add('orderId', query.orderId);
  add('masterId', query.masterId);
  add('customerId', query.customerId);
  add('status', query.status);
  add('from', query.from);
  add('to', query.to);
  add('limit', query.limit);
  if (query.cursor !== undefined) {
    parts.push('cursor=yes');
  }
  return parts.join('; ');
}
