import { Injectable } from '@nestjs/common';
import type { AdminCallParty, AdminCallRecord, CallRecord, CursorPage } from '@tezusta/types';

import type { CallRow } from '../../infra/database/schema/calls';
import type { Actor } from '../auth/auth.types';
import { ConversationsService } from '../orders/conversations.service';
import { decodeCallCursor, encodeCallCursor } from './call-cursor';
import { CallsRepository } from './calls.repository';
import type { CallRecordFilter, CallRecordRow } from './calls.repository';
import { present } from './calls.service';

/**
 * Call records: who rang whom about which order, when, for how long, and how
 * it ended (issue #186). **Never what was said** — nothing is recorded
 * (ADR-0034 § 2), and adding recording would be a new ADR and a legal
 * question, not a column.
 *
 * Two readers, one query. A party reads their own calls on one order; an
 * admin reads everybody's, filtered. Both go through
 * `CallsRepository.listRecords`, which reads the parties' names in the same
 * statement, so a page is one round trip whatever its size.
 *
 * **Neither presentation carries a phone number, an account id or a room
 * token** — the fields are built by hand below from the row, and the row's
 * account columns are simply not copied. The e2e suite asserts the absence on
 * both surfaces.
 */
@Injectable()
export class CallRecordsService {
  constructor(
    private readonly calls: CallsRepository,
    private readonly conversations: ConversationsService,
  ) {}

  /**
   * The calls on one order that this account was on, newest first, each
   * presented as theirs.
   *
   * **The conversation's party rule, not a copy of it**
   * (`ConversationsService.requireParty`): the order's customer or its
   * currently assigned master, re-read from the database, and a 404 for
   * anybody else — including for an order that does not exist, so the route
   * is not an oracle for order ids. Readable after the order is over, as the
   * conversation is: a dispute raised after completion wants both records.
   *
   * **Filtered to this account's own calls**, not every call on the order. A
   * re-dispatched order can carry calls between the customer and a master who
   * is no longer on it; the customer was a party to those and sees them, the
   * new master was not and does not.
   */
  async forParty(
    actor: Actor,
    orderId: string,
    query: { readonly cursor?: string | undefined; readonly limit: number },
  ): Promise<CursorPage<CallRecord>> {
    await this.conversations.requireParty(actor, orderId);

    const page = await this.calls.listRecords({
      filter: { orderId, partyUserId: actor.userId },
      limit: query.limit,
      afterCallId: decodeCallCursor(query.cursor),
    });

    return {
      items: page.rows.map((row) => presentForParty(row, actor.userId)),
      nextCursor: page.nextCursorId === null ? null : encodeCallCursor(page.nextCursorId),
    };
  }

  /** Every call, filtered, newest first — `GET /admin/calls`. */
  async forAdmin(
    filter: CallRecordFilter,
    query: { readonly cursor?: string | undefined; readonly limit: number },
  ): Promise<CursorPage<AdminCallRecord>> {
    const page = await this.calls.listRecords({
      filter,
      limit: query.limit,
      afterCallId: decodeCallCursor(query.cursor),
    });

    return {
      items: page.rows.map(presentForAdmin),
      nextCursor: page.nextCursorId === null ? null : encodeCallCursor(page.nextCursorId),
    };
  }
}

/**
 * Whole seconds between the answer and the end, **from the server's own
 * timestamps** — never a client's claim of how long it talked. Null for a
 * call nobody answered and for an answered call still live.
 */
export function callDurationSeconds(call: CallRow): number | null {
  if (call.answeredAt === null || call.endedAt === null) {
    return null;
  }
  return Math.max(0, Math.floor((call.endedAt.getTime() - call.answeredAt.getTime()) / 1000));
}

function presentForParty(row: CallRecordRow, viewerUserId: string): CallRecord {
  const role = row.call.callerUserId === viewerUserId ? 'caller' : 'callee';
  const names = { customer: row.customerName, master: row.masterName };
  return { ...present(row.call, role, names), durationSeconds: callDurationSeconds(row.call) };
}

function presentForAdmin(row: CallRecordRow): AdminCallRecord {
  const { call } = row;
  const party = (kind: AdminCallParty['kind'], profileId: string): AdminCallParty => ({
    kind,
    profileId,
    displayName: kind === 'customer' ? row.customerName : row.masterName,
  });

  return {
    id: call.id,
    orderId: call.orderId,
    caller: party(call.callerKind, call.callerId),
    callee: party(call.calleeKind, call.calleeId),
    status: call.status,
    endReason: call.endReason,
    startedAt: call.startedAt.toISOString(),
    answeredAt: call.answeredAt === null ? null : call.answeredAt.toISOString(),
    endedAt: call.endedAt === null ? null : call.endedAt.toISOString(),
    durationSeconds: callDurationSeconds(call),
  };
}
