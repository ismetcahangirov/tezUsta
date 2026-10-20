# ADR-0058 — Auto-renewal: explicit consent at checkout, one charge per period, the webhook still decides

- **Status:** **Accepted**
- **Date:** 2026-10-21
- **Context:** EPIC 14 (#15), issue [#323], second half
- **Builds on:** [ADR-0046](ADR-0046-subscription-only-monetisation.md) § 5–6
  (renewal on a saved card, price-change notice),
  [ADR-0057](ADR-0057-subscription-billing-port.md) (the billing port, the
  checkout and the webhook)
- **Does not decide:** the billing provider (still open, CLAUDE.md § 1), or
  any copy or screen. The web purchase page that offers the choice is #334.

[#323]: https://github.com/ismetcahangirov/tezUsta/issues/323

## Context

ADR-0046 § 6 chose auto-renewal: a merchant-initiated charge on a saved card,
scheduled by TezUsta, with manual renewal as the fallback. Three things were
left for the implementation to settle:

- how a master consents;
- when the charge is made;
- what keeps it from charging twice, or charging when it should not.

## Decision

### 1. Consent is explicit, on the checkout that saves the card

`POST /masters/me/subscription/checkout` takes `autoRenew`, which defaults to
`false`.

Only a checkout opened with `autoRenew: true` asks the provider to save the
card. Only the verified success of such a checkout stores the card's token. A
token arriving on any other payment is ignored.

The master turns auto-renewal off with
`DELETE /masters/me/subscription/auto-renewal`. They can read its state with
`GET` on the same path. There is no endpoint that turns it on without a
payment.

### 2. A saved card is a token reference, kept until it is revoked

`subscription_payment_methods` holds the provider's token for the card, and
nothing about the card itself.

- The token cannot be used without TezUsta's merchant credentials, so PCI
  scope stays at zero. It still authorises charges, so it is never logged or
  returned.
- A master has at most one live card. A newer one replaces the older one.
- A trigger allows exactly one change to a row: revoking it, once. A row is
  never deleted, because renewal charges point at it.

### 3. One charge per period, a day before it ends, at the current price

A job on the `maintenance` queue (`SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS`,
15 minutes by default; 0 disables auto-renewal) finds `active` periods ending
within `SUBSCRIPTION_RENEWAL_LEAD_HOURS` (24 by default).

A period is a candidate only if:

- nothing is queued after it;
- the master is verified;
- the master has a live card;
- the card was saved after any cancellation.

For each candidate the job starts **one** charge, at the price current then.

- **At most once per period.** The charge is written as a checkout row of kind
  `renewal` with `renews_period_end`. That pair is unique per master and is
  checked under the master's checkout lock before the provider is called.
- **The row's id is the provider's idempotency key.** A retried run cannot
  charge twice.
- **A charge the provider would not start** is retried on the next run. Such a
  charge never wrote a row.

### 4. When not to charge

- **The subscription is cancelled, in grace, or a trial.** Cancelling stops
  renewal (ADR-0046 § 6). A card saved before a cancellation is not revived by
  a later purchase made without consent.
- **Purchases are closed.** The renewal is deferred and retried each run.
  Charging money while an admin has closed sales is worse than letting a
  period lapse into grace.
- **The price changed and its notice was not sent.** A renewal may charge a
  price version only if the master last paid that version, or the #326
  price-change push for it is in the ledger. Otherwise nothing is charged, and
  an error line asks a person to look. The 30-day rule (ADR-0046 § 5) makes
  this rare.

### 5. The outcome goes through the webhook, as any payment's does

A renewal success arrives as a verified webhook and calls `activatePeriod`.
Because the period is still running, the result is `period_queued`, and the
sweep starts the new period when the old one ends.

A failure is recorded as `payment_failed`. It is not retried. The period lapses
into grace on its own, where the master renews by hand with a new checkout
(ADR-0046 § 6).

The job never extends a period itself.

## Consequences

- A real provider must support saving a card on its hosted page and charging
  it later. Payriff, Epoint and AzeriCard all document this (ADR-0046 § 6). On
  AzeriCard a token lasts a year, after which a renewal fails and the master
  renews by hand.
- A master who changes their mind about auto-renewal does so on the web
  purchase page, #334. The app shows status only (ADR-0046 § 7).
- A declined renewal is not retried during grace. Whether it should be is an
  open product question, for revisiting after launch.

## Alternatives considered

- **Consent by default, with opt-out.** Rejected: charging a card the master
  did not knowingly offer is a dispute waiting to happen. An explicit choice
  costs one checkbox on #334.
- **The provider's own scheduler** (Payriff has one). Rejected in ADR-0046
  § 6: it would put the state machine in two places.
- **Charging at the period end rather than a day before.** Rejected: a failure
  would then always land the master in grace, where a day's lead gives the
  webhook, a provider retry and a person time to act.
- **Retrying a declined renewal.** Not now: no policy says how often, and the
  manual path covers it.

## Revisit when

- The provider is chosen. Its ADR fixes how a token is returned, its lifetime,
  and the charge call.
- Launch data shows how often renewals decline, and whether a retry in grace
  would keep masters working.
