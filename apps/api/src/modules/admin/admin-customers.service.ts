import { Injectable, Logger } from '@nestjs/common';
import type {
  AdminCustomerDetail,
  AdminCustomerSummary,
  AdminCustomerSuspension,
  AdminOrderSummary,
  AdminPhoneReveal,
  CursorPage,
} from '@tezusta/types';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { UserStatusName } from '../../infra/database/schema/users';
import { maskPhone, OrdersAdminReadService } from '../orders/orders-admin-read.service';
import { OrdersService } from '../orders/orders.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import type {
  AdminCustomerListRow,
  AdminCustomerRow,
  CustomerSearch,
} from './admin-customers.repository';
import { AdminCustomersRepository } from './admin-customers.repository';
import type { ListCustomerOrdersQuery, ListCustomersQuery } from './admin-customers.schema';

/** The order-history reason a suspension's cancellations carry (#328). */
export const CUSTOMER_SUSPENDED_REASON = 'customer_suspended';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A whole Azerbaijani number in E.164 — the only phone the search matches. */
const WHOLE_E164 = /^\+994\d{9}$/;

/**
 * The account is not where this action starts from — already suspended,
 * not suspended, or deleted. The status is in `details`, so a panel showing a
 * stale page can say what happened instead of "conflict".
 */
export class CustomerStatusConflictError extends AppError {
  constructor(status: UserStatusName) {
    super(ERROR_CODES.CONFLICT, `The account is ${status}.`, 409, { status });
    this.name = 'CustomerStatusConflictError';
    Object.setPrototypeOf(this, CustomerStatusConflictError.prototype);
  }
}

const cursorSchema = z.object({ i: z.uuid() });

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ i: id }), 'utf8').toString('base64url');
}

/** An unreadable cursor is the first page, as on the order list. */
function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) {
    return null;
  }
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data.i : null;
  } catch {
    return null;
  }
}

/**
 * How `q` is read. An id or a whole number match exactly; anything else is a
 * name prefix — including a part of a number, which therefore finds nobody.
 */
export function readCustomerSearch(q: string | undefined): CustomerSearch | undefined {
  if (q === undefined) {
    return undefined;
  }
  if (UUID.test(q)) {
    return { kind: 'id', customerId: q.toLowerCase() };
  }
  if (WHOLE_E164.test(q)) {
    return { kind: 'phone', phoneE164: q };
  }
  return { kind: 'name', prefix: q };
}

function toSummary(row: AdminCustomerListRow): AdminCustomerSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    phoneMasked: maskPhone(row.phoneE164),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    orderCount: row.orderCount,
    lastOrderAt: row.lastOrderAt === null ? null : row.lastOrderAt.toISOString(),
  };
}

/**
 * Customer accounts in the admin panel (#328,
 * [ADR-0050](docs/decisions/ADR-0050-admin-customer-accounts.md)).
 *
 * The same rules as the master file (ADR-0043 § 6): the list is not audited,
 * opening a customer is (`customer.read`), a phone number is a separate
 * reveal with a reason (`customer.phone.read`), and a status change writes
 * its audit row in the transaction that makes it.
 */
@Injectable()
export class AdminCustomersService {
  private readonly logger = new Logger(AdminCustomersService.name);

  constructor(
    private readonly customers: AdminCustomersRepository,
    private readonly admins: AdminRepository,
    private readonly orderReads: OrdersAdminReadService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * Names, masked numbers and counts. Not audited — except a search by a
   * whole number that finds someone: that ties a number the admin typed to a
   * person, which is a personal-data read whether or not the admin holds
   * `pii.read`.
   */
  async list(
    admin: AdminActor,
    query: ListCustomersQuery,
  ): Promise<CursorPage<AdminCustomerSummary>> {
    const search = readCustomerSearch(query.q);
    const { rows, hasMore } = await this.customers.list({
      search,
      status: query.status,
      afterId: decodeCursor(query.cursor),
      limit: query.limit,
    });
    const items = rows.slice(0, query.limit).map(toSummary);
    if (search?.kind === 'phone') {
      for (const item of items) {
        await this.admins.appendAudit({
          adminUserId: admin.adminUserId,
          action: 'customer.phone.search',
          targetType: 'customer',
          targetId: item.id,
        });
      }
    }
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(last.id) : null };
  }

