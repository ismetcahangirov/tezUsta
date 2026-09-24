import { Inject, Injectable } from '@nestjs/common';
import type { OrderStatus } from '@tezusta/types';
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { adminUsers } from '../../infra/database/schema/admin';
import { addresses } from '../../infra/database/schema/addresses';
import { conversations, messages } from '../../infra/database/schema/conversations';
import { customers } from '../../infra/database/schema/customers';
import { masters } from '../../infra/database/schema/masters';
import { orderPhotos } from '../../infra/database/schema/order-photos';
import { orders, orderStatusHistory } from '../../infra/database/schema/orders';
import { services } from '../../infra/database/schema/services';
import { users } from '../../infra/database/schema/users';

/** The statuses an order sits in while a master is supposed to be on it. */
export const ENGAGED_STATUSES: readonly OrderStatus[] = [
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
];

export interface AdminOrderListRow {
  readonly id: string;
  readonly status: OrderStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly serviceName: Record<string, string>;
  readonly customerName: string;
  readonly masterName: string | null;
  readonly priceMinor: number | null;
  readonly redispatchCount: number;
}

const customerUsers = alias(users, 'customer_users');
const masterUsers = alias(users, 'master_users');

/**
 * Read models for the admin panel's order screens (EPIC 13, issue #245).
 *
 * In the orders module because the orders module owns this data
 * (`backend-architecture.md` § Module rules); the admin module reaches it
 * through `OrdersAdminReadService` and adds the permission and the audit row.
 * Read-only: every change to an order still goes through the state machine.
 */
