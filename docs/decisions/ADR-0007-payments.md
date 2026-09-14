# ADR-0007 — Payment provider and money flow

- **Status:** **PENDING — blocked on a business decision. Do not implement.**
- **Date:** 2026-09-14
- **Scheduled for:** EPIC 12

## Context

TezUsta must eventually collect payment for completed orders and pay masters,
taking a commission. This is the highest-risk area of the system: it is
regulated, it involves a banking relationship, and mistakes are not silently
recoverable.

**Nothing here is decided.** This ADR exists to stop a future session from
inventing an answer, and to record what must be settled first.

## Blocking questions for the user

These cannot be researched. They are business decisions.

1. **Cash or card at launch?** In this market cash-on-completion is common and
   may be the realistic launch mode. That choice changes the entire money flow.
2. **Does TezUsta hold customer funds, or only facilitate?** Holding funds —
   taking payment and paying the master later — is likely a regulated activity
   in Azerbaijan and needs legal advice, not an engineering decision.
3. **Which payment provider,** and is a merchant account already established?
4. **How is commission collected** — deducted from a master's payout, charged as
   a subscription, or invoiced separately?
5. **How are masters paid out,** and on what cycle?

## Candidate providers (research only — not a recommendation)

| Provider               | Notes                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Payriff**            | Azerbaijani gateway; AZN / USD / EUR; documented HTTP API                                                                              |
| **AzeriCard**          | Long-established Azerbaijani processor (est. 1997, owned by IBA); serves 30+ banks; certified by Visa, Mastercard, UnionPay and others |
| **Cash on completion** | No provider. Commission then has to be collected separately — via master subscription or a negative wallet balance.                    |

Provider choice normally follows the existing bank relationship, so this is
likely settled by the user's banking situation rather than by a technical
comparison.

## Architectural constraints that hold regardless of provider

These are safe to state now, and must be respected whenever EPIC 12 starts:

- **Money is `numeric`/`bigint` minor units, never a float.** Binary floating
  point cannot represent 0.10 exactly. No `double precision` column ever holds
  an amount.
- **Every payment attempt is an immutable row.** Payment records are append-only;
  state moves forward via new rows and status transitions, never by mutating
  history.
- **Every mutating payment operation is idempotent**, keyed by a client-supplied
  idempotency key. Networks retry; a retry must not charge twice.
- **Webhooks are the source of truth for settlement**, not the client's word.
  Verify the signature, and process each webhook idempotently — providers
  redeliver.
- **Prices come from the backend.** The client never submits an amount. A
  client-supplied price is a client-controlled price.
- **Reconciliation is a scheduled job** comparing our ledger to the provider's.
  Silent drift is the normal failure mode of payment integrations.
- **PCI scope stays at zero.** Card data never touches our servers — the
  provider's hosted page or SDK handles it. Never log, store, or proxy a PAN.
- **Amount, currency, and order id are recorded together**, so a dispute six
  months later can be answered from our own data.

## Do not

- Do not implement any payment code before this ADR is accepted.
- Do not pick a provider by researching alone — it depends on the user's bank.
- Do not model money as a float, "just for now".
- Do not design a wallet or payout system before the cash-vs-card question is
  answered; it determines whether a wallet is needed at all.
