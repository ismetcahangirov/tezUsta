import { Inject, Injectable } from '@nestjs/common';
import type { OrderActorKind, OrderStatus } from '@tezusta/types';
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import { conversations, messages } from '../../infra/database/schema/conversations';
import type { OrderRow } from '../../infra/database/schema/orders';
import { orders, orderStatusHistory } from '../../infra/database/schema/orders';
import { ConversationsRepository } from './conversations.repository';
import type { OrderPosition } from './order-cursor';
import { OrderOffersRepository } from './order-offers.repository';
import { searchingSinceOf } from './searching-since';

/**
 * The statuses in which an order has a master **and** is still live.
 *
 * **This list is written twice and must stay one fact.** The other copy is the
 * predicate of `orders_one_active_per_master` in `schema/orders.ts`, which
 * cannot import this: it is a partial index, and its predicate has to be
 * literal SQL that a migration can diff. The index is what makes
 * {@link OrdersRepository.findEngagedOrderIdForMaster} an index lookup, so the
 * day the two drift the query silently becomes a sequential scan on the hot
 * path — which is why a test asserts the plan instead of trusting this
 * comment.
 */
export const MASTER_ENGAGED_ORDER_STATUSES = [
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
] as const satisfies readonly OrderStatus[];

/** Everything an order carries on the way in. Nothing here is the server's to decide. */
export interface NewOrderFields {
  readonly customerId: string;
  readonly addressId: string;
  readonly serviceId: string;
  readonly description: string;
  readonly idempotencyKey: string;
}

/** Who to record against a transition, and why, if there is a why. */
/**
 * What a successful give-up hands back: who to tell.
 *
 * **The customer id rather than a boolean** (#144). The search ending in
 * silence is the case where silence is worst, so the caller has to notify
 * somebody — and reading the order again afterwards would be a second read
 * that could observe a third state, on a row this transaction has just moved.
 * `returning` costs nothing and cannot disagree with the write it belongs to.
 *
 * `null` from the claim means the conditional `UPDATE` matched nothing: a
 * master accepted, the customer cancelled, or a newer search replaced this
 * one. Nothing happened, so there is nobody to tell.
 */
export interface NoMasterFoundClaim {
  readonly customerId: string;
}

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

/**
 * Whether the conditional `UPDATE` moved the order, or found it somewhere
 * else.
 *
 * `stale` carries the row **as it actually is**, re-read inside the same
 * transaction. Reporting the status the caller read a moment ago would be a
 * lie by the time the client saw it, and re-reading outside the transaction
 * could observe a third state — this way the answer is the one that beat us.
 */
