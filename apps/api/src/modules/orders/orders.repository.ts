import { Inject, Injectable } from '@nestjs/common';
import type { OrderActorKind, OrderStatus } from '@tezusta/types';
import { and, eq, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type { OrderRow } from '../../infra/database/schema/orders';
import { orders, orderStatusHistory } from '../../infra/database/schema/orders';

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

/**
 * Drizzle queries for `orders` and its audit trail. No business rules here —
 * whether a transition is legal is `order-lifecycle.ts`'s answer, and this
 * file only knows how to write one down.
 */
@Injectable()
export class OrdersRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

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
   */
  async findByIdForCustomer(id: string, customerId: string): Promise<OrderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.customerId, customerId)))
      .limit(1);

    return row;
  }

  /**
   * Appends one transition to the audit trail.
   *
   * Public because later Epics transition orders from their own services, and
   * every one of them writes here. There is no update path and no delete path,
   * by design and by trigger.
   */
  async recordTransition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    actor: TransitionActorRecord,
  ): Promise<void> {
    await this.db.insert(orderStatusHistory).values({
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
