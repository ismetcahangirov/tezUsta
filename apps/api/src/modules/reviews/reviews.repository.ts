import { Inject, Injectable } from '@nestjs/common';
import type { OrderStatus, ReviewAuthorRole } from '@tezusta/types';
import { and, asc, eq, isNull, min, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor, Transaction } from '../../infra/database/database.types';
import { customers } from '../../infra/database/schema/customers';
import { masters } from '../../infra/database/schema/masters';
import { orders, orderStatusHistory } from '../../infra/database/schema/orders';
import type { ReviewRow } from '../../infra/database/schema/reviews';
import { reviews } from '../../infra/database/schema/reviews';

/** What a review decision needs to know about an order. */
export interface ReviewOrderContext {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly customerId: string;
  readonly masterId: string | null;
  /** When the order entered `COMPLETED`, from its trail; null if it never has. */
  readonly completedAt: Date | null;
}

/**
 * The service's verdict on a locked order: nothing (go ahead), or the refusal.
 * Passed in rather than decided here, because whether a status is reviewable
 * and whether a window is open are business rules (`review-window.ts`), and
 * this file only knows how to read and write rows — the shape
 * `calls.repository.ts#createUnlessBusy` takes with `isCallableStatus`.
 */
export type ReviewWriteCheck<Refusal> = (context: ReviewOrderContext, now: Date) => Refusal | null;

/** Who is writing, as the service resolved it before the transaction began. */
export interface ReviewAuthor {
  readonly role: ReviewAuthorRole;
  /** The customer and master the service found on the order; re-checked under the lock. */
  readonly customerId: string;
  readonly masterId: string;
}

export type SubmitReviewOutcome<Refusal> =
  | { readonly kind: 'created'; readonly review: ReviewRow }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'not-party' }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