export type AdvanceOrderOutcome =
  | { readonly kind: 'advanced'; readonly order: OrderRow }
  | { readonly kind: 'stale'; readonly order: OrderRow };

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
    /**
     * And so {@link redispatch} can close the order's conversation in the
     * transaction that clears its master (issue #177) — the same pattern, for
     * a table this module also owns but whose SQL lives next door.
     */
    private readonly conversations: ConversationsRepository,
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
   * How many messages the customer has not read, per order, for a set of that
   * customer's orders (issue #182).
   *
   * **One statement for the whole page, never one per order.** The order list
   * shows a badge on every row, and a count fetched per row is the N+1 CLAUDE.md
   * §12 forbids — twenty rows would be twenty-one round trips on the screen a
   * customer opens most. The caller passes the ids of rows it has *already*
   * scoped to the customer, so this query needs no ownership predicate of its
   * own and adds none that could disagree with the list's.
   *
   * **The order's open conversation only**, which is the one
   * `GET /orders/:id/conversation` answers with: a re-dispatched order's
   * previous conversation is closed and belongs to a master who gave the job
   * up, and its unread tail is not something the customer can open any more.
   * "Unread" is the master's messages with no `read_at` — the same predicate as
   * `ConversationsRepository.countUnreadFor` for the customer side.
   *
   * **Both halves are index lookups.** The conversation per order comes from
   * `conversations_one_open_per_order`, the partial unique index whose
   * predicate is exactly `closed_at is null`; the messages come from
   * `messages_unread_idx`, the partial index over unread rows keyed by
   * `(conversation_id, sender_kind)`. So the cost is the number of unread
   * messages on the page, not the length of anybody's transcript.
   *
   * An order with no conversation, or nothing unread, is simply absent from the
   * map; the caller reads that as zero.
   */
  async countUnreadMessagesForCustomer(
    orderIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (orderIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({ orderId: conversations.orderId, unread: count(messages.id) })
      .from(conversations)
      .innerJoin(
        messages,
        and(
          eq(messages.conversationId, conversations.id),
          eq(messages.senderKind, 'master'),
          isNull(messages.readAt),
        ),
      )
      .where(and(inArray(conversations.orderId, [...orderIds]), isNull(conversations.closedAt)))
      .groupBy(conversations.orderId);

    return new Map(rows.map((row) => [row.orderId, row.unread]));
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
   * The order this master is currently on, if any (issue #169).
   *
   * **This runs on the hottest path in the system** — once per position
   * report, per master, all shift — so it returns an id and a status and
   * nothing else, and it has to be an index lookup rather than a scan
   * (CLAUDE.md §12).
   *
   * It is served by `orders_one_active_per_master`, the **partial unique**
   * index that already exists to make "a master holds at most one active
   * order" unraceable (`schema/orders.ts`). Its predicate is exactly
   * {@link MASTER_ENGAGED_ORDER_STATUSES}, so this `WHERE` is implied by the
   * index and Postgres can answer from it alone — which is why no second
   * index was added for this query. `test/master-position-fanout.e2e.test.ts`
   * asserts the plan rather than trusting that sentence.
   *
   * **The status set is the point, not a convenience.** `SEARCHING` has no
   * master by definition and every terminal status holds nobody, so an order
   * outside this set is one whose room must stop hearing this master's
   * position — which is the whole security surface of #169. `limit(1)` is
   * belt and braces: the unique index already guarantees at most one row.
   */
  async findEngagedOrderIdForMaster(masterId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(eq(orders.masterId, masterId), inArray(orders.status, MASTER_ENGAGED_ORDER_STATUSES)),
      )
      .limit(1);

    return row?.id;
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
       * Plainly descending, which is what the keyset cursor above compares and
       * what `orders_customer_created_idx` is now built to serve.
       *
       * This used to read `desc nulls last`, to match an index Drizzle's
       * `.desc()` had built as `DESC NULLS LAST`. That worked, and made the
       * idiomatic spelling the wrong one — the next `order by created_at desc`
       * written anywhere against this table would have silently gone back to
       * sorting. #191 moved the mismatch to the side that can be fixed once:
       * the index is declared plain `DESC`, and the query says what it means.
       */
      .orderBy(desc(orders.createdAt), desc(orders.id))
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
   * Orders that are still `SEARCHING` although their search window closed
   * before `cutoff` — the candidates a reconciler then checks against the
   * queue (#115).
   *
   * **Candidates, not orphans.** Everything answerable in SQL is answered
   * here; whether an order's schedule actually vanished is a question about
   * Redis, and this repository has no business asking it. In a healthy system
   * this returns nothing at all, because the give-up tick ends the search on
   * time.
   *
   * **`created_at` narrows, `searching_since` decides.** The first is a column
   * with `orders_status_created_idx` on `(status, created_at)` behind it; the
   * second is derived from the audit trail and cannot be indexed. They are not
   * the same value once EPIC 8 re-dispatches an order — but `created_at` is
   * always the earlier of the two, so filtering on it first is a superset that
   * costs an index range scan and never hides a row the real predicate would
   * have matched.
   *
   * The lateral join is what keeps {@link searchingSinceOf} to one evaluation
   * per row: written twice, once in the `WHERE` and once in the projection, it
   * would be a correlated subquery the planner may or may not collapse.
   *
   * `limit` is the caller's batch. Oldest first, so the customer who has been
   * staring at a spinner longest is the one reconciled first when a backlog
   * does not fit in one run.
   */
  async listStaleSearching(input: {
    cutoff: Date;
    limit: number;
  }): Promise<readonly { orderId: string; searchingSince: Date }[]> {
    const result = await this.db.execute<{ id: string; searching_since_ms: string }>(sql`
      select o.id::text as id, s.searching_since_ms
        from orders o
        join lateral (select ${searchingSinceOf(sql`o.id`)} as searching_since_ms) s on true
       where o.status = 'SEARCHING'
         and o.created_at < ${input.cutoff}
         and s.searching_since_ms < ${input.cutoff.getTime()}::bigint
       order by o.created_at asc
       limit ${input.limit}
    `);

    return result.rows.map((row) => ({
      orderId: row.id,
      searchingSince: new Date(Number(row.searching_since_ms)),
    }));
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
  async claimNoMasterFound(
    orderId: string,
    searchingSince: Date,
  ): Promise<NoMasterFoundClaim | null> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute<{ customer_id: string }>(sql`
        update orders
           set status = 'NO_MASTER_FOUND'
         where id = ${orderId}::uuid
           and status = 'SEARCHING'
           and ${searchingSinceOf(sql`orders.id`)} = ${searchingSince.getTime()}::bigint
        returning customer_id
      `);

      const row = claimed.rows[0];
      if (row === undefined) {
        return null;
      }

      await this.recordTransition(orderId, 'SEARCHING', 'NO_MASTER_FOUND', { kind: 'system' }, tx);
      await this.offers.expireLiveOffers(orderId, tx);
      return { customerId: row.customer_id };
    });
  }

  /**
   * Moves an order from one status to the next, and writes the audit row for
   * it, in one transaction (issue #134).
   *
   * **The `status = from` term is the concurrency guarantee, not the read the
   * caller did before calling this.** Two masters' taps — or one master's
   * double tap, or a client retrying on a flaky connection — both read
   * `ACCEPTED` and both arrive here. Under `READ COMMITTED` the second
   * `UPDATE` blocks on the row lock the first holds, then re-evaluates its
   * `WHERE` against the committed row: the status is no longer `from`, so it
   * matches nothing and the caller learns it lost. A read-then-write in the
   * service would instead write twice and leave two trail rows claiming the
   * same transition, which `order_status_history` being append-only makes
   * permanent.
   *
   * **Whether the edge is legal is not asked here.** That is
   * `assertOrderTransition`'s answer, and it is asked before this is called
   * — this file only knows how to write a transition down
   * (see the class comment). What this method guarantees is narrower and
   * load-bearing: that the status and its trail row commit together, so there
   * is no window in which an order has moved and nothing says why.
   */
  async advance(input: {
    readonly orderId: string;
    readonly from: OrderStatus;
    readonly to: OrderStatus;
    readonly actor: TransitionActorRecord;
  }): Promise<AdvanceOrderOutcome | undefined> {
    return this.db.transaction(async (tx) => {
      const [advanced] = await tx
        .update(orders)
        .set({ status: input.to })
        .where(and(eq(orders.id, input.orderId), eq(orders.status, input.from)))
        .returning();

      if (advanced !== undefined) {
        await this.recordTransition(input.orderId, input.from, input.to, input.actor, tx);
        return { kind: 'advanced', order: advanced };
      }

      const [current] = await tx.select().from(orders).where(eq(orders.id, input.orderId));

      // Undefined only for an order id that does not exist. `orders` is never
      // deleted — every foreign key onto it is `restrict` — so in practice
      // this is a caller that invented an id, and the service answers 404.
      return current === undefined ? undefined : { kind: 'stale', order: current };
    });
  }

  /**
   * Moves an order into a **terminal** status, closing out the offers it still
   * owns in the same transaction (issues #135, #137).
   *
   * **The offer close-out is the point, not the status column.** An order that
   * is finished while a master's feed still shows a live offer on it is a job
   * somebody can still tap accept on — the accept path's guard would correctly
   * refuse the claim, and the feed would incorrectly have shown the job in the
   * first place. The same requirement {@link claimNoMasterFound} carries on
   * the deadline's edge, and `backend-architecture.md` § Dispatch named the
   * cancelling and re-dispatching services as the ones that owed it.
   *
   * **Keyed on the target being terminal rather than on it being
   * `CANCELLED`.** The customer's cancellation was the first caller; an admin
   * override can drive `NO_MASTER_FOUND` from a live search and a dispute to
   * `RESOLVED` or `REFUNDED`, and each owes the same close-out for the same
   * reason. A method that asked which *actor* was ending the order, rather
   * than what the order was ending as, would leave that gap open by
   * construction.
   *
   * **`master_id` and `price_minor` are left alone**, and that is the
   * difference from re-dispatch. A finished order will never be accepted
   * again, so nothing needs the accept guard to match — and who was on the job
   * and at what price is exactly what a dispute would need to read.
   * `orders_one_active_per_master` covers none of the terminal statuses, so
   * the master is free for their next job regardless.
   *
   * The conditional `UPDATE` is the concurrency guarantee, for the reason
   * {@link advance} gives at length. A second cancellation of an
   * already-cancelled order matches zero rows and is reported as `stale` — a
   * 409, never a silent 200.
   */
  async finish(input: {
    readonly orderId: string;
    readonly from: OrderStatus;
    readonly to: OrderStatus;
    readonly actor: TransitionActorRecord;
  }): Promise<AdvanceOrderOutcome | undefined> {
    return this.db.transaction(async (tx) => {
      const [finished] = await tx
        .update(orders)
        .set({ status: input.to })
        .where(and(eq(orders.id, input.orderId), eq(orders.status, input.from)))
        .returning();

      if (finished === undefined) {
        const [current] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
        return current === undefined ? undefined : { kind: 'stale', order: current };
      }

      await this.recordTransition(input.orderId, input.from, input.to, input.actor, tx);
      await this.offers.expireLiveOffers(input.orderId, tx);

      return { kind: 'advanced', order: finished };
    });
  }

  /**
   * Sends an order back out because the assigned master cannot come:
   * `ACCEPTED` / `MASTER_ON_THE_WAY` / `MASTER_ARRIVED` -> `SEARCHING`, or
   * `-> NO_MASTER_FOUND` once the order has used up its re-dispatches
   * (issue #136, ADR-0015 § Re-dispatch).
   *
   * **`master_id` is cleared because the accept guard depends on it**, not for
   * tidiness. `backend-architecture.md` says it in as many words: the accept
   * path claims an order with `where status = 'SEARCHING' and master_id is
   * null`, so an order that kept the previous master on the row would search
   * with no possible winner until it gave up. `price_minor` goes with it
   * ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)): the price
   * belonged to the master who is no longer coming, and a re-dispatched order
   * is priceless again until somebody new accepts. `accepted_at` goes too, or
   * `orders_accepted_at_requires_master` would refuse the row outright.
   *
   * **The cap is tested and the counter incremented in the same statement**,
   * so two concurrent re-dispatches cannot both read a count under the cap and
   * both pass it. Expressed as a `CASE` over the stored count rather than as a
   * value this process computed, for the same reason the status guard is a
   * `WHERE`: a read-then-write is exactly the race this is here to lose.
   *
   * **At the cap the order walks two edges, not one, and that is deliberate.**
   * ADR-0015 says the order "goes to `NO_MASTER_FOUND` rather than searching
   * again" — and the very same ADR's table contains no `ACCEPTED ->
   * NO_MASTER_FOUND` edge. Both statements are kept true by doing what the
   * words say: the re-dispatch happens, and the search it started ends
   * immediately, in one transaction, leaving two trail rows that are each a
   * real edge driven by a real actor — the master's `-> SEARCHING`, and
   * `system`'s `SEARCHING -> NO_MASTER_FOUND`. Writing one row for a pair the
   * table does not contain would have made `order-lifecycle.ts` stop being the
   * only thing that knows the edges, which is the one property it claims.
   *
   * The counter is incremented on that path too. A master did drop the job,
   * and the count is the record of how many times that has happened to this
   * order — not a budget with a refund for the attempt that failed.
   *
   * **Nothing here excludes the dropping master from the next broadcast,
   * because nothing has to.** Their `order_offers` row reads `accepted` and the
   * broadcast upsert never touches an `accepted` row. Every *other* master the
   * previous search reached is left at `lost`, which the upsert does re-offer
   * — which is what makes the second search reach anybody at all
   * (`order-offers.repository.ts`).
   */
  async redispatch(input: {
    readonly orderId: string;
    readonly from: OrderStatus;
    readonly actor: TransitionActorRecord;
    readonly maxRedispatches: number;
  }): Promise<AdvanceOrderOutcome | undefined> {
    return this.db.transaction(async (tx) => {
      const [moved] = await tx
        .update(orders)
        .set({
          status: sql`(case
            when ${orders.redispatchCount} >= ${input.maxRedispatches} then 'NO_MASTER_FOUND'
            else 'SEARCHING'
          end)::order_status`,
          masterId: null,
          priceMinor: null,
          acceptedAt: null,
          redispatchCount: sql`${orders.redispatchCount} + 1`,
        })
        .where(and(eq(orders.id, input.orderId), eq(orders.status, input.from)))
        .returning();

      if (moved === undefined) {
        const [current] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
        return current === undefined ? undefined : { kind: 'stale', order: current };
      }

      await this.recordTransition(input.orderId, input.from, 'SEARCHING', input.actor, tx);

      // The master who held the job has given it up, so the channel to the
      // customer goes with it (issue #177, ADR-0033 § 2). In this transaction
      // because `orders.master_id` is being cleared in the same statement: a
      // conversation left open against an order with no master is a channel
      // whose second party the row no longer names, and the next accept would
      // then collide with `conversations_one_open_per_order` rather than
      // opening a fresh conversation for the master who actually took the job.
      await this.conversations.closeForOrder(input.orderId, new Date(), tx);

      if (moved.status === 'NO_MASTER_FOUND') {
        await this.recordTransition(
          input.orderId,
          'SEARCHING',
          'NO_MASTER_FOUND',
          // `system`, with no actor id: the order ran out of re-dispatches,
          // which is a supply fact. The master who dropped the job is named on
          // the row above, where they belong (ADR-0015).
          { kind: 'system' },
          tx,
        );
        // The same close-out `claimNoMasterFound` performs, and for the same
        // reason: a terminal order and a live offer on it must never both be
        // readable. Nothing is normally live at this point — the accept marked
        // the others `lost` — so this is the guarantee rather than the usual
        // case.
        await this.offers.expireLiveOffers(input.orderId, tx);
      }

      return { kind: 'advanced', order: moved };
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
