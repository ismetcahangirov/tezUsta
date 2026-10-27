import { Inject, Injectable } from '@nestjs/common';
import type { OrderStatus } from '@tezusta/types';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { adminAuditLog } from '../../infra/database/schema/admin';
import { addresses } from '../../infra/database/schema/addresses';
import { customers } from '../../infra/database/schema/customers';
import { masters } from '../../infra/database/schema/masters';
import { orders } from '../../infra/database/schema/orders';
import type { UserStatusName } from '../../infra/database/schema/users';
import { users } from '../../infra/database/schema/users';
import { SessionsRepository } from '../auth/sessions.repository';
import { OrdersRepository } from '../orders/orders.repository';
import { AdminRepository } from './admin.repository';

/** The audit actions that set an account's status from the panel. */
export const CUSTOMER_STATUS_ACTIONS = ['customer.suspend', 'customer.reinstate'] as const;

/** How the list's `q` is read: an id, a whole phone number, or a name prefix. */
export type CustomerSearch =
  | { readonly kind: 'id'; readonly customerId: string }
  | { readonly kind: 'phone'; readonly phoneE164: string }
  | { readonly kind: 'name'; readonly prefix: string };

export interface AdminCustomerListRow {
  readonly id: string;
  readonly displayName: string;
  readonly phoneE164: string;
  readonly status: UserStatusName;
  readonly createdAt: Date;
  readonly orderCount: number;
  readonly lastOrderAt: Date | null;
}

export interface AdminCustomerRow {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly phoneE164: string;
  readonly status: UserStatusName;
  readonly createdAt: Date;
  readonly ratingCount: number;
}

/** The order groups the detail counts, by status. */
const ORDER_GROUPS = {
  open: ['SEARCHING', 'ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS'],
  completed: ['COMPLETED', 'PAYMENT_PENDING', 'PAID'],
  cancelled: ['CANCELLED'],
  disputed: ['DISPUTED', 'RESOLVED', 'REFUNDED'],
  // Nobody took it — a supply signal, never counted as a cancellation.
  unfilled: ['NO_MASTER_FOUND'],
} as const satisfies Record<string, readonly OrderStatus[]>;

/** `%`, `_` and the escape character itself, made literal for `LIKE`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Admin read and write models for customer accounts (#328, ADR-0050).
 *
 * In the admin module because the questions span several tables — the
 * account on `users`, the profile on `customers`, its orders, its addresses,
 * the master profile on the same account — and the only caller is the panel.
 * Every write to another module's rows goes through that module's repository:
 * the session revocation through `SessionsRepository`, the order lock through
 * `OrdersRepository`.
 */
