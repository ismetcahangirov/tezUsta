import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { SecretBox } from '../../common/crypto/secret-box';
import type { AppConfig } from '../config/app-config.types';

/** The DI token for the {@link SecretBox} saved-card tokens are sealed with. */
export const PAYMENT_TOKEN_BOX = Symbol('PAYMENT_TOKEN_BOX');

/** The context a saved card's token is sealed under: its own row, so a copied ciphertext fails. */
export function paymentTokenContext(paymentMethodId: string): string {
  return `subscription-payment-method:${paymentMethodId}`;
}

export class MissingBillingTokenKeyError extends Error {
  constructor() {
    super(
      'BILLING_TOKEN_ENCRYPTION_KEY is not set. Saved-card tokens are encrypted at rest and ' +
        'production must have the key (generate one with `openssl rand -base64 32`; see .env.example).',
    );
    this.name = 'MissingBillingTokenKeyError';
    Object.setPrototypeOf(this, MissingBillingTokenKeyError.prototype);
  }
}

/**
 * The box saved-card tokens are sealed in (#424). Under the configured key;
 * without one — development and tests, on the stub — under a key made for
 * this process, so a token saved before a restart can no longer be opened,
 * which costs a fake card nothing. Production refuses to start without it.
 */
export function createPaymentTokenBox(config: AppConfig): SecretBox {
  const key = config.billing.tokenEncryptionKey;
  if (key !== undefined) {
    return new SecretBox(Buffer.from(key, 'base64'));
  }
  if (config.runtime.nodeEnv === 'production') {
    throw new MissingBillingTokenKeyError();
  }
  new Logger('PaymentTokenBox').warn(
    'BILLING_TOKEN_ENCRYPTION_KEY is unset: saved cards are sealed under a per-process key.',
  );
  return new SecretBox(randomBytes(32));
}
