import type { OrderStatus } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';

/**
 * The refusals a party to an order can meet when reviewing it (issue #222).
 *
 * All four are 409s with their own code, and all four are reached only after
 * the caller has been proven a party to the order — a stranger gets the one
 * 404 (`NotFoundError`), so none of these tells anybody that an order exists.
 * They are distinct because the app shows a different thing for each: "this
 * job isn't finished yet", "the time to review has passed", "you already
 * reviewed this", "your review has been published and can't be changed".
 */

export class OrderNotReviewableError extends AppError {
  constructor(status: OrderStatus) {
    super(
      ERROR_CODES.ORDER_NOT_REVIEWABLE,
      'This order cannot be reviewed until it has been completed.',
      409,
      { orderStatus: status },
    );
    this.name = 'OrderNotReviewableError';
    Object.setPrototypeOf(this, OrderNotReviewableError.prototype);
  }
}

export class ReviewWindowClosedError extends AppError {
  constructor(closedAt: Date) {
    super(ERROR_CODES.REVIEW_WINDOW_CLOSED, 'The time to review this order has passed.', 409, {
      windowClosedAt: closedAt.toISOString(),
    });
    this.name = 'ReviewWindowClosedError';
    Object.setPrototypeOf(this, ReviewWindowClosedError.prototype);
  }
}

export class ReviewAlreadySubmittedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.REVIEW_ALREADY_SUBMITTED,
      'You have already reviewed this order. A review that is not yet published can be edited.',
      409,
    );
    this.name = 'ReviewAlreadySubmittedError';
    Object.setPrototypeOf(this, ReviewAlreadySubmittedError.prototype);
  }
}

export class ReviewAlreadyRevealedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.REVIEW_ALREADY_REVEALED,
      'This review has been published and can no longer be changed.',
      409,
    );
    this.name = 'ReviewAlreadyRevealedError';
    Object.setPrototypeOf(this, ReviewAlreadyRevealedError.prototype);
  }
}