@Injectable()
export class OrdersAdminRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Newest first, or oldest first for the dispute queue. Served by
   * `orders_status_created_idx` when filtered by status and by
   * `orders_created_idx` otherwise.
   */
  async list(input: {
    readonly statuses?: readonly OrderStatus[] | undefined;
    readonly serviceId?: string | undefined;
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
    readonly stuckBefore?: Date | undefined;
    readonly oldestFirst: boolean;
    readonly afterId: string | null;
    readonly limit: number;
  }): Promise<{ rows: AdminOrderListRow[]; hasMore: boolean }> {
    const statuses =
      input.stuckBefore === undefined
        ? input.statuses
        : (input.statuses ?? ENGAGED_STATUSES).filter((status) =>
            ENGAGED_STATUSES.includes(status),
          );
    const keyset =
      input.afterId === null
        ? undefined
        : input.oldestFirst
          ? sql`(${orders.createdAt}, ${orders.id}) > (select o.created_at, o.id from orders o where o.id = ${input.afterId})`
          : sql`(${orders.createdAt}, ${orders.id}) < (select o.created_at, o.id from orders o where o.id = ${input.afterId})`;

    const rows = await this.db
      .select({
        id: orders.id,
        status: orders.status,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
        serviceName: services.name,
        customerName: customers.displayName,
        masterName: masters.displayName,
        priceMinor: orders.priceMinor,
        redispatchCount: orders.redispatchCount,
      })
      .from(orders)
      .innerJoin(services, eq(services.id, orders.serviceId))
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(masters, eq(masters.id, orders.masterId))
      .where(
        and(
          ne(orders.status, 'DRAFT'),
          statuses === undefined ? undefined : inArray(orders.status, [...statuses]),
          input.serviceId === undefined ? undefined : eq(orders.serviceId, input.serviceId),
          input.from === undefined ? undefined : gte(orders.createdAt, input.from),
          input.to === undefined ? undefined : lt(orders.createdAt, input.to),
          input.stuckBefore === undefined ? undefined : lt(orders.updatedAt, input.stuckBefore),
          keyset,
        ),
      )
      .orderBy(
        ...(input.oldestFirst
          ? [asc(orders.createdAt), asc(orders.id)]
          : [desc(orders.createdAt), desc(orders.id)]),
      )
      .limit(input.limit + 1);

    return { rows: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  }

  /** One order with its service, address and both parties, or `undefined`. */
  async findDetail(orderId: string) {
    const [row] = await this.db
      .select({
        order: orders,
        serviceName: services.name,
        address: {
          formattedAddress: addresses.formattedAddress,
          building: addresses.building,
          entrance: addresses.entrance,
          floor: addresses.floor,
          apartment: addresses.apartment,
          landmarkNote: addresses.landmarkNote,
        },
        customer: {
          id: customers.id,
          displayName: customers.displayName,
          phoneE164: customerUsers.phoneE164,
        },
        master: {
          id: masters.id,
          displayName: masters.displayName,
          phoneE164: masterUsers.phoneE164,
        },
      })
      .from(orders)
      .innerJoin(services, eq(services.id, orders.serviceId))
      .innerJoin(addresses, eq(addresses.id, orders.addressId))
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(customerUsers, eq(customerUsers.id, customers.userId))
      .leftJoin(masters, eq(masters.id, orders.masterId))
      .leftJoin(masterUsers, eq(masterUsers.id, masters.userId))
      .where(and(eq(orders.id, orderId), ne(orders.status, 'DRAFT')));
    return row;
  }

  /** The whole status trail, oldest first, with who moved it. */
  async history(orderId: string) {
    const actorAdmins = alias(adminUsers, 'actor_admins');
    return this.db
      .select({
        fromStatus: orderStatusHistory.fromStatus,
        toStatus: orderStatusHistory.toStatus,
        actorKind: orderStatusHistory.actorKind,
        actorAdminName: actorAdmins.displayName,
        reason: orderStatusHistory.reason,
        createdAt: orderStatusHistory.createdAt,
      })
      .from(orderStatusHistory)
      .leftJoin(actorAdmins, eq(actorAdmins.id, orderStatusHistory.actorAdminId))
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(asc(orderStatusHistory.createdAt), asc(orderStatusHistory.id));
  }

  async photos(orderId: string) {
    return this.db
      .select({ id: orderPhotos.id, status: orderPhotos.status, createdAt: orderPhotos.createdAt })
      .from(orderPhotos)
      .where(eq(orderPhotos.orderId, orderId))
      .orderBy(asc(orderPhotos.createdAt), asc(orderPhotos.id));
  }

  /**
   * Every conversation the order has had — one per assigned master — with at
   * most `perConversation` of its latest messages, oldest first.
   */
  async transcript(orderId: string, perConversation: number) {
    const conversationRows = await this.db
      .select({
        id: conversations.id,
        masterId: conversations.masterId,
        createdAt: conversations.createdAt,
        closedAt: conversations.closedAt,
      })
      .from(conversations)
      .where(eq(conversations.orderId, orderId))
      .orderBy(asc(conversations.createdAt), asc(conversations.id));

    return Promise.all(
      conversationRows.map(async (conversation) => {
        const latest = await this.db
          .select({
            id: messages.id,
            senderKind: messages.senderKind,
            body: messages.body,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.conversationId, conversation.id))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(perConversation);
        return { ...conversation, messages: latest.reverse() };
      }),
    );
  }

  /**
   * The order half of the operational dashboard (EPIC 13, issue #246), for
   * orders created in `[from, to)`.
   *
   * `NO_MASTER_FOUND` is **unfilled**, never a cancellation
   * (`admin-flow.md` § 6): the two are separate numbers from separate
   * predicates, and nothing here adds one to the other. "Filled" means a
   * master accepted it at least once — read from the status trail, because a
   * re-dispatched order has no master on its row any more but was filled.
   */
  async dashboardOrderMetrics(input: {
    readonly from: Date;
    readonly to: Date;
    readonly cellDegrees: number;
    readonly topAreas: number;
  }) {
    const { from, to, cellDegrees, topAreas } = input;
    const inRange = sql`o.created_at >= ${from} and o.created_at < ${to} and o.status <> 'DRAFT'`;

    const [totals] = (
      await this.db.execute<{
        created: number;
        filled: number;
        unfilled: number;
        searching: number;
        cancelled: number;
      }>(sql`
        select count(*)::int as created,
               count(*) filter (where exists (
                 select 1 from order_status_history h
                  where h.order_id = o.id and h.to_status = 'ACCEPTED'))::int as filled,
               count(*) filter (where o.status = 'NO_MASTER_FOUND')::int as unfilled,
               count(*) filter (where o.status = 'SEARCHING')::int as searching,
               count(*) filter (where o.status = 'CANCELLED')::int as cancelled
          from orders o
         where ${inRange}`)
    ).rows;

    const cancelledBy = (
      await this.db.execute<{ actor_kind: string; count: number }>(sql`
        select h.actor_kind, count(*)::int as count
          from orders o
          join order_status_history h on h.order_id = o.id and h.to_status = 'CANCELLED'
         where ${inRange}
         group by h.actor_kind
         order by h.actor_kind`)
    ).rows;

    const cancelledAfterAccept =
      (
        await this.db.execute<{ count: number }>(sql`
        select count(*)::int as count
          from orders o
         where ${inRange}
           and o.status = 'CANCELLED'
           and exists (select 1 from order_status_history h
                        where h.order_id = o.id and h.to_status = 'ACCEPTED')`)
      ).rows[0]?.count ?? 0;

    const unfilledByCategory = (
      await this.db.execute<{
        category_id: string;
        name: Record<string, string>;
        count: number;
      }>(sql`
        select c.id as category_id, c.name, count(*)::int as count
          from orders o
          join services s on s.id = o.service_id
          join service_categories c on c.id = s.category_id
         where ${inRange} and o.status = 'NO_MASTER_FOUND'
         group by c.id, c.name
         order by count desc, c.id
         limit 50`)
    ).rows;

    // A cell is the south-west corner of a `cellDegrees` square; its centre is
    // reported. Coarse enough that no single address can be read back out.
    const unfilledByArea = (
      await this.db.execute<{ lat: number; lng: number; count: number }>(sql`
        select (ST_Y(ST_SnapToGrid(a.position, ${cellDegrees})) + ${cellDegrees}::float8 / 2)::float8 as lat,
               (ST_X(ST_SnapToGrid(a.position, ${cellDegrees})) + ${cellDegrees}::float8 / 2)::float8 as lng,
               count(*)::int as count
          from orders o
          join addresses a on a.id = o.address_id
         where ${inRange} and o.status = 'NO_MASTER_FOUND'
         group by 1, 2
         order by count desc, 1, 2
         limit ${topAreas}`)
    ).rows;

    const [disputes] = (
      await this.db.execute<{ count: number; oldest: string | Date | null }>(sql`
        select count(*)::int as count,
               min((select max(h.created_at) from order_status_history h
                     where h.order_id = o.id and h.to_status = 'DISPUTED')) as oldest
          from orders o
         where o.status = 'DISPUTED'`)
    ).rows;

    return {
      totals: totals ?? { created: 0, filled: 0, unfilled: 0, searching: 0, cancelled: 0 },
      cancelledBy,
      cancelledAfterAccept,
      unfilledByCategory,
      unfilledByArea,
      disputes: disputes ?? { count: 0, oldest: null },
    };
  }
}
