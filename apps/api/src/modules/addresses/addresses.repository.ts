import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type { AddressRow } from '../../infra/database/schema/addresses';
import { addresses } from '../../infra/database/schema/addresses';

/**
 * The column values an address carries, apart from ownership and defaulting —
 * the shape of a **patch**, where absent means "leave it alone" and `null`
 * means "clear it".
 *
 * Every optional member spells `| undefined` explicitly. Under
 * `exactOptionalPropertyTypes` that is a different type from a bare `?`, and
 * the values arriving here come from Zod `.optional()`, which produces the
 * explicit form.
 */
export interface AddressFields {
  readonly label?: string | null | undefined;
  readonly formattedAddress?: string | undefined;
  readonly building?: string | null | undefined;
  readonly entrance?: string | null | undefined;
  readonly floor?: string | null | undefined;
  readonly apartment?: string | null | undefined;
  readonly landmarkNote?: string | null | undefined;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
}

/** Everything an address needs on the way in; the optional ones may be absent. */
export interface NewAddressFields {
  readonly label?: string | null | undefined;
  readonly formattedAddress: string;
  readonly building?: string | null | undefined;
  readonly entrance?: string | null | undefined;
  readonly floor?: string | null | undefined;
  readonly apartment?: string | null | undefined;
  readonly landmarkNote?: string | null | undefined;
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Creation either happened or hit the per-customer cap. Returned rather than
 * thrown because the cap is checked **inside** the transaction that inserts —
 * the only place where "how many live addresses does this customer have?" and
 * "insert one more" cannot be separated by another request.
 */
export type CreateAddressOutcome =
  { readonly kind: 'created'; readonly address: AddressRow } | { readonly kind: 'limit-reached' };

/**
 * `ST_SetSRID(ST_MakePoint(lng, lat), 4326)` — the write path for `position`,
 * and the reason it is hand-written SQL rather than a Drizzle value.
 *
 * `drizzle-orm@0.45.2`'s `PgGeometryObject.mapToDriverValue` emits
 * `point(x y)`, which Postgres reads as SRID 0. The column is declared
 * `geometry(Point,4326)` in the migration (ADR-0018: the SRID constraint has to
 * be written by hand or there will not be one), and that typmod rejects an
 * SRID-0 value outright. Writing the constructor explicitly is what makes the
 * two agree — verified against the shipped package rather than assumed
 * (CLAUDE.md §9).
 *
 * **Longitude first.** `ST_MakePoint` takes x then y, and x is longitude. The
 * ordering is pinned by a round-trip test asserting `ST_X` returns the
 * longitude, because a swap is invisible to every bound check in Baku, where
 * both numbers are inside each other's range.
 */
function positionValue(latitude: number, longitude: number) {
  return sql`ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)`;
}

/**
 * Drizzle queries over `addresses`. Every read filters `deleted_at IS NULL`: a
 * soft-deleted address must behave as absent to every caller, and leaving that
 * to each call site is how a deleted address eventually answers a request.
 *
 * The methods that touch `is_default` are transactional, because "exactly one
 * default" is a statement about the whole set and not about one row. The
 * partial unique index is what enforces it; these transactions are what stop
 * the index from turning an ordinary concurrent promotion into a 500.
 */
@Injectable()
export class AddressesRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async listByCustomer(customerId: string): Promise<AddressRow[]> {
    return (
      this.db
        .select()
        .from(addresses)
        .where(and(eq(addresses.customerId, customerId), isNull(addresses.deletedAt)))
        // Default first, then newest — the order `addresses_customer_live_idx`
        // is built in, so this comes out of the index rather than out of a sort.
        .orderBy(desc(addresses.isDefault), desc(addresses.createdAt))
    );
  }

