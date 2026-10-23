import type { OrderStatus, ServicePricingKind } from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';

/**
 * The master tried to start an inspection-priced job whose quote the customer
 * has not approved
 * ([ADR-0060](docs/decisions/ADR-0060-inspection-price-approval.md) § 2).
 *
 * 409, and not `ORDER_INVALID_TRANSITION`: the edge exists and the caller may
 * drive it. What is missing is the customer's approval, and the app shows
 * "waiting for the customer" for that, not an error.
 */
export class OrderPriceNotApprovedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.ORDER_PRICE_NOT_APPROVED,
      'The customer has not approved the price yet.',
      409,
    );
    this.name = 'OrderPriceNotApprovedError';
    Object.setPrototypeOf(this, OrderPriceNotApprovedError.prototype);
  }
}

/**
 * This order cannot be quoted now: it is fixed-priced, it is not
 * `MASTER_ARRIVED`, or its quote is already approved (ADR-0060 §§ 1 and 3).
 * The details are the caller's own order's facts, so they leak nothing.
 */
export class OrderPriceNotQuotableError extends AppError {
  constructor(order: {
    readonly status: OrderStatus;
    readonly pricingKind: ServicePricingKind;
    readonly priceApprovedAt: Date | null;
  }) {
    super(ERROR_CODES.ORDER_PRICE_NOT_QUOTABLE, 'This order cannot be quoted now.', 409, {
      status: order.status,
      pricingKind: order.pricingKind,
      priceApproved: order.priceApprovedAt !== null,
    });
    this.name = 'OrderPriceNotQuotableError';
    Object.setPrototypeOf(this, OrderPriceNotQuotableError.prototype);
  }
}

/**
 * The customer approved or declined an amount that is no longer the open
 * quote: the master replaced it, it was already approved, or the order moved
 * (ADR-0060 § 3). `details` carries what the order holds now, so the app can
 * show the current figure rather than guess.
 */
export class OrderPriceStaleError extends AppError {
  constructor(order: {
    readonly status: OrderStatus;
    readonly priceMinor: number | null;
    readonly priceApprovedAt: Date | null;
  }) {
    super(ERROR_CODES.ORDER_PRICE_STALE, 'The price has changed since it was shown.', 409, {
      status: order.status,
      priceMinor: order.priceMinor,
      priceApproved: order.priceApprovedAt !== null,
    });
    this.name = 'OrderPriceStaleError';
    Object.setPrototypeOf(this, OrderPriceStaleError.prototype);
  }
}
