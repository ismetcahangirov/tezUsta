import type { SubscriptionBillingPeriod } from '@tezusta/types';

/**
 * The subscription billing provider port (issue #323, ADR-0046 § 6, ADR-0057).
 *
 * Which provider is still the owner's decision (CLAUDE.md § 1) — Payriff,
 * AzeriCard and Epoint are the local candidates — so this is shaped like the
 * SMS sender (ADR-0008): a port, a stub, and a factory that picks one from
 * `BILLING_PROVIDER`. **No vendor type crosses it.** Everything a provider
 * says arrives here already translated into these types, so the module above
 * never learns whose webhook it is reading.
 *
 * Three operations, and they are the whole of what a provider does for us:
 * open a hosted checkout, prove a webhook came from it, and answer "what
 * happened to this payment?" for reconciliation. The card is typed into the
 * provider's page and never reaches TezUsta: PCI scope stays at zero.
 */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/** `BILLING_PROVIDER`'s values. One member until a real adapter is wired up. */
export type BillingProviderName = 'stub';

export interface CheckoutRequest {
  readonly masterId: string;
  readonly billingPeriod: SubscriptionBillingPeriod;
  /** Set by the server from the price version (ADR-0046 § 5). Never from the client. */
  readonly amountMinor: number;
  readonly currency: 'AZN';
  /**
   * The server's key for this checkout. A provider that receives the same key
   * twice must answer with the same checkout, so a retried request cannot
   * open a second one.
   */
  readonly idempotencyKey: string;
  /**
   * Where the provider sends the master's browser afterwards — the web
   * purchase page (#334). It proves nothing: only the webhook does. Undefined
   * until that page exists; a real adapter that needs one refuses to start
   * without `BILLING_RETURN_URL`.
   */
  readonly returnUrl: string | undefined;
  /**
   * The master asked for auto-renewal (ADR-0058): the page saves the card,
   * and the success event carries its token. Without it no token comes back,
   * and nothing can be charged later.
   */
  readonly saveCard: boolean;
}

/**
 * A charge on a saved card, made by TezUsta before a period ends (ADR-0046
 * § 6). Asynchronous like a checkout: the outcome arrives as a webhook about
 * the returned `providerRef`, through the same path a hosted payment takes.
 */
export interface SavedCardChargeRequest {
  readonly masterId: string;
  readonly billingPeriod: SubscriptionBillingPeriod;
  readonly amountMinor: number;
  readonly currency: 'AZN';
  /** The provider's token for the card. Never logged. */
  readonly tokenRef: string;
  /** As for a checkout: the same key twice is the same charge. */
  readonly idempotencyKey: string;
}

export interface CheckoutSession {
  /** The provider's hosted page. `https://` only. */
  readonly checkoutUrl: string;
  /** The provider's reference for this checkout, which every webhook about it names. */
  readonly providerRef: string;
}

/** A verified provider event, translated. Amounts are integer minor units (ADR-0010). */
export type BillingEvent =
  | {
      readonly kind: 'succeeded';
      readonly eventId: string;
      readonly providerRef: string;
      readonly amountMinor: number;
      readonly currency: string;
      readonly occurredAt: Date;
      /** The saved card's token, when the checkout asked to save it. Never logged. */
      readonly savedCardToken?: string;
    }
  | {
      readonly kind: 'failed';
      readonly eventId: string;
      readonly providerRef: string;
      readonly occurredAt: Date;
    }
  | {
      readonly kind: 'refunded';
      readonly eventId: string;
      readonly providerRef: string;
      readonly amountMinor: number;
      readonly currency: string;
      readonly occurredAt: Date;
    };

/**
 * What a delivery turned out to be.
 *
 * - `invalid` — it did not prove it came from the provider: no signature, a
 *   wrong one, or a body the signature does not cover. Nothing may be read
 *   from it.
 * - `ignored` — genuine, and about something subscriptions do not act on.
 * - `verified` — genuine, and one of the events above.
 */
export type WebhookVerification =
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'ignored' }
  | { readonly outcome: 'verified'; readonly event: BillingEvent };

/** The request headers, as Fastify hands them over. */
export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * The provider's own answer about one checkout, for reconciliation.
 *
 * - `paid` / `refunded` carry the amount the provider holds.
 * - `pending` — opened and not paid, which is most checkouts.
 * - `failed` — every attempt on it failed.
 * - `unknown` — the provider has no such reference.
 */
export type PaymentLookup =
  | {
      readonly status: 'paid' | 'refunded';
      readonly amountMinor: number;
      readonly currency: string;
    }
  | { readonly status: 'pending' | 'failed' | 'unknown' };

export interface SubscriptionBillingProvider {
  readonly name: BillingProviderName;

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  /**
   * Checks the signature **against the exact bytes that arrived** and only
   * then reads them. Synchronous and local: no network, no database, so a
   * forged delivery costs one HMAC over a bounded body.
   */
  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): WebhookVerification;

  fetchPayment(providerRef: string): Promise<PaymentLookup>;

  /** Starts a charge on a saved card and returns its reference. The webhook says how it went. */
  chargeSavedCard(request: SavedCardChargeRequest): Promise<{ readonly providerRef: string }>;
}
