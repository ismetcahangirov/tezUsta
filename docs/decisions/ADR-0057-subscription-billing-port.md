# ADR-0057 — Subscription billing: a provider port, append-only records, the webhook as the only writer

- **Status:** **Accepted**
- **Date:** 2026-10-21
- **Context:** EPIC 14 (#15), issue [#323]
- **Builds on:** [ADR-0046](ADR-0046-subscription-only-monetisation.md) § 5–7
  (the subscription, renewal, and selling it outside the app),
  [ADR-0008](ADR-0008-otp-delivery.md) (a provider behind a port with a stub)
- **Does not decide:** the billing provider, which is still open (CLAUDE.md
  § 1). Auto-renewal on a saved card (ADR-0046 § 6) is the second half of
  #323 and is not built here.

[#323]: https://github.com/ismetcahangirov/tezUsta/issues/323

## Context

ADR-0046 settled what a master buys and how it renews. It left the billing
provider open, and Payriff, AzeriCard and Epoint are the local candidates.
Everything except the real integration can be built without knowing which
one it will be, as was done for SMS. That covers the checkout, the webhook
that alone extends a period, the records and reconciliation. This ADR
records the choices that work needed.

## Decision

### 1. A port in `infra/billing/`, and a stub

`SubscriptionBillingProvider` has three operations:

- `createCheckout`: opens a hosted page and returns its URL and the provider's
  reference.
- `verifyWebhook(rawBody, headers)`: answers `invalid`, `ignored` or
  `verified` with a translated event (`succeeded`, `failed` or `refunded`).
- `fetchPayment(providerRef)`: used by reconciliation.

No vendor type crosses the port. `BILLING_PROVIDER` is an enum with one member,
`stub`.

The stub behaves like a provider in miniature:

- it signs webhooks with HMAC-SHA256 under a key generated **per process**;
- it remembers what it opened, so `fetchPayment` can answer;
- it refuses to construct under `NODE_ENV=production`, so a deploy cannot go
  live on it.

The card is typed on the provider's page, so PCI scope stays at zero.

### 2. Two append-only tables

`subscription_checkouts` and `subscription_payments` are append-only, enforced
by migration 0052's triggers, with 0038's function.

- **A checkout row** fixes the price version and the amount when it is opened.
  The webhook activates against that `price_id`, so a price change after
  checkout does not change what the master pays.
- **A payment row** is one verified provider event, unique on
  `(provider, provider_event_id)`. That uniqueness is the webhook's idempotency.
  `provider_ref` is **not** unique there, unlike the issue's sketch: one
  payment can have several events, such as a success and later its refund.
  One payment buys one period because of `subscription_events`' unique
  `payment_ref`, as before (#322).
- **A disposition** is recorded with every event: `activated`,
  `already_applied`, `recorded`, `amount_mismatch`, `unknown_checkout` or
  `period_already_queued`. Someone reading the table after an alert can see
  what each event did.

Neither table stores card data.

### 3. The checkout: the server's price, refused before the provider is called

`POST /masters/me/subscription/checkout` takes `{ billingPeriod }` and nothing
else. `.strict()` rejects an amount or a price id.

These checks all run before the provider is called, so a refusal opens nothing
there:

- the master is verified;
- purchases are open (`SUBSCRIPTION_PURCHASES_CLOSED` otherwise);
- the period has a current price;
- no bought period is already queued (`SUBSCRIPTION_PERIOD_ALREADY_QUEUED`).

The queued check asks the state machine itself.

A repeated request within 30 minutes reuses the newest unpaid checkout for the
same period and price version, under a per-master advisory lock. The checkout's
row id is the provider's idempotency key. The endpoint is rate-limited
(`subscription-checkout`).

**The app never calls it** (ADR-0046 § 7). Its client is the web purchase
page, #334.

### 4. The webhook: verify, record once, and answer 200 only after commit

`POST /webhooks/billing/:provider` is public. Its authentication is the
signature over the **exact bytes**, which a `preParsing` hook captures for
that one URL, capped at 64 KiB.

- A provider name other than the configured one gets 404. A bad delivery gets
  401, with the same answer for every reason.
- A success first checks that the amount and currency match the checkout. On a
  match it calls `activatePeriod` with the checkout's price version; on a
  mismatch it activates nothing and logs an error.
- A failure or a refund is recorded as a `subscription_events` row of the new
  kind `payment_failed` or `payment_refunded`, in the same transaction as the
  payment row. **Neither moves the subscription.** A failed charge lets the
  period lapse into grace on its own. A refund is recorded, as ADR-0046 § 5
  says, but not enforced: taking days back after a refund is a policy nobody
  has set, and an admin can cancel or correct by hand.
- A success that finds a bought period already queued is recorded, and an
  error asks a person to refund the payment or grant the period.
- There is no rate limit, for the LiveKit webhook's reason: the body cap
  bounds what a forger can spend.

The log lines name the provider, the event kind and our own checkout id. They
never include the body, a card fragment or a secret.

### 5. Reconciliation alerts; it does not correct

A job on the `maintenance` queue (`BILLING_RECONCILE_INTERVAL_SECONDS`, hourly
by default; 0 disables it) asks the provider about every checkout from the last
`BILLING_RECONCILE_LOOKBACK_DAYS` (7 by default, up to 500 checkouts).

It counts four kinds of disagreement:

- a payment we never recorded;
- a payment we recorded that the provider does not hold;
- a different amount;
- a refund we never recorded.

On any disagreement it writes one `logger.error` line with the counts.

It never activates a period. The webhook is the only writer (ADR-0046 § 6).
A second writer, driven by a lookup, would put the subscription's money
history in two places.

## Consequences

- A real provider means one adapter file, one enum member and one `case` in
  `infra/billing/billing.module.ts`, plus that provider's secrets and an ADR
  for its webhook format. A provider that posts forms rather than JSON brings
  its own body parser.
- The checkout transaction stays open across the provider call, so a slow
  provider holds one pooled connection per checkout in flight. The rate limit
  bounds this, and the real adapter needs a timeout.
- A payment the webhook never delivered is found within an hour, but a person
  applies it, by granting the period.
- The admin history shows two new event kinds.

## Alternatives considered

- **Unique `provider_ref` on payments**, as the issue sketched. Rejected: it
  makes a refund after a success impossible to record, and the second event
  would fail every retry.
- **Reconciliation that activates missed payments.** Rejected: it would be a
  second writer of the period, driven by a polling read rather than a signed
  event.
- **Revoking the period on refund.** Rejected for now: no policy says how many
  days a refund takes back. Recording is what ADR-0046 asks for.

## Revisit when

- The owner chooses a provider. That ADR fixes the webhook format, the
  checkout lifetime (30 minutes here) and the provider's timeout.
- Auto-renewal lands (the second half of #323), and adds a stored token
  reference and a renewal-charge job.
- Somebody decides what a refund does to a running period.