@Injectable()
export class AdminCustomersRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly sessions: SessionsRepository,
    private readonly orders: OrdersRepository,
    private readonly admins: AdminRepository,
  ) {}

  /**
   * Newest first, by keyset. A name search is served by
   * `customers_display_name_prefix_idx`, the unfiltered list by
   * `customers_created_idx`, a phone by `users_phone_e164_live_unique` and an
   * id by the primary key. The two counts per row read
   * `orders_customer_created_idx` for the page's rows only.
   */
  async list(input: {
    readonly search?: CustomerSearch | undefined;
    readonly status?: UserStatusName | undefined;
    readonly afterId: string | null;
    readonly limit: number;
  }): Promise<{ rows: AdminCustomerListRow[]; hasMore: boolean }> {
    const search = input.search;
    const keyset =
      input.afterId === null
        ? undefined
        : sql`(${customers.createdAt}, ${customers.id}) < (select c.created_at, c.id from customers c where c.id = ${input.afterId})`;

    const rows = await this.db
      .select({
        id: customers.id,
        displayName: customers.displayName,
        phoneE164: users.phoneE164,
        status: users.status,
        createdAt: customers.createdAt,
        orderCount: sql<number>`(select count(*) from ${orders} o where o.customer_id = ${customers.id} and o.status <> 'DRAFT')::int`,
        lastOrderAt: sql<Date | null>`(select max(o.created_at) from ${orders} o where o.customer_id = ${customers.id} and o.status <> 'DRAFT')`,
      })
      .from(customers)
      .innerJoin(users, eq(users.id, customers.userId))
      .where(
        and(
          search === undefined
            ? undefined
            : search.kind === 'id'
              ? eq(customers.id, search.customerId)
              : search.kind === 'phone'
                ? and(eq(users.phoneE164, search.phoneE164), isNull(users.deletedAt))
                : // Both sides lowered by the database: JavaScript lowers `İ`
                  // to `i` plus a combining dot, Postgres to a plain `i`, and
                  // a prefix lowered by one and compared against a column
                  // lowered by the other would never match.
                  sql`lower(${customers.displayName}) like lower(${`${escapeLike(search.prefix)}%`})`,
          input.status === undefined ? undefined : eq(users.status, input.status),
          // A deleted customer profile is no longer a customer here; the
          // account may live on as a master's.
          isNull(customers.deletedAt),
          keyset,
        ),
      )
      .orderBy(desc(customers.createdAt), desc(customers.id))
      .limit(input.limit + 1);

    return {
      rows: rows.map((row) => ({
        ...row,
        // `max()` over a timestamptz arrives as a string through `sql`.
        lastOrderAt: row.lastOrderAt === null ? null : new Date(row.lastOrderAt),
      })),
      hasMore: rows.length > input.limit,
    };
  }

  /** One customer with their account, or `undefined`. */
  async find(customerId: string): Promise<AdminCustomerRow | undefined> {
    const [row] = await this.db
      .select({
        id: customers.id,
        userId: customers.userId,
        displayName: customers.displayName,
        phoneE164: users.phoneE164,
        status: users.status,
        createdAt: customers.createdAt,
        ratingCount: customers.ratingCount,
      })
      .from(customers)
      .innerJoin(users, eq(users.id, customers.userId))
      .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)));
    return row;
  }

  /**
   * How many of the customer's orders are in each group, in one statement,
   * and how many of their cancellations were late (ADR-0068 § 3) — a filter
   * over the same rows, so the count costs no second read.
   */
  async orderCounts(
    customerId: string,
  ): Promise<Record<keyof typeof ORDER_GROUPS | 'lateCancellations', number>> {
    const inGroup = (group: keyof typeof ORDER_GROUPS) =>
      sql<number>`(count(*) filter (where ${inArray(orders.status, [...ORDER_GROUPS[group]])}))::int`;
    const [row] = await this.db
      .select({
        open: inGroup('open'),
        completed: inGroup('completed'),
        cancelled: inGroup('cancelled'),
        disputed: inGroup('disputed'),
        unfilled: inGroup('unfilled'),
        lateCancellations: sql<number>`(count(*) filter (where ${eq(orders.cancellationKind, 'late')}))::int`,
      })
      .from(orders)
      .where(and(eq(orders.customerId, customerId), ne(orders.status, 'DRAFT')));
    return (
      row ?? { open: 0, completed: 0, cancelled: 0, disputed: 0, unfilled: 0, lateCancellations: 0 }
    );
  }

  /** Live saved addresses, the default first — their labels only, never the text or the position. */
  async addresses(customerId: string): Promise<{ label: string | null; isDefault: boolean }[]> {
    return this.db
      .select({ label: addresses.label, isDefault: addresses.isDefault })
      .from(addresses)
      .where(and(eq(addresses.customerId, customerId), isNull(addresses.deletedAt)))
      .orderBy(desc(addresses.isDefault), desc(addresses.createdAt));
  }

  /** The master profile on the same account, if any. */
  async masterProfileOf(userId: string): Promise<{ id: string; displayName: string } | undefined> {
    const [row] = await this.db
      .select({ id: masters.id, displayName: masters.displayName })
      .from(masters)
      .where(and(eq(masters.userId, userId), isNull(masters.deletedAt)));
    return row;
  }

  /** The last time an admin set this account's status from the panel, and why. */
  async lastStatusChange(
    customerId: string,
  ): Promise<{ reason: string | null; createdAt: Date } | undefined> {
    // Served by `admin_audit_log_target_idx`.
    const [row] = await this.db
      .select({ reason: adminAuditLog.reason, createdAt: adminAuditLog.createdAt })
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.targetType, 'customer'),
          eq(adminAuditLog.targetId, customerId),
          inArray(adminAuditLog.action, [...CUSTOMER_STATUS_ACTIONS]),
        ),
      )
      .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
      .limit(1);
    return row;
  }

  /**
   * Suspends the account: the status, every session and the audit row, in
   * one transaction (#328).
   *
   * The customer's order lock is taken **first**, so the open orders read
   * here include any order a creation was committing at that moment, and any
   * creation after it finds the account suspended (`createSearching`).
   * Cancelling the searching ones is the caller's, after the commit, through
   * the order state machine.
   */
  async suspend(input: {
    readonly customer: AdminCustomerRow;
    readonly adminUserId: string;
    readonly reason: string;
    readonly now: Date;
  }): Promise<
    | { readonly kind: 'suspended'; readonly open: { id: string; status: OrderStatus }[] }
    | { readonly kind: 'not-active'; readonly status: UserStatusName }
  > {
    const { customer, now } = input;
    return this.db.transaction(async (tx) => {
      await this.orders.lockOpenOrders(customer.id, tx);

      const [moved] = await tx
        .update(users)
        .set({ status: 'suspended' })
        .where(and(eq(users.id, customer.userId), eq(users.status, 'active')))
        .returning({ id: users.id });
      if (moved === undefined) {
        const [current] = await tx
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, customer.userId));
        return { kind: 'not-active', status: current?.status ?? customer.status };
      }

      await this.sessions.revokeAllSessionsForUser(customer.userId, 'suspension', now, tx);
      const open = await this.orders.listOpenForCustomer(customer.id, tx);

      await this.admins.appendAudit(
        {
          adminUserId: input.adminUserId,
          action: 'customer.suspend',
          targetType: 'customer',
          targetId: customer.id,
          reason: input.reason,
          before: { status: 'active' },
          after: {
            status: 'suspended',
            searchingOrderIds: open.filter((o) => o.status === 'SEARCHING').map((o) => o.id),
            heldOrderIds: open.filter((o) => o.status !== 'SEARCHING').map((o) => o.id),
          },
        },
        now,
        tx,
      );

      return { kind: 'suspended', open };
    });
  }

  /** Lifts a suspension, with its audit row, in one transaction. */
  async reinstate(input: {
    readonly customer: AdminCustomerRow;
    readonly adminUserId: string;
    readonly reason: string;
    readonly now: Date;
  }): Promise<
    | { readonly kind: 'reinstated' }
    | { readonly kind: 'not-suspended'; readonly status: UserStatusName }
  > {
    const { customer, now } = input;
    return this.db.transaction(async (tx) => {
      const [moved] = await tx
        .update(users)
        .set({ status: 'active' })
        .where(and(eq(users.id, customer.userId), eq(users.status, 'suspended')))
        .returning({ id: users.id });
      if (moved === undefined) {
        const [current] = await tx
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, customer.userId));
        return { kind: 'not-suspended', status: current?.status ?? customer.status };
      }

      await this.admins.appendAudit(
        {
          adminUserId: input.adminUserId,
          action: 'customer.reinstate',
          targetType: 'customer',
          targetId: customer.id,
          reason: input.reason,
          before: { status: 'suspended' },
          after: { status: 'active' },
        },
        now,
        tx,
      );
      return { kind: 'reinstated' };
    });
  }
}
