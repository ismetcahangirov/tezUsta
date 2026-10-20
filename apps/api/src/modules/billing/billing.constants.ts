/**
 * How long a checkout that nobody has paid is handed back to a repeated
 * request instead of a new one being opened (issue #323).
 *
 * The checkout is idempotent per master, billing period and price version
 * within this window: a double tap or a retried request reaches the same
 * hosted page. Past it, a new checkout is opened, because a hosted session
 * does not live forever — thirty minutes is inside the session lifetime the
 * candidate providers document, and the real adapter's ADR revisits it.
 */
export const CHECKOUT_REUSE_MS = 30 * 60 * 1000;

/** The recurring reconciliation job's name on the `maintenance` queue. */
export const BILLING_RECONCILE_JOB = 'billing-reconcile';

/**
 * The most checkouts one reconciliation run asks the provider about. Each is
 * one provider call, so this bounds what a run can cost; at launch volumes a
 * week of checkouts is far below it, and the newest are checked first.
 */
export const MAX_CHECKOUTS_PER_RECONCILE = 500;

/** The webhook route, as Fastify registers it. `BillingWebhookController` serves it. */
export const BILLING_WEBHOOK_ROUTE = '/webhooks/billing/:provider';

/**
 * The largest webhook body accepted, in bytes. A payment event is a few
 * hundred bytes; 64 KiB is LiveKit's webhook limit (`webhook-body.parser.ts`)
 * and its reasoning: the route is public, and until the signature is checked
 * every byte was chosen by whoever sent it.
 */
export const BILLING_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
