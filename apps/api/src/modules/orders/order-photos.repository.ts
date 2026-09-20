import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type { OrderPhotoRow } from '../../infra/database/schema/order-photos';
import { orderPhotos } from '../../infra/database/schema/order-photos';
import { orders } from '../../infra/database/schema/orders';

/**
 * What an attach attempt found, told apart so the service can answer each
 * case with the right status code rather than one shared `undefined`.
 *
 * A discriminated union rather than three booleans, for the reason every
 * outcome type in this codebase is one: the compiler refuses a branch that
 * forgets a case.
 */
export type AttachOutcome =
  | { readonly kind: 'attached'; readonly row: OrderPhotoRow }
  | { readonly kind: 'limit_exceeded' }
  | { readonly kind: 'already_attached' };

/**
 * Internal signal that the photo half of the attach transaction lost a race,
 * used to unwind the `orders.photo_count` claim rather than leave it
 * committed against a photo that never actually attached.
 *
 * Never escapes the repository — `attach` catches it and maps it to
 * `{ kind: 'already_attached' }`, the same shape
 * `master-verification.repository.ts`'s `ConfirmRaceLostError` takes.
 */
class AttachRaceLostError extends Error {
  constructor() {
    super('Another request attached this photo first.');
    this.name = 'AttachRaceLostError';
    Object.setPrototypeOf(this, AttachRaceLostError.prototype);
  }
}

/**
 * Drizzle queries over `order_photos`, plus the one statement that also
 * touches `orders` — the atomic claim on `orders.photo_count`.
 *
 * **Every read that resolves a customer's own photo is scoped by
 * `customer_id` as well as by the photo's own id**, the same rule
 * `MasterVerificationRepository` follows for `master_documents`: the
 * ownership check belongs in the `WHERE` clause, not only in the service
 * above it.
 */
