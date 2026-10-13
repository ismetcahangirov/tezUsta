import { Inject, Injectable } from '@nestjs/common';
import type { OrderStatus } from '@tezusta/types';
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import { adminUsers } from '../../infra/database/schema/admin';
import { conversations } from '../../infra/database/schema/conversations';
import { customers } from '../../infra/database/schema/customers';
import { masters } from '../../infra/database/schema/masters';
import { orders } from '../../infra/database/schema/orders';
import type {
  ReportOutcomeName,
  ReportPartyRoleName,
  ReportReasonName,
  ReportRow,
  ReportStatusName,
} from '../../infra/database/schema/reports';
import { reports } from '../../infra/database/schema/reports';
import { services } from '../../infra/database/schema/services';
import { users } from '../../infra/database/schema/users';

/**
 * The statuses in which an order's work is over, one way or another. A report
 * stays possible for the review window after the order **last** entered one
 * (ADR-0053 § 1) — a dispute reopens it, and its resolution starts the window
 * again.
 */
export const ORDER_ENDED_STATUSES = [
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'RESOLVED',
  'REFUNDED',
  'CANCELLED',
  'NO_MASTER_FOUND',
] as const satisfies readonly OrderStatus[];

export interface ReportOrderContext {
  readonly id: string;
  readonly status: OrderStatus;
  readonly customerId: string;
  readonly masterId: string | null;
  /** When the order entered its current status, if that status ends the work. */
  readonly endedAt: Date | null;
}

export interface AdminReportRow {
  readonly report: ReportRow;
  readonly customerName: string;
  readonly masterName: string;
}

const handlers = alias(adminUsers, 'report_handlers');

/**
 * Reports (#330, ADR-0053): the party's write side and the admin queue's read
 * and write side, over one table.
 */
