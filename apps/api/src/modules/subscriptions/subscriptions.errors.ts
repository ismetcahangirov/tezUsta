import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';

/**
 * The master's subscription does not entitle them to work (ADR-0046 § 5).
 *
 * Thrown where taking **new** work starts — going available, accepting an
 * offer — and nowhere a job already accepted continues: an expired master
 * still finishes the job they have.
 */
export class SubscriptionInactiveError extends AppError {
  constructor() {
    super(
      ERROR_CODES.SUBSCRIPTION_INACTIVE,
      'Your subscription is not active, so you cannot take new work.',
      409,
    );
    this.name = 'SubscriptionInactiveError';
    Object.setPrototypeOf(this, SubscriptionInactiveError.prototype);
  }
}

export class SubscriptionPeriodAlreadyQueuedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.SUBSCRIPTION_PERIOD_ALREADY_QUEUED,
      'A period is already waiting to start after the current one.',
      409,
    );
    this.name = 'SubscriptionPeriodAlreadyQueuedError';
    Object.setPrototypeOf(this, SubscriptionPeriodAlreadyQueuedError.prototype);
  }
}

export class SubscriptionTransitionNotAllowedError extends AppError {
  constructor(message: string) {
    super(ERROR_CODES.SUBSCRIPTION_TRANSITION_NOT_ALLOWED, message, 409);
    this.name = 'SubscriptionTransitionNotAllowedError';
    Object.setPrototypeOf(this, SubscriptionTransitionNotAllowedError.prototype);
  }
}

/** The admin offer edits (#324): one class, the code and status vary with the refusal. */
export class SubscriptionOfferError extends AppError {
  constructor(
    code:
      | 'SUBSCRIPTION_PRICE_ALREADY_SCHEDULED'
      | 'SUBSCRIPTION_PRICE_NOTICE_REQUIRED'
      | 'SUBSCRIPTION_PRICE_EFFECTIVE_FROM_INVALID'
      | 'SUBSCRIPTION_PRICE_CONFIRMATION_REQUIRED'
      | 'SUBSCRIPTION_PRICE_NOT_SCHEDULED'
      | 'SUBSCRIPTION_PURCHASES_NEED_PRICES',
    message: string,
    details?: Record<string, unknown>,
  ) {
    const status =
      code === 'SUBSCRIPTION_PRICE_ALREADY_SCHEDULED' ||
      code === 'SUBSCRIPTION_PRICE_NOT_SCHEDULED' ||
      code === 'SUBSCRIPTION_PURCHASES_NEED_PRICES'
        ? 409
        : 422;
    super(ERROR_CODES[code], message, status, details);
    this.name = 'SubscriptionOfferError';
    Object.setPrototypeOf(this, SubscriptionOfferError.prototype);
  }
}
