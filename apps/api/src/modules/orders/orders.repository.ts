import { Inject, Injectable } from '@nestjs/common';
import type { OrderActorKind, OrderStatus } from '@tezusta/types';
import { and, eq, ne, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type { OrderRow } from '../../infra/database/schema/orders';
import { orders, orderStatusHistory } from '../../infra/database/schema/orders';
import type { OrderPosition } from './order-cursor';
import { OrderOffersRepository } from './order-offers.repository';
import { searchingSinceOf } from './searching-since';

/** Everything an order carries on the way in. Nothing here is the server's to decide. */
export interface NewOrderFields {
  readonly customerId: string;
  readonly addressId: string;
  readonly serviceId: string;
  readonly description: string;
  readonly idempotencyKey: string;
}

/** Who to record against a transition, and why, if there is a why. */
export interface TransitionActorRecord {
  readonly kind: OrderActorKind;
  readonly userId?: string | undefined;
  readonly adminId?: string | undefined;
  readonly reason?: string | undefined;
}

/**
 * Whether this call created the order or found the one an earlier, identical
 * call had already created.
 *
 * Returned rather than thrown, because a retry is not an error. The customer
 * pressed the button once; the network is what happened twice.
 */
export type CreateOrderOutcome =
  | { readonly kind: 'created'; readonly order: OrderRow }
  | { readonly kind: 'existing'; readonly order: OrderRow };

/** What the dispatch engine needs to know about an order before a tick acts. */
export interface OrderDispatchState {
  readonly status: OrderStatus;
  readonly serviceId: string;
  readonly addressId: string;
  /**
   * When this order most recently **entered** `SEARCHING`, or null if it never
   * has. See {@link searchingSinceOf} for why it is not a column.
   */
  readonly searchingSince: Date | null;
}

/**
 * Drizzle queries for `orders` and its audit trail. No business rules here —
 * whether a transition is legal is `order-lifecycle.ts`'s answer, and this
 * file only knows how to write one down.
 */
@Injectable()
export class OrdersRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    /**
     * Injected so {@link claimNoMasterFound} can close an order's offers in
     * the transaction that ends its search — the pattern `DatabaseExecutor`
     * documents, where one repository opens the transaction and hands it to
     * the repository that owns the other table, rather than reaching into it.
     */
    private readonly offers: OrderOffersRepository,
  ) {}

  /**
   * Creates an order as `DRAFT` and moves it to `SEARCHING` in one
   * transaction, or returns the order an identical earlier request created.
   *
   * **Why `ON CONFLICT DO UPDATE` rather than `DO NOTHING`.** Under a genuine
   * concurrent retry — two requests, one key, both in flight — `DO NOTHING`
   * returns no row to the loser, and the follow-up `SELECT` finds nothing
   * either, because the winner has not committed yet and `READ COMMITTED`
   * cannot see an uncommitted row. The loser would then have to guess. A
   * conflicting `DO UPDATE` takes a lock on the existing row instead and waits
   * for the other transaction to finish, so it returns the committed row —
   * already `SEARCHING`, because the winner moves it there before committing.
   *
   * The `SET` is a no-op that writes the key back to itself. It exists to make
   * the statement a conflicting *update*, which is what blocks; nothing about
   * the row changes.
   *
   * Which branch happened is decided by comparing the returned id to the one
   * generated here — unambiguous, and it does not depend on reading a status
   * that a later Epic might legitimately have moved on from.
   */
  async createSearching(fields: NewOrderFields): Promise<CreateOrderOutcome> {
    const id = uuidV7();

    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .insert(orders)
        .values({
          id,
          customerId: fields.customerId,
          addressId: fields.addressId,
          serviceId: fields.serviceId,
          description: fields.description,
          idempotencyKey: fields.idempotencyKey,
          status: 'DRAFT',
        })
        .onConflictDoUpdate({
          target: [orders.customerId, orders.idempotencyKey],
          set: {
            idempotencyKey: sql`excluded.idempotency_key`,
            // `updated_at` written back to itself, explicitly. Drizzle's
            // `$onUpdate` hook fires on this path too and would otherwise
            // stamp a fresh timestamp — so a retry would report an order that
            // had just been edited, when nothing about it changed. Naming the
            // column here overrides the hook and keeps the row identical.
            updatedAt: sql`${orders.updatedAt}`,
          },
        })
        .returning();

      if (claimed === undefined) {
        // Not reachable: `DO UPDATE ... RETURNING` yields a row on both paths.
        // Thrown rather than asserted away, because the alternative is
        // returning a half-built order to a caller that cannot tell.
        throw new Error('The order insert returned no row.');
      }

      if (claimed.id !== id) {
        return { kind: 'existing', order: claimed };
      }

      const [searching] = await tx
        .update(orders)
        .set({ status: 'SEARCHING' })
        .where(and(eq(orders.id, id), eq(orders.status, 'DRAFT')))
        .returning();

      if (searching === undefined) {
        throw new Error('The order could not be moved out of DRAFT.');
      }

      await tx.insert(orderStatusHistory).values({
        id: uuidV7(),
        orderId: id,
        fromStatus: 'DRAFT',
        toStatus: 'SEARCHING',
        actorKind: 'system',
      });

      return { kind: 'created', order: searching };
    });
  }

  /**
   * One order by id, **scoped to its customer**.
   *
   * The customer id is part of the query rather than something the caller
   * checks afterwards: a read that can return somebody else's row, even
   * briefly, is a read that will eventually be used without the check.
   *
   * `DRAFT` is excluded for the same reason it is excluded from the listing —
   * it is an in-flight creation, never the customer's to see, and a draft that
   * answered a read would be an implementation detail of a retry leaking out
   * as an order.
   */
  async findByIdForCustomer(id: string, customerId: string): Promise<OrderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.customerId, customerId), ne(orders.status, 'DRAFT')))
      .limit(1);

    return row;
  }

  /**
   * One order by id, **not** scoped to a caller.
   *
   * Exists for `order-photos.service.ts`, whose readers are not only "this
   * order's customer" — an order's problem photos are also visible to the
   * assigned master (issue #83) — so the ownership check cannot live in this
   * query's `WHERE` clause the way `findByIdForCustomer`'s does. The caller
   * is responsible for `requireVisibleOrNotFound` against the row this
   * returns; `DRAFT` is still excluded, for the same reason it always is.
   */
  async findById(id: string): Promise<OrderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), ne(orders.status, 'DRAFT')))
      .limit(1);

    return row;
  }

  /**
   * One page of a customer's orders, newest first.
   *
   * **The `DRAFT` exclusion lives here rather than in the service**, for the
   * reason `ServicesRepository` keeps `is_active` in the repository: a draft is
   * an in-flight creation the customer never sees, and a predicate repeated at
   * every call site is a predicate that will eventually be forgotten at one.
   *
   * The keyset predicate is a **row comparison**, `(created_at, id) < (t, i)`,
   * rather than the equivalent `created_at < t OR (created_at = t AND id < i)`.
   * The two return the same rows, and Postgres plans them very differently:
   * the `OR` form becomes a `BitmapOr` that materialises **every** row older
   * than the cursor and then top-N sorts it, so the cost of page five grows
   * with how long the customer has been a customer. The row comparison walks
   * `orders_customer_created_idx` backwards and stops after `limit + 1` rows.
   * Measured on 200,000 orders: the `OR` form read 179 rows to return 21.
   *
   * `id` is in the comparison because two orders can share a millisecond — a
   * retry storm produces exactly that — and a cursor on the timestamp alone
   * would skip or repeat them.
   *
   * Reads `limit + 1` rows and reports whether the extra one existed, so the
   * caller can mint a `nextCursor` without a second count query — a count on
   * this table would be a second scan to answer a question the page already
   * knows.
   */
  async listForCustomer(query: {
    customerId: string;
    limit: number;
    after: OrderPosition | null;
    status?: OrderStatus | undefined;
  }): Promise<{ rows: OrderRow[]; hasMore: boolean }> {
    const { customerId, limit, after, status } = query;

    const rows = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.customerId, customerId),
          ne(orders.status, 'DRAFT'),
          status === undefined ? undefined : eq(orders.status, status),
          after === null
            ? undefined
            : sql`(${orders.createdAt}, ${orders.id}) < (${after.createdAt}, ${after.id})`,
        ),
      )
      /**
       * **`nulls last` is load-bearing, not decoration.**
       *
       * Postgres defaults `DESC` to `NULLS FIRST`, while a Drizzle `.desc()`
       * index column is built `DESC NULLS LAST`. Neither column here can be
       * null — `created_at` is `NOT NULL` and `id` is the primary key — but
       * the planner compares the ordering *specifications*, not what the data
       * can actually contain, so the mismatch alone is enough to stop the
       * index from satisfying the sort. It still uses the index for the
       * filter, then sorts every matching row: measured on 200,000 orders,
       * 179 rows read and top-N sorted to return 21. Spelled to match, the
       * same query is an ordered index scan that reads exactly 21.
       */
      .orderBy(sql`${orders.createdAt} desc nulls last, ${orders.id} desc nulls last`)
      .limit(limit + 1);

    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  /**
   * One order's dispatch state, and when its current search began.
   *
   * Read by the dispatch engine before every tick (issue #103). It is
   * deliberately **not** `findById` plus a second query: a tick's first
   * question is "does this job still belong to the search that scheduled it",
   * and answering it from two reads taken at different moments would leave a
   * window in which the two disagree.
   *
   * Returns the row whatever its status — a tick's job is precisely to notice
   * that the order is no longer `SEARCHING` and stop. `DRAFT` is not excluded
   * here for the same reason: this is not a customer-facing read.
   */
  async findDispatchState(orderId: string): Promise<OrderDispatchState | undefined> {
    const result = await this.db.execute<{
      status: OrderStatus;
      service_id: string;
      address_id: string;
      searching_since_ms: string | null;
    }>(sql`
      select o.status,
             o.service_id::text as service_id,
             o.address_id::text as address_id,
             ${searchingSinceOf(sql`o.id`)} as searching_since_ms
        from orders o
       where o.id = ${orderId}::uuid
    `);

    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }

    return {
      status: row.status,
      serviceId: row.service_id,
      addressId: row.address_id,
      searchingSince:
        row.searching_since_ms === null ? null : new Date(Number(row.searching_since_ms)),
    };
  }

  /**
   * Ends a search that nobody answered: `SEARCHING -> NO_MASTER_FOUND`, with
   * actor kind `system` and no actor id (ADR-0015 — this is **not** a
   * cancellation by anyone).
   *
   * **The guard is the `WHERE`, evaluated by the database**, the same shape
   * ADR-0009 mandates for accept. A give-up tick that arrives after a master
   * claimed the order matches zero rows, writes nothing, and returns `false`
   * — a clean exit rather than an error, because at-least-once delivery makes
   * a late tick ordinary rather than exceptional. Reading the status first and
   * updating afterwards would lose that race every time two things happened at
   * once, which is the only time it matters.
   *
   * `searchingSince` is in the guard as well as the status, so a tick left
   * over from an **earlier** search on the same order — EPIC 8 re-dispatches
   * back into `SEARCHING` — cannot terminate the new one. Without it the order
   * would be `SEARCHING` and the guard would happily match.
   *
   * **The status change, its audit row and the order's remaining offers share
   * one transaction.** An order in a terminal state with no trail explaining
   * how it got there is one outcome this must never produce; an order that is
   * `NO_MASTER_FOUND` while a master's feed still shows a live offer on it is
   * the other. Closing the offers in a second statement afterwards would leave
   * a window in which both a customer read and a master read are true and
   * contradict each other.
   */
  async claimNoMasterFound(orderId: string, searchingSince: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute(sql`
        update orders
           set status = 'NO_MASTER_FOUND'
         where id = ${orderId}::uuid
           and status = 'SEARCHING'
           and ${searchingSinceOf(sql`orders.id`)} = ${searchingSince.getTime()}::bigint
      `);

      if ((claimed.rowCount ?? 0) === 0) {
        return false;
      }

      await this.recordTransition(orderId, 'SEARCHING', 'NO_MASTER_FOUND', { kind: 'system' }, tx);
      await this.offers.expireLiveOffers(orderId, tx);
      return true;
    });
  }

  /**
   * Appends one transition to the audit trail.
   *
   * Public because later Epics transition orders from their own services, and
   * every one of them writes here. There is no update path and no delete path,
   * by design and by trigger.
   *
   * **`executor` is how a caller writes this inside its own transaction**:
   * pass the open transaction and the status change and its audit row commit
   * together, or omit it and this opens nothing of its own. Defaulting to the
   * connection keeps every existing caller unchanged.
   *
   * Two callers need it absolutely rather than as a nicety. On the accept path
   * (issue #101) the conditional `UPDATE` that claims the order and this row
   * have to commit together, or a crash between them leaves an `ACCEPTED`
   * order whose trail says it is still searching. {@link claimNoMasterFound}
   * (issue #103) has the same requirement on the other terminal edge — see its
   * doc comment. `order_status_history` is append-only by trigger, so in
   * neither case can anything repair the gap afterwards.
   */
  async recordTransition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    actor: TransitionActorRecord,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor.insert(orderStatusHistory).values({
      id: uuidV7(),
      orderId,
      fromStatus: from,
      toStatus: to,
      actorKind: actor.kind,
      actorUserId: actor.userId ?? null,
      actorAdminId: actor.adminId ?? null,
      reason: actor.reason ?? null,
    });
  }
}
