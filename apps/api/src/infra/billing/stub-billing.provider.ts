import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { z } from 'zod';

import type {
  BillingProviderName,
  CheckoutRequest,
  CheckoutSession,
  PaymentLookup,
  SubscriptionBillingProvider,
  WebhookHeaders,
  WebhookVerification,
} from './billing.types';

/**
 * Thrown from the provider factory, so a production deploy left on the stub
 * fails at boot naming the variable — as `StubSmsSender` does — rather than
 * handing masters a checkout page that does not exist.
 */
export class StubBillingProviderInProductionError extends Error {
  constructor() {
    super(
      'BILLING_PROVIDER is "stub", which takes no money and must never run in production. ' +
        'Choose a billing provider (CLAUDE.md § 1) and wire up its adapter (see .env.example).',
    );
    this.name = 'StubBillingProviderInProductionError';
    Object.setPrototypeOf(this, StubBillingProviderInProductionError.prototype);
  }
}

/** The stub's signature header: `sha256=<hex HMAC of the raw body>`. */
export const STUB_SIGNATURE_HEADER = 'x-stub-signature';

/** The stub's hosted pages. `.invalid` is reserved (RFC 6761): nothing resolves it. */
const STUB_CHECKOUT_ORIGIN = 'https://billing.stub.invalid';

/** The stub's own webhook shape — a provider's, in miniature. */
const stubWebhookSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  data: z.object({
    ref: z.string().min(1).max(160),
    amountMinor: z.number().int().nonnegative().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    occurredAt: z.iso.datetime(),
  }),
});

export type StubWebhookType = 'payment.succeeded' | 'payment.failed' | 'payment.refunded';

export interface StubDelivery {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

interface StubCheckout {
  readonly amountMinor: number;
  readonly currency: string;
  lookup: PaymentLookup;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The development and test provider: takes no money, opens no page, and signs
 * its webhooks with a key generated **per instance**, so a delivery signed by
 * one process is a forgery to every other (issue #323).
 *
 * What it keeps in memory — which checkouts it opened and what it would say
 * about each — is what makes `fetchPayment` answer like a provider. Memory is
 * fine for a stub: two API instances would disagree about it, which is why it
 * refuses production.
 *
 * The helpers below the port (`deliver`, `pay`, `setLookup`) are how a test
 * plays the provider's side: pay a checkout, send its webhook, or make the
 * provider's records disagree with ours.
 */
export class StubBillingProvider implements SubscriptionBillingProvider {
  readonly name: BillingProviderName = 'stub';

  private readonly logger = new Logger(StubBillingProvider.name);
  private readonly signingKey = randomBytes(32);
  private readonly checkouts = new Map<string, StubCheckout>();

  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new StubBillingProviderInProductionError();
    }
    this.logger.warn('Subscription billing is stubbed: no checkout takes money.');
  }

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const providerRef = `stub_${request.idempotencyKey}`;
    if (!this.checkouts.has(providerRef)) {
      this.checkouts.set(providerRef, {
        amountMinor: request.amountMinor,
        currency: request.currency,
        lookup: { status: 'pending' },
      });
    }
    return Promise.resolve({
      checkoutUrl: `${STUB_CHECKOUT_ORIGIN}/checkout/${encodeURIComponent(providerRef)}`,
      providerRef,
    });
  }

  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookVerification {
    const signature = headerValue(headers, STUB_SIGNATURE_HEADER);
    if (signature === undefined || !safeEqual(signature, this.sign(rawBody))) {
      return { outcome: 'invalid' };
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      // Signed by us and still not JSON: a bug in whoever signed it, and not
      // something to act on.
      return { outcome: 'invalid' };
    }
    const parsed = stubWebhookSchema.safeParse(json);
    if (!parsed.success) {
      return { outcome: 'invalid' };
    }

    const { id: eventId, type, data } = parsed.data;
    const occurredAt = new Date(data.occurredAt);
    switch (type) {
      case 'payment.succeeded':
      case 'payment.refunded': {
        if (data.amountMinor === undefined || data.currency === undefined) {
          return { outcome: 'invalid' };
        }
        return {
          outcome: 'verified',
          event: {
            kind: type === 'payment.succeeded' ? 'succeeded' : 'refunded',
            eventId,
            providerRef: data.ref,
            amountMinor: data.amountMinor,
            currency: data.currency,
            occurredAt,
          },
        };
      }
      case 'payment.failed':
        return {
          outcome: 'verified',
          event: { kind: 'failed', eventId, providerRef: data.ref, occurredAt },
        };
      default:
        return { outcome: 'ignored' };
    }
  }

  fetchPayment(providerRef: string): Promise<PaymentLookup> {
    return Promise.resolve(this.checkouts.get(providerRef)?.lookup ?? { status: 'unknown' });
  }

  /*
   * The provider's side, for tests and local development.
   */

  /** A webhook delivery the stub would send, signed with this instance's key. */
  deliver(
    type: StubWebhookType | (string & {}),
    data: {
      readonly ref: string;
      readonly amountMinor?: number;
      readonly currency?: string;
      readonly occurredAt?: Date;
    },
    eventId: string = `evt_${randomUUID()}`,
  ): StubDelivery {
    const body = Buffer.from(
      JSON.stringify({
        id: eventId,
        type,
        data: {
          ref: data.ref,
          amountMinor: data.amountMinor,
          currency: data.currency,
          occurredAt: (data.occurredAt ?? new Date()).toISOString(),
        },
      }),
    );
    return {
      body,
      headers: { 'content-type': 'application/json', [STUB_SIGNATURE_HEADER]: this.sign(body) },
    };
  }

  /**
   * The master paid on the hosted page: the stub's records say so, and the
   * returned delivery is the webhook it sends. The amount is the checkout's
   * unless a test says otherwise.
   */
  pay(
    providerRef: string,
    override: { amountMinor?: number; currency?: string } = {},
  ): StubDelivery {
    const checkout = this.checkouts.get(providerRef);
    if (checkout === undefined) {
      throw new Error(`The stub opened no checkout ${providerRef}.`);
    }
    const amountMinor = override.amountMinor ?? checkout.amountMinor;
    const currency = override.currency ?? checkout.currency;
    checkout.lookup = { status: 'paid', amountMinor, currency };
    return this.deliver('payment.succeeded', { ref: providerRef, amountMinor, currency });
  }

  /** Makes the stub's records say something else about a checkout — reconciliation's drift. */
  setLookup(providerRef: string, lookup: PaymentLookup): void {
    const checkout = this.checkouts.get(providerRef);
    if (checkout === undefined) {
      throw new Error(`The stub opened no checkout ${providerRef}.`);
    }
    checkout.lookup = lookup;
  }

  private sign(body: Buffer): string {
    return `sha256=${createHmac('sha256', this.signingKey).update(body).digest('hex')}`;
  }
}