export type EditReviewOutcome<Refusal> =
  | { readonly kind: 'edited'; readonly review: ReviewRow }
  | { readonly kind: 'revealed' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-party' }
  | { readonly kind: 'refused'; readonly refusal: Refusal };

/**
 * Drizzle queries for `reviews` (issue #222).
 *
 * **It reads `orders` and `order_status_history`, and writes the two rating
 * aggregates, inside its own transactions** — the one place this module
 * reaches past its own table, and for the reason `calls.repository.ts` reads
 * `orders` `FOR SHARE`: the checks that make a review legal must hold at the
 * instant it is written, which only a lock taken in the writing transaction
 * can promise, and the aggregate must move in the same transaction as the
 * reveal or a crash between the two would leave it permanently wrong
 * ([ADR-0042](docs/decisions/ADR-0042-review-policy.md) § 6). The aggregate
 * columns exist for reviews and nothing else writes them.
 */
@Injectable()
export class ReviewsRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * The order and when it was completed, unlocked — for resolving which side
   * the caller is on, and for the read endpoint.
   */
  async findOrderContext(
    orderId: string,
    executor: DatabaseExecutor = this.db,
  ): Promise<ReviewOrderContext | undefined> {
    const [order] = await executor
      .select({
        orderId: orders.id,
        status: orders.status,
        customerId: orders.customerId,
        masterId: orders.masterId,
      })
      .from(orders)
      .where(eq(orders.id, orderId));

    if (order === undefined) {
      return undefined;
    }

    return { ...order, completedAt: await this.completedAt(orderId, executor) };
  }

  /** Both reviews on an order, if they exist — the caller filters what the reader may see. */
  async listForOrder(orderId: string): Promise<ReviewRow[]> {
    return this.db
      .select()
      .from(reviews)
      .where(eq(reviews.orderId, orderId))
      .orderBy(asc(reviews.authorRole));
  }

  /**
   * Writes the caller's review, and — if it is the second one — reveals both
   * and moves both aggregates, in one transaction.
   *
   * **Two submissions on one order are serialised**, by a transaction-scoped
   * advisory lock on the order taken before anything is read. Without it, the
   * customer and the master submitting at the same moment would each insert,
   * each look for the other's review, each fail to see an insert the other had
   * not committed, and both reviews would stay sealed until the window closed.
   * With it, the second transaction waits, and — under READ COMMITTED, where
   * every statement takes a fresh snapshot — then sees the first one's
   * committed row and reveals the pair. A row lock on the order would do the
   * same, but the only one strong enough to exclude itself (`FOR NO KEY
   * UPDATE`) would also queue every unrelated writer of the order row behind
   * a review; the advisory lock scopes the exclusion to reviews.
   *
   * **The order is then read `FOR SHARE`** (ADR-0042 § Integrity), so a
   * concurrent status change cannot slip between the eligibility check and
   * the insert: a transition that has not committed waits for this
   * transaction, and one that has is seen here.
   *
   * **A duplicate is `ON CONFLICT DO NOTHING`**, not a read first: the unique
   * index is the authority on "one review per side per order", and the lock
   * above is not what makes it true.
   */
  async submit<Refusal>(input: {
    readonly orderId: string;
    readonly author: ReviewAuthor;
    readonly rating: number;
    readonly comment: string | null;
    readonly check: ReviewWriteCheck<Refusal>;
  }): Promise<SubmitReviewOutcome<Refusal>> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lockOrder(tx, input.orderId);

      if (locked === undefined || !isSameParties(locked.context, input.author)) {
        return { kind: 'not-party' } as const;
      }

      const refusal = input.check(locked.context, locked.now);
      if (refusal !== null) {
        return { kind: 'refused', refusal } as const;
      }

      const [inserted] = await tx
        .insert(reviews)
        .values({
          id: uuidV7(),
          orderId: input.orderId,
          customerId: input.author.customerId,
          masterId: input.author.masterId,
          authorRole: input.author.role,
          rating: input.rating,
          comment: input.comment,
        })
        .onConflictDoNothing({ target: [reviews.orderId, reviews.authorRole] })
        .returning();

      if (inserted === undefined) {
        return { kind: 'duplicate' } as const;
      }

      const revealed = await this.revealIfBothWritten(tx, input.orderId);
      return { kind: 'created', review: revealed.get(inserted.id) ?? inserted } as const;
    });
  }

  /**
   * Replaces the rating and comment of the caller's **sealed** review, under
   * the same lock and checks as {@link submit}.
   *
   * The guard `revealed_at IS NULL` is in the `UPDATE`'s own `WHERE` — a
   * revealed review is frozen (ADR-0042 § 4), and deciding that from a read
   * made a moment earlier would be the read-then-write the backend rules
   * forbid. When nothing matched, one more read says which of the two reasons
   * it was.
   */
  async edit<Refusal>(input: {
    readonly orderId: string;
    readonly author: ReviewAuthor;
    readonly rating: number;
    readonly comment: string | null;
    readonly check: ReviewWriteCheck<Refusal>;
  }): Promise<EditReviewOutcome<Refusal>> {
    return this.db.transaction(async (tx) => {
      const locked = await this.lockOrder(tx, input.orderId);

      if (locked === undefined || !isSameParties(locked.context, input.author)) {
        return { kind: 'not-party' } as const;
      }

      const own = and(
        eq(reviews.orderId, input.orderId),
        eq(reviews.authorRole, input.author.role),
      );

      const [existing] = await tx
        .select({ id: reviews.id, revealedAt: reviews.revealedAt })
        .from(reviews)
        .where(own);
      if (existing === undefined) {
        return { kind: 'missing' } as const;
      }
      if (existing.revealedAt !== null) {
        return { kind: 'revealed' } as const;
      }

      const refusal = input.check(locked.context, locked.now);
      if (refusal !== null) {
        return { kind: 'refused', refusal } as const;
      }

      const [edited] = await tx
        .update(reviews)
        .set({ rating: input.rating, comment: input.comment })
        .where(and(own, isNull(reviews.revealedAt)))
        .returning();

      return edited === undefined
        ? ({ kind: 'revealed' } as const)
        : ({ kind: 'edited', review: edited } as const);
    });
  }

  /**
   * The advisory lock, then the order `FOR SHARE`, its completion time, and
   * the database's clock — one clock for every instance, so two API servers
   * never disagree about whether a window is open.
   */
  private async lockOrder(
    tx: Transaction,
    orderId: string,
  ): Promise<{ context: ReviewOrderContext; now: Date } | undefined> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`review:${orderId}`}, 0))`,
    );

    const [order] = await tx
      .select({
        orderId: orders.id,
        status: orders.status,
        customerId: orders.customerId,
        masterId: orders.masterId,
        now: sql`now()`.mapWith(orders.createdAt),
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('share');

    if (order === undefined) {
      return undefined;
    }

    const { now, ...fields } = order;
    return { context: { ...fields, completedAt: await this.completedAt(orderId, tx) }, now };
  }

  /**
   * When the order entered `COMPLETED` — the start of the window (ADR-0042
   * § 2). The earliest such row, although the lifecycle reaches `COMPLETED`
   * only once: if a later edge ever led back to it, the window must still run
   * from the first time the job was done. Served by
   * `order_status_history_order_idx`.
   */
  private async completedAt(orderId: string, executor: DatabaseExecutor): Promise<Date | null> {
    const [row] = await executor
      .select({ at: min(orderStatusHistory.createdAt) })
      .from(orderStatusHistory)
      .where(
        and(eq(orderStatusHistory.orderId, orderId), eq(orderStatusHistory.toStatus, 'COMPLETED')),
      );
    return row?.at ?? null;
  }

  /**
   * Reveals both reviews once both exist, and moves each aggregate once.
   *
   * **Exactly once, by construction**: the `UPDATE … WHERE revealed_at IS
   * NULL` returns only the rows *this* statement revealed, and only those are
   * counted. A row revealed by anything else — a concurrent reveal, the window
   * sweep — is not returned here and so is not counted twice (ADR-0042 § 3).
   *
   * A removed review is revealed with its pair but counts towards nothing: the
   * aggregate is the sum over revealed, **unremoved** reviews (§ 6).
   *
   * Returns the revealed rows by id, so the caller can answer with its own
   * review as it now stands.
   */
  private async revealIfBothWritten(
    tx: Transaction,
    orderId: string,
  ): Promise<Map<string, ReviewRow>> {
    const written = await tx
      .select({ authorRole: reviews.authorRole })
      .from(reviews)
      .where(eq(reviews.orderId, orderId));

    const sides = new Set(written.map((row) => row.authorRole));
    if (!sides.has('customer') || !sides.has('master')) {
      return new Map();
    }

    const revealed = await tx
      .update(reviews)
      .set({ revealedAt: sql`now()` })
      .where(and(eq(reviews.orderId, orderId), isNull(reviews.revealedAt)))
      .returning();

    for (const review of revealed) {
      if (review.removedAt === null) {
        await this.countTowardsAggregate(tx, review);
      }
    }

    return new Map(revealed.map((review) => [review.id, review]));
  }

  /** A customer's review counts for the master; a master's review counts for the customer. */
  private async countTowardsAggregate(tx: Transaction, review: ReviewRow): Promise<void> {
    if (review.authorRole === 'customer') {
      await tx
        .update(masters)
        .set({
          ratingSum: sql`${masters.ratingSum} + ${review.rating}`,
          ratingCount: sql`${masters.ratingCount} + 1`,
        })
        .where(eq(masters.id, review.masterId));
    } else {
      await tx
        .update(customers)
        .set({
          ratingSum: sql`${customers.ratingSum} + ${review.rating}`,
          ratingCount: sql`${customers.ratingCount} + 1`,
        })
        .where(eq(customers.id, review.customerId));
    }
  }
}

/**
 * The parties the service resolved are still the order's, under the lock. On
 * a completed order they cannot have changed — a re-dispatch is only possible
 * before completion — so this is the belt to that braces: if they ever could,
 * the caller would have become a stranger, and a stranger gets a 404.
 */
function isSameParties(context: ReviewOrderContext, author: ReviewAuthor): boolean {
  return context.customerId === author.customerId && context.masterId === author.masterId;
}