  /** One customer's file. **Audited**, as an order's detail is. */
  async detail(admin: AdminActor, customerId: string): Promise<AdminCustomerDetail> {
    const customer = await this.require(customerId);
    const [summary, counts, addresses, masterProfile, lastChange] = await Promise.all([
      this.summaryOf(customer.id),
      this.customers.orderCounts(customer.id),
      this.customers.addresses(customer.id),
      this.customers.masterProfileOf(customer.userId),
      this.customers.lastStatusChange(customer.id),
    ]);

    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'customer.read',
      targetType: 'customer',
      targetId: customer.id,
    });

    return {
      ...summary,
      statusReason: lastChange?.reason ?? null,
      statusChangedAt: lastChange === undefined ? null : lastChange.createdAt.toISOString(),
      ratingCount: customer.ratingCount,
      orderCounts: counts,
      addresses,
      masterProfile: masterProfile ?? null,
    };
  }

  /** The customer's orders, newest first, in the order list's own shape. */
  async orderHistory(
    customerId: string,
    query: ListCustomerOrdersQuery,
  ): Promise<CursorPage<AdminOrderSummary>> {
    const customer = await this.require(customerId);
    return this.orderReads.list({
      customerId: customer.id,
      sort: 'newest',
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /** The whole number, with a reason, audited as a personal-data read (ADR-0043 § 6). */
  async revealPhone(
    admin: AdminActor,
    customerId: string,
    reason: string,
  ): Promise<AdminPhoneReveal> {
    const customer = await this.require(customerId);
    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'customer.phone.read',
      targetType: 'customer',
      targetId: customer.id,
      reason,
    });
    return { phoneE164: customer.phoneE164 };
  }

  /**
   * Suspends the **account** (#328). The status, every session and the audit
   * row commit together; then each order still searching is cancelled
   * through the state machine, as this admin, with
   * {@link CUSTOMER_SUSPENDED_REASON}. An order a master already holds is not
   * touched — it is listed for support to follow up.
   */
  async suspend(
    admin: AdminActor,
    customerId: string,
    reason: string,
  ): Promise<AdminCustomerSuspension> {
    const customer = await this.require(customerId);
    const outcome = await this.customers.suspend({
      customer,
      adminUserId: admin.adminUserId,
      reason,
      now: new Date(),
    });
    if (outcome.kind === 'not-active') {
      throw new CustomerStatusConflictError(outcome.status);
    }

    const cancelledOrderIds: string[] = [];
    const followUpOrderIds = outcome.open
      .filter((order) => order.status !== 'SEARCHING')
      .map((order) => order.id);

    for (const order of outcome.open.filter((open) => open.status === 'SEARCHING')) {
      try {
        await this.orders.override(admin.adminUserId, order.id, {
          to: 'CANCELLED',
          reason: CUSTOMER_SUSPENDED_REASON,
          // Only while it is still searching: an order a master accepted
          // after the commit is held, and held orders are not touched.
          onlyFrom: 'SEARCHING',
        });
        cancelledOrderIds.push(order.id);
      } catch (error) {
        // Accepted between the suspension's commit and this write, most
        // likely. The suspension stands; the order goes to support's list
        // rather than turning a done suspension into an error the admin
        // would retry into a 409. The audit row names every order that was
        // searching, so one left searching here is findable (ADR-0050 § 3).
        this.logger.error(
          `Order ${order.id} was not cancelled after the suspension of customer ${customer.id}: ${String(error)}`,
        );
        followUpOrderIds.push(order.id);
      }
    }

    return {
      customer: await this.summaryOf(customer.id),
      cancelledOrderIds,
      followUpOrderIds,
    };
  }

  /** Lifts a suspension. Orders cancelled by it stay cancelled. */
  async reinstate(
    admin: AdminActor,
    customerId: string,
    reason: string,
  ): Promise<AdminCustomerSummary> {
    const customer = await this.require(customerId);
    const outcome = await this.customers.reinstate({
      customer,
      adminUserId: admin.adminUserId,
      reason,
      now: new Date(),
    });
    if (outcome.kind === 'not-suspended') {
      throw new CustomerStatusConflictError(outcome.status);
    }
    return this.summaryOf(customer.id);
  }

  /** The list's row for one customer — re-read, so a response is what the database holds. */
  private async summaryOf(customerId: string): Promise<AdminCustomerSummary> {
    const { rows } = await this.customers.list({
      search: { kind: 'id', customerId },
      afterId: null,
      limit: 1,
    });
    const [row] = rows;
    if (row === undefined) {
      throw new NotFoundError();
    }
    return toSummary(row);
  }

  /**
   * The customer, or 404. A master's id, or any id that is not a customer
   * profile, is the same 404: this surface does not say whether the account
   * exists under another role.
   */
  private async require(customerId: string): Promise<AdminCustomerRow> {
    const row = await this.customers.find(customerId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }
}
