import { Inject, Injectable } from '@nestjs/common';
import type { OrderReviews, Review, ReviewAuthorRole } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { ReviewRow } from '../../infra/database/schema/reviews';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import { reviewEligibility, reviewWindowClosesAt } from './review-window';
import {
  OrderNotReviewableError,
  ReviewAlreadyRevealedError,
  ReviewAlreadySubmittedError,
  ReviewWindowClosedError,
} from './reviews.errors';
import type { ReviewAuthor, ReviewOrderContext, ReviewWriteCheck } from './reviews.repository';
import { ReviewsRepository } from './reviews.repository';
import type { SubmitReviewInput } from './reviews.schema';

/**
 * Submitting, editing and reading one's own review of an order (issue #222,
 * [ADR-0042](docs/decisions/ADR-0042-review-policy.md) §§ 2–6).
 *
 * **Who the caller is on this order is re-read from the database on every
 * request**, never taken from the token's role claim, and a caller who is on
 * neither side gets the one 404 — "not yours" and "does not exist" must be
 * indistinguishable (`common/authorization/resource-visibility.ts`).
 *
 * **Aggregates move at reveal, never at submission** (§ 6), and that is the
 * repository's transaction, not this class's arithmetic: a sealed review
 * contributes nothing, so a party with few reviews cannot read the other
 * side's sealed rating off a number that moved.
 *
 * Nothing here logs a comment. Review text is untrusted input shown to another
 * person (§ 5), stored as written and never interpolated anywhere.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly reviews: ReviewsRepository,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async submit(actor: Actor, orderId: string, input: SubmitReviewInput): Promise<Review> {
    const author = await this.requireAuthor(actor, orderId);

    const outcome = await this.reviews.submit({
      orderId,
      author,
      rating: input.rating,
      comment: input.comment,
      check: this.writeCheck,
    });

    switch (outcome.kind) {
      case 'created':
        return presentReview(outcome.review);
      case 'duplicate':
        throw new ReviewAlreadySubmittedError();
      case 'not-party':
        throw new NotFoundError();
      case 'refused':
        throw outcome.refusal;
    }
  }

  async edit(actor: Actor, orderId: string, input: SubmitReviewInput): Promise<Review> {
    const author = await this.requireAuthor(actor, orderId);

    const outcome = await this.reviews.edit({
      orderId,
      author,
      rating: input.rating,
      comment: input.comment,
      check: this.writeCheck,
    });

    switch (outcome.kind) {
      case 'edited':
        return presentReview(outcome.review);
      case 'revealed':
        throw new ReviewAlreadyRevealedError();
      // The caller is a party but has nothing to edit. Their own review not
      // existing is not a secret from them, and 404 is what "there is no such
      // thing at this address" means — the client's next move is POST.
      case 'missing':
      case 'not-party':
        throw new NotFoundError();
      case 'refused':
        throw outcome.refusal;
    }
  }

  /**
   * The caller's own review, sealed or revealed; the counterpart's only once
   * revealed and not removed; and whether the caller may still write.
   *
   * Readable on an order that is not completed — it simply has no window and
   * no reviews — because the caller is a party to it either way, and a 409
   * for "not yet" would make the client guess whether to show an error.
   */
  async getForOrder(actor: Actor, orderId: string): Promise<OrderReviews> {
    const context = await this.reviews.findOrderContext(orderId);
    if (context === undefined) {
      throw new NotFoundError();
    }
    const role = await this.resolveRole(actor, context);

    const rows = await this.reviews.listForOrder(orderId);
    const mine = rows.find((row) => row.authorRole === role);
    const theirs = rows.find(
      (row) => row.authorRole !== role && row.revealedAt !== null && row.removedAt === null,
    );

    const eligibility = reviewEligibility({
      status: context.status,
      completedAt: context.completedAt,
      windowHours: this.config.reviews.windowHours,
      now: new Date(),
    });
    const closesAt = reviewWindowClosesAt(context.completedAt, this.config.reviews.windowHours);

    return {
      orderId,
      role,
      mine: mine === undefined ? null : presentReview(mine),
      theirs: theirs === undefined ? null : presentReview(theirs),
      windowClosesAt: closesAt === null ? null : closesAt.toISOString(),
      canReview: eligibility.kind === 'open' && mine === undefined,
      canEdit: eligibility.kind === 'open' && mine !== undefined && mine.revealedAt === null,
    };
  }

  /**
   * The status and window rules, evaluated by the repository against the order
   * as it stands under the lock and the database's clock. An arrow property so
   * it can be handed over without losing `this`.
   */
  private readonly writeCheck: ReviewWriteCheck<AppError> = (context, now) => {
    const eligibility = reviewEligibility({
      status: context.status,
      completedAt: context.completedAt,
      windowHours: this.config.reviews.windowHours,
      now,
    });

    switch (eligibility.kind) {
      case 'open':
        return null;
      case 'not-reviewable':
        return new OrderNotReviewableError(context.status);
      case 'window-closed':
        return new ReviewWindowClosedError(eligibility.closesAt);
    }
  };

  /** Which side the caller is on, and the two parties the review will name — or 404. */
  private async requireAuthor(actor: Actor, orderId: string): Promise<ReviewAuthor> {
    const context = await this.reviews.findOrderContext(orderId);
    if (context === undefined) {
      throw new NotFoundError();
    }

    const role = await this.resolveRole(actor, context);

    // A party to an order that never had a master can only be its customer,
    // and such an order was never completed. The status check under the lock
    // would refuse it anyway; answering here keeps a null out of the insert.
    if (context.masterId === null) {
      throw new OrderNotReviewableError(context.status);
    }

    return { role, customerId: context.customerId, masterId: context.masterId };
  }

  /**
   * **The assigned master is asked about first, and only when the order has
   * one** — `conversations.service.ts#resolveSide`'s rule, for its reason: one
   * account may hold both roles, and a plumber who ordered a repair for their
   * own flat is the customer on *that* order. Here the tie decides who the
   * review is about, which is exactly why it must fall the same way it does
   * everywhere else.
   */
  private async resolveRole(actor: Actor, context: ReviewOrderContext): Promise<ReviewAuthorRole> {
    if (context.masterId !== null) {
      const master = await this.masters.findOwn(actor);
      if (master !== undefined && master.id === context.masterId) {
        return 'master';
      }
    }

    const customer = await this.customers.findOwn(actor);
    if (customer !== undefined && customer.id === context.customerId) {
      return 'customer';
    }

    throw new NotFoundError();
  }
}

function presentReview(row: ReviewRow): Review {
  return {
    id: row.id,
    orderId: row.orderId,
    authorRole: row.authorRole,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revealedAt: row.revealedAt === null ? null : row.revealedAt.toISOString(),
    removedAt: row.removedAt === null ? null : row.removedAt.toISOString(),
  };
}