@Injectable()
export class OrderPhotosRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * The customer's abandoned presign, if there is one.
   *
   * A row in `awaiting_upload` holds a key that was issued and never
   * confirmed — and, per ADR-0024 §3, a live write capability into a billed
   * bucket for the rest of its TTL. `order_photos_pending_upload_unique`
   * allows exactly one such row per customer, so minting a replacement has
   * to clear it first — same rule `MasterVerificationRepository#findPendingUpload`
   * follows for `master_documents`, with the customer playing the role a
   * document type plays there.
   */
  async findPendingUpload(customerId: string): Promise<OrderPhotoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(orderPhotos)
      .where(and(eq(orderPhotos.customerId, customerId), eq(orderPhotos.status, 'awaiting_upload')))
      .limit(1);
    return row;
  }

  /**
   * Discards an abandoned presign. A hard delete, and the only one in this
   * module — same reasoning as `MasterVerificationRepository#deletePendingUpload`:
   * the row records that a URL was minted, not that anything happened, and
   * the caller deletes the object alongside it.
   */
  async deletePendingUpload(id: string): Promise<void> {
    await this.db
      .delete(orderPhotos)
      .where(and(eq(orderPhotos.id, id), eq(orderPhotos.status, 'awaiting_upload')));
  }

  async createPendingUpload(input: {
    customerId: string;
    storageKey: string;
    declaredContentType: string;
    presignExpiresAt: Date;
  }): Promise<OrderPhotoRow> {
    const [row] = await this.db
      .insert(orderPhotos)
      .values({ id: uuidV7(), ...input })
      .returning();
    if (row === undefined) {
      throw new Error('Insert of order_photos returned no row.');
    }
    return row;
  }

  /** Scoped by customer id as well as photo id — see the class comment. */
  async findOwnPhoto(customerId: string, photoId: string): Promise<OrderPhotoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(orderPhotos)
      .where(and(eq(orderPhotos.id, photoId), eq(orderPhotos.customerId, customerId)))
      .limit(1);
    return row;
  }

  /**
   * Turns an uploaded object into a confirmed photo — a conditional UPDATE,
   * exactly `MasterVerificationRepository#confirmUpload`'s single-use
   * mechanism: S3 offers no native single-use presigned URL, so this row's
   * `awaiting_upload` → `confirmed` transition, guarded on still being
   * `awaiting_upload`, is what makes confirming one twice impossible. Returns
   * `undefined` when the row was no longer `awaiting_upload` — the caller
   * lost the race, or is confirming an already-confirmed photo.
   */
  async confirmUpload(input: {
    customerId: string;
    photoId: string;
    sizeBytes: number;
    verifiedContentType: string;
    now: Date;
  }): Promise<OrderPhotoRow | undefined> {
    const [row] = await this.db
      .update(orderPhotos)
      .set({
        status: 'confirmed',
        sizeBytes: input.sizeBytes,
        verifiedContentType: input.verifiedContentType,
        submittedAt: input.now,
      })
      .where(
        and(
          eq(orderPhotos.id, input.photoId),
          eq(orderPhotos.customerId, input.customerId),
          eq(orderPhotos.status, 'awaiting_upload'),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Attaches a confirmed photo to an order, claiming one of its photo slots
   * in the same transaction.
   *
   * **Two atomic guards, not a read-then-write anywhere:**
   *
   * 1. `orders.photo_count` is incremented WHERE it is still under the
   *    configured cap — the same shape the "master's one active order"
   *    invariant and the accept guard take (`backend-module` skill § the
   *    guarded transition): the limit is evaluated *by the database*, in the
   *    `WHERE` clause of the write that would exceed it, so two concurrent
   *    attaches on the same order cannot both believe they got the last slot.
   * 2. `order_photos.status` moves `confirmed` → `attached` WHERE it is still
   *    `confirmed` and still owned by this customer — the same conditional
   *    transition `confirmUpload` uses, which is what makes a double attach
   *    (the same photo, or two concurrent requests for the same photo)
   *    impossible even though the service already checked the status a
   *    moment earlier.
   *
   * If the second guard loses after the first one won, the whole transaction
   * is rolled back — including the count claim — by throwing
   * {@link AttachRaceLostError} rather than committing a slot spent on a photo
   * that never actually attached.
   */
  async attach(input: {
    orderId: string;
    customerId: string;
    photoId: string;
    maxPhotos: number;
    now: Date;
  }): Promise<AttachOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(orders)
          .set({ photoCount: sql`${orders.photoCount} + 1` })
          .where(and(eq(orders.id, input.orderId), lt(orders.photoCount, input.maxPhotos)))
          .returning({ photoCount: orders.photoCount });

        if (claimed === undefined) {
          return { kind: 'limit_exceeded' } as const;
        }

        const [row] = await tx
          .update(orderPhotos)
          .set({ orderId: input.orderId, status: 'attached', attachedAt: input.now })
          .where(
            and(
              eq(orderPhotos.id, input.photoId),
              eq(orderPhotos.customerId, input.customerId),
              eq(orderPhotos.status, 'confirmed'),
            ),
          )
          .returning();

        if (row === undefined) {
          throw new AttachRaceLostError();
        }

        return { kind: 'attached', row } as const;
      });
    } catch (error) {
      if (error instanceof AttachRaceLostError) {
        return { kind: 'already_attached' };
      }
      throw error;
    }
  }

  /**
   * Everything attached to one order — the customer's own read and the
   * master's.
   *
   * Filters on `status = 'attached'` explicitly, not `order_id is not null`:
   * the two happen to coincide today because `order_photos_lifecycle_shape`
   * ties them together, but that CHECK is declared in a different file
   * (`infra/database/schema/order-photos.ts`), and a read whose correctness
   * depends on a constraint it never names is a read one edit away from being
   * wrong. Naming the status this cares about directly means it stays correct
   * even if the lifecycle shape ever grows a state — a `detached`, say — that
   * keeps `order_id` set for history without the row still being live.
   */
  async listAttachedForOrder(orderId: string): Promise<OrderPhotoRow[]> {
    return this.db
      .select()
      .from(orderPhotos)
      .where(and(eq(orderPhotos.orderId, orderId), eq(orderPhotos.status, 'attached')))
      .orderBy(asc(orderPhotos.createdAt));
  }

  /**
   * Everything attached to **several** orders at once, grouped by order id —
   * the master's offer feed (issue #101).
   *
   * One `where order_id = any($1)` instead of one statement per order. The
   * feed returns up to `MAX_FEED_OFFERS` cards and each card carries its
   * order's photos, so the per-order shape was 1 + N round trips on the one
   * endpoint a master's app polls continuously until EPIC 9's realtime
   * channel lands (CLAUDE.md §12). The same partial
   * `order_photos_order_idx` serves it — `= any(...)` over a handful of ids
   * is a bitmap of index scans, not a table scan.
   *
   * Orders with nothing attached are simply absent from the map rather than
   * present with an empty array: the caller reads it with `?? []`, and an
   * absent key and an empty array mean the same thing here.
   */
  async listAttachedForOrders(orderIds: readonly string[]): Promise<Map<string, OrderPhotoRow[]>> {
    const grouped = new Map<string, OrderPhotoRow[]>();
    if (orderIds.length === 0) {
      return grouped;
    }

    const rows = await this.db
      .select()
      .from(orderPhotos)
      .where(and(inArray(orderPhotos.orderId, [...orderIds]), eq(orderPhotos.status, 'attached')))
      .orderBy(asc(orderPhotos.createdAt));

    for (const row of rows) {
      if (row.orderId === null) {
        continue;
      }
      const existing = grouped.get(row.orderId);
      if (existing === undefined) {
        grouped.set(row.orderId, [row]);
      } else {
        existing.push(row);
      }
    }

    return grouped;
  }

  /**
   * One photo, scoped to the order it is actually attached to.
   *
   * Used by every download path — the owning customer, the assigned master,
   * and an admin (`admin-order-photos.service.ts`) — because "is this photo
   * attached to *this* order" is the one predicate all three need, and
   * scoping it here means a photo id that belongs to a different order
   * answers 404 the same way a photo id that does not exist does.
   */
  async findByOrderAndId(orderId: string, photoId: string): Promise<OrderPhotoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(orderPhotos)
      .where(and(eq(orderPhotos.id, photoId), eq(orderPhotos.orderId, orderId)))
      .limit(1);
    return row;
  }

  /**
   * Photos that were confirmed and then abandoned — `confirmed`, no order,
   * and submitted at or before `cutoff`. The candidate list for the sweep
   * (#92), bounded by `limit`.
   *
   * `submitted_at` rather than `created_at`: the clock that matters starts
   * when the bytes became real, not when the URL was minted. A row that never
   * got that far is `awaiting_upload` and belongs to the presign path, which
   * already clears it on the next presign.
   *
   * Deliberately **not** `order_id is null` as the sole predicate: naming the
   * status directly is the rule {@link listAttachedForOrder} states — a read
   * whose correctness depends on a CHECK declared in another file is one edit
   * away from being wrong.
   */
  async listAbandoned(cutoff: Date, limit: number): Promise<OrderPhotoRow[]> {
    return this.db
      .select()
      .from(orderPhotos)
      .where(
        and(
          eq(orderPhotos.status, 'confirmed'),
          isNull(orderPhotos.orderId),
          lte(orderPhotos.submittedAt, cutoff),
        ),
      )
      .orderBy(asc(orderPhotos.submittedAt))
      .limit(limit);
  }

  /**
   * Deletes one abandoned photo, and its bytes with it. Returns `false` when
   * the row was no longer abandoned — a customer attached it between the
   * listing above and this call, and their photo must survive.
   *
   * **Three orderings are possible and only this one is safe.**
   *
   * *Row first, object second* — what `order-photos.service.ts#presignUpload`
   * does, correctly, because a replacement presign is about to be minted
   * regardless. Wrong here: the one time the storage call fails, the row is
   * gone and the bytes are orphaned forever, which is the exact problem this
   * sweep exists to solve.
   *
   * *Object first, row second, with no transaction* — appealing, because a
   * single-row delete does not need one and the storage call cannot be rolled
   * back anyway. It loses to a race: a customer attaching this photo between
   * the two steps makes the conditional DELETE match nothing, and their
   * now-`attached` photo keeps a row whose bytes have already been deleted. A
   * broken attached photo is worse than either failure above.
   *
   * *This one.* The transaction is **not** here to make the row and the object
   * move together — it cannot, and claiming so would be a lie. It is here for
   * the lock: the conditional DELETE takes the row before the object is
   * touched, so a concurrent attach blocks and then finds no row rather than
   * finding one whose bytes are gone. The guard being in the `WHERE` clause is
   * the same discipline every other write in this file uses.
   *
   * A storage failure therefore rolls the row back and the next sweep retries.
   * Should the commit itself fail after the object is gone, the next sweep
   * deletes a key that is already absent — `StorageProvider.delete` is
   * specified idempotent, and both implementations are (the stub drops a
   * missing key from its map; S3's `DeleteObject` answers success for a key
   * that does not exist) — and removes the row: the discrepancy heals rather
   * than persisting.
   *
   * `deleteObject` is a callback rather than a `StorageProvider`, so this
   * repository keeps knowing nothing about storage.
   */
  async deleteAbandoned(
    photoId: string,
    deleteObject: (storageKey: string) => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(orderPhotos)
        .where(
          and(
            eq(orderPhotos.id, photoId),
            eq(orderPhotos.status, 'confirmed'),
            isNull(orderPhotos.orderId),
          ),
        )
        .returning({ storageKey: orderPhotos.storageKey });

      if (row === undefined) {
        return false;
      }

      await deleteObject(row.storageKey);
      return true;
    });
  }
}