  async findById(id: string): Promise<AddressRow | undefined> {
    const [row] = await this.db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, id), isNull(addresses.deletedAt)))
      .limit(1);
    return row;
  }

  /**
   * Inserts an address, applying the two rules that only make sense with the
   * customer's whole set in view: the cap, and "a customer's first address is
   * their default whatever they asked for".
   *
   * All three steps share one transaction. Counting outside it would let fifty
   * concurrent requests each read forty-nine; promoting outside it would leave
   * a window in which the customer has no default at all.
   */
  async create(input: {
    customerId: string;
    fields: NewAddressFields;
    makeDefault: boolean;
    maxLiveAddresses: number;
  }): Promise<CreateAddressOutcome> {
    return this.db.transaction(async (tx) => {
      const liveCount = await this.countLive(input.customerId, tx);
      if (liveCount >= input.maxLiveAddresses) {
        return { kind: 'limit-reached' };
      }

      // The first address is the default whether or not the client asked: a
      // customer who has addresses always has exactly one default, and leaving
      // the first one unmarked would mean order creation has nothing to
      // pre-select.
      const isDefault = input.makeDefault || liveCount === 0;
      if (isDefault) {
        await this.clearDefault(input.customerId, tx);
      }

      const [created] = await tx
        .insert(addresses)
        .values({
          id: uuidV7(),
          customerId: input.customerId,
          label: input.fields.label ?? null,
          formattedAddress: input.fields.formattedAddress,
          building: input.fields.building ?? null,
          entrance: input.fields.entrance ?? null,
          floor: input.fields.floor ?? null,
          apartment: input.fields.apartment ?? null,
          landmarkNote: input.fields.landmarkNote ?? null,
          position: positionValue(input.fields.latitude, input.fields.longitude),
          isDefault,
        })
        .returning();

      if (created === undefined) {
        // Unreachable: an INSERT ... RETURNING of one row returns one row, and
        // a constraint violation throws instead. Present so the narrowing is
        // explicit rather than an assertion.
        throw new Error('Insert into addresses returned no row.');
      }
      return { kind: 'created', address: created };
    });
  }

  /**
   * Updates one address, optionally promoting it to default in the same
   * transaction as the demotion of whatever held that place.
   *
   * The demotion has to precede the promotion inside one transaction or the
   * partial unique index rejects the second of two concurrent promotions with
   * a constraint violation the caller cannot act on. Because the demoting
   * UPDATE takes a row lock on the current default, two such requests
   * serialise behind it instead of colliding — which is what the concurrent
   * test asserts.
   */
  async update(input: {
    id: string;
    customerId: string;
    fields: AddressFields;
    makeDefault: boolean;
  }): Promise<AddressRow | undefined> {
    return this.db.transaction(async (tx) => {
      if (input.makeDefault) {
        await this.clearDefault(input.customerId, tx);
      }

      const patch: Record<string, unknown> = {};
      const { fields } = input;
      if (fields.label !== undefined) patch['label'] = fields.label;
      if (fields.formattedAddress !== undefined)
        patch['formattedAddress'] = fields.formattedAddress;
      if (fields.building !== undefined) patch['building'] = fields.building;
      if (fields.entrance !== undefined) patch['entrance'] = fields.entrance;
      if (fields.floor !== undefined) patch['floor'] = fields.floor;
      if (fields.apartment !== undefined) patch['apartment'] = fields.apartment;
      if (fields.landmarkNote !== undefined) patch['landmarkNote'] = fields.landmarkNote;
      if (fields.latitude !== undefined && fields.longitude !== undefined) {
        patch['position'] = positionValue(fields.latitude, fields.longitude);
      }
      if (input.makeDefault) patch['isDefault'] = true;

      if (Object.keys(patch).length === 0) {
        // Nothing to write, but the caller still expects the current row back.
        // Reached when a patch contained only `isDefault: false` on an address
        // that was not the default — a no-op the API boundary lets through
        // because refusing it would be pedantry, not safety.
        return this.findByIdWithin(input.id, tx);
      }

      const [row] = await tx
        .update(addresses)
        .set(patch)
        .where(and(eq(addresses.id, input.id), isNull(addresses.deletedAt)))
        .returning();
      return row;
    });
  }

  /**
   * Soft-deletes an address and, when it was the default, promotes the oldest
   * surviving one in the same transaction.
   *
   * Oldest rather than newest: the default is the address a customer orders to
   * most of the time, and the one they have had longest is the better guess at
   * that than the one they added last — which may well be the single-use
   * address they are deleting around.
   */
  async softDelete(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(addresses)
        .set({ deletedAt: new Date(), isDefault: false })
        .where(and(eq(addresses.id, id), isNull(addresses.deletedAt)))
        .returning({ customerId: addresses.customerId });

      if (deleted === undefined) {
        return false;
      }

      // The deleted row's own `is_default` is not consulted, and could not be:
      // `returning()` reports values AFTER the update, where it is already
      // false. Asking the set instead — "is anyone the default now?" — is both
      // correct and the question that actually matters, and it also repairs a
      // customer who somehow had no default at all.
      const [survivor] = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(
          and(
            eq(addresses.customerId, deleted.customerId),
            isNull(addresses.deletedAt),
            eq(addresses.isDefault, true),
          ),
        )
        .limit(1);

      if (survivor === undefined) {
        const [oldest] = await tx
          .select({ id: addresses.id })
          .from(addresses)
          .where(and(eq(addresses.customerId, deleted.customerId), isNull(addresses.deletedAt)))
          .orderBy(asc(addresses.createdAt))
          .limit(1);

        if (oldest !== undefined) {
          await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, oldest.id));
        }
      }

      return true;
    });
  }

  private async countLive(customerId: string, executor: DatabaseExecutor): Promise<number> {
    const [row] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(addresses)
      .where(and(eq(addresses.customerId, customerId), isNull(addresses.deletedAt)));
    return row?.count ?? 0;
  }

  private async clearDefault(customerId: string, executor: DatabaseExecutor): Promise<void> {
    await executor
      .update(addresses)
      .set({ isDefault: false })
      .where(
        and(
          eq(addresses.customerId, customerId),
          eq(addresses.isDefault, true),
          isNull(addresses.deletedAt),
        ),
      );
  }

  private async findByIdWithin(
    id: string,
    executor: DatabaseExecutor,
  ): Promise<AddressRow | undefined> {
    const [row] = await executor
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, id), isNull(addresses.deletedAt)))
      .limit(1);
    return row;
  }
}