@Injectable()
export class ReportsRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /** The order a report would be about, or `undefined` for none (or a draft). */
  async findOrderContext(orderId: string): Promise<ReportOrderContext | undefined> {
    const [row] = await this.db
      .select({
        id: orders.id,
        status: orders.status,
        customerId: orders.customerId,
        masterId: orders.masterId,
        // Served by the history's (order_id, created_at) index. The outer
        // columns are written out with their table: in a one-table query
        // Drizzle leaves them unqualified, and an unqualified `id` inside the
        // subquery would be the history row's own.
        // An ended order with no history row for its status — a seed or a
        // legacy row — falls back to its last update, so the window closes
        // rather than staying open for ever.
        endedAt: sql<string | null>`case when ${inArray(orders.status, [...ORDER_ENDED_STATUSES])}
          then coalesce((select max(h.created_at) from order_status_history h
                where h.order_id = orders.id and h.to_status = orders.status), orders.updated_at)
          end`,
      })
      .from(orders)
      .where(and(eq(orders.id, orderId), sql`${orders.status} <> 'DRAFT'`));
    if (row === undefined) {
      return undefined;
    }
    return { ...row, endedAt: row.endedAt === null ? null : new Date(row.endedAt) };
  }

  /**
   * Every master who accepted the order, from their conversations (one per
   * assigned master), with when they left it: the moment their conversation
   * closed, or `null` while it is still open. Served by
   * `conversations_order_created_idx`.
   */
  async listOrderMasters(
    orderId: string,
  ): Promise<{ masterId: string; displayName: string; leftAt: Date | null }[]> {
    const rows = await this.db
      .select({
        masterId: conversations.masterId,
        displayName: masters.displayName,
        stillOpen: sql<boolean>`bool_or(${conversations.closedAt} is null)`,
        lastClosedAt: sql<string | null>`max(${conversations.closedAt})`,
        firstAcceptedAt: sql<string>`min(${conversations.createdAt})`,
      })
      .from(conversations)
      .innerJoin(masters, eq(masters.id, conversations.masterId))
      .where(eq(conversations.orderId, orderId))
      .groupBy(conversations.masterId, masters.displayName)
      .orderBy(sql`min(${conversations.createdAt})`);
    return rows.map((row) => ({
      masterId: row.masterId,
      displayName: row.displayName,
      leftAt: row.stillOpen || row.lastClosedAt === null ? null : new Date(row.lastClosedAt),
    }));
  }

  /** A master, as a report names them. */
  async masterOf(masterId: string): Promise<{ id: string; displayName: string } | undefined> {
    const [row] = await this.db
      .select({ id: masters.id, displayName: masters.displayName })
      .from(masters)
      .where(eq(masters.id, masterId));
    return row;
  }

  /** The order's customer, as a report names them. */
  async customerOf(customerId: string): Promise<{ id: string; displayName: string } | undefined> {
    const [row] = await this.db
      .select({ id: customers.id, displayName: customers.displayName })
      .from(customers)
      .where(eq(customers.id, customerId));
    return row;
  }

  /** The new report, or `undefined` when this side has already filed one. */
  async insert(input: {
    orderId: string;
    customerId: string;
    masterId: string;
    reporterRole: ReportPartyRoleName;
    reasonCode: ReportReasonName;
    text: string | null;
  }): Promise<ReportRow | undefined> {
    const [row] = await this.db
      .insert(reports)
      .values({ id: uuidV7(), ...input })
      .onConflictDoNothing({ target: [reports.orderId, reports.masterId, reports.reporterRole] })
      .returning();
    return row;
  }

  /**
   * This side's report on the order **with this master**. After a re-dispatch
   * the new master is a new pairing: they never reach the previous master's
   * report, and the customer's report about the previous master is not the
   * one about the new.
   */
  async findOwn(
    orderId: string,
    masterId: string,
    reporterRole: ReportPartyRoleName,
  ): Promise<ReportRow | undefined> {
    const [row] = await this.db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.orderId, orderId),
          eq(reports.masterId, masterId),
          eq(reports.reporterRole, reporterRole),
        ),
      );
    return row;
  }

  /** Edits a report still `open`; `undefined` once an admin has claimed it. */
  async updateOwn(
    orderId: string,
    masterId: string,
    reporterRole: ReportPartyRoleName,
    fields: { reasonCode: ReportReasonName; text: string | null },
  ): Promise<ReportRow | undefined> {
    const [row] = await this.db
      .update(reports)
      .set(fields)
      .where(
        and(
          eq(reports.orderId, orderId),
          eq(reports.masterId, masterId),
          eq(reports.reporterRole, reporterRole),
          eq(reports.status, 'open'),
        ),
      )
      .returning();
    return row;
  }

  /** The queue, oldest first. Served by `reports_queue_idx` when filtered by status. */
  async list(input: {
    status?: ReportStatusName | undefined;
    reasonCode?: ReportReasonName | undefined;
    afterId: string | null;
    limit: number;
  }): Promise<{ rows: AdminReportRow[]; hasMore: boolean }> {
    const keyset =
      input.afterId === null
        ? undefined
        : sql`(${reports.createdAt}, ${reports.id}) > (select r.created_at, r.id from reports r where r.id = ${input.afterId})`;
    const rows = await this.db
      .select({
        report: reports,
        customerName: customers.displayName,
        masterName: masters.displayName,
      })
      .from(reports)
      .innerJoin(customers, eq(customers.id, reports.customerId))
      .innerJoin(masters, eq(masters.id, reports.masterId))
      .where(
        and(
          input.status === undefined ? undefined : eq(reports.status, input.status),
          input.reasonCode === undefined ? undefined : eq(reports.reasonCode, input.reasonCode),
          keyset,
        ),
      )
      .orderBy(asc(reports.createdAt), asc(reports.id))
      .limit(input.limit + 1);
    return { rows: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  }

  /** One report with its order and its handler, or `undefined`. */
  async findDetail(reportId: string) {
    const [row] = await this.db
      .select({
        report: reports,
        customerName: customers.displayName,
        masterName: masters.displayName,
        order: {
          id: orders.id,
          status: orders.status,
          createdAt: orders.createdAt,
        },
        serviceName: services.name,
        handlerName: handlers.displayName,
      })
      .from(reports)
      .innerJoin(customers, eq(customers.id, reports.customerId))
      .innerJoin(masters, eq(masters.id, reports.masterId))
      .innerJoin(orders, eq(orders.id, reports.orderId))
      .innerJoin(services, eq(services.id, orders.serviceId))
      .leftJoin(handlers, eq(handlers.id, reports.handledByAdminId))
      .where(eq(reports.id, reportId));
    return row;
  }

  /** `open` → `in_review`, conditionally. `undefined` when it was not open. */
  async claim(
    reportId: string,
    adminUserId: string,
    now: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<ReportRow | undefined> {
    const [row] = await executor
      .update(reports)
      .set({ status: 'in_review', handledByAdminId: adminUserId, claimedAt: now })
      .where(and(eq(reports.id, reportId), eq(reports.status, 'open')))
      .returning();
    return row;
  }

  /**
   * `in_review` → `closed`, conditionally. `undefined` when it was not in
   * review. The handler stays the admin who claimed it; who closed it is in
   * the audit row.
   */
  async close(
    input: {
      reportId: string;
      outcome: ReportOutcomeName;
      reason: string;
      now: Date;
    },
    executor: DatabaseExecutor = this.db,
  ): Promise<ReportRow | undefined> {
    const [row] = await executor
      .update(reports)
      .set({
        status: 'closed',
        outcome: input.outcome,
        outcomeReason: input.reason,
        closedAt: input.now,
      })
      .where(and(eq(reports.id, input.reportId), eq(reports.status, 'in_review')))
      .returning();
    return row;
  }

  /** Reports about one subject since `since`. */
  async countAbout(
    reported: { role: ReportPartyRoleName; profileId: string },
    since: Date,
  ): Promise<number> {
    // About a master means filed by the customer, and the other way round.
    const [row] = await this.db
      .select({ value: count() })
      .from(reports)
      .where(
        reported.role === 'master'
          ? and(
              eq(reports.masterId, reported.profileId),
              eq(reports.reporterRole, 'customer'),
              gte(reports.createdAt, since),
            )
          : and(
              eq(reports.customerId, reported.profileId),
              eq(reports.reporterRole, 'master'),
              gte(reports.createdAt, since),
            ),
      );
    return row?.value ?? 0;
  }

  /** Whether the reported party's account shows the suspension an outcome claims. */
  async isSuspended(reported: { role: ReportPartyRoleName; profileId: string }): Promise<boolean> {
    if (reported.role === 'master') {
      const [row] = await this.db
        .select({ status: masters.verificationStatus })
        .from(masters)
        .where(eq(masters.id, reported.profileId));
      return row?.status === 'suspended';
    }
    const [row] = await this.db
      .select({ status: users.status })
      .from(customers)
      .innerJoin(users, eq(users.id, customers.userId))
      .where(eq(customers.id, reported.profileId));
    return row?.status === 'suspended';
  }

  /** The dashboard's numbers: the queue, and anyone reported more than once since `since`. */
  async dashboardCounts(since: Date, top: number) {
    const [queue] = await this.db
      .select({
        open: sql<number>`(count(*) filter (where ${reports.status} = 'open'))::int`,
        inReview: sql<number>`(count(*) filter (where ${reports.status} = 'in_review'))::int`,
      })
      .from(reports)
      .where(inArray(reports.status, ['open', 'in_review']));

    const aboutMasters = await this.db
      .select({ profileId: reports.masterId, displayName: masters.displayName, count: count() })
      .from(reports)
      .innerJoin(masters, eq(masters.id, reports.masterId))
      .where(and(eq(reports.reporterRole, 'customer'), gte(reports.createdAt, since)))
      .groupBy(reports.masterId, masters.displayName)
      .having(sql`count(*) > 1`)
      .orderBy(desc(count()))
      .limit(top);
    const aboutCustomers = await this.db
      .select({ profileId: reports.customerId, displayName: customers.displayName, count: count() })
      .from(reports)
      .innerJoin(customers, eq(customers.id, reports.customerId))
      .where(and(eq(reports.reporterRole, 'master'), gte(reports.createdAt, since)))
      .groupBy(reports.customerId, customers.displayName)
      .having(sql`count(*) > 1`)
      .orderBy(desc(count()))
      .limit(top);

    return {
      open: queue?.open ?? 0,
      inReview: queue?.inReview ?? 0,
      repeatReported: [
        ...aboutMasters.map((row) => ({ role: 'master' as const, ...row })),
        ...aboutCustomers.map((row) => ({ role: 'customer' as const, ...row })),
      ]
        .sort((a, b) => b.count - a.count)
        .slice(0, top),
    };
  }
}
