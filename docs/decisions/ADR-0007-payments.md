# ADR-0007 — Payment methods, money flow, and provider

- **Status:** **Accepted** (provider and fund-holding pending)
- **Date:** 2026-09-14
- **Scheduled for:** EPIC 12

## Context

TezUsta must collect payment for completed orders and pay masters, taking a
commission ([ADR-0010](ADR-0010-pricing-and-commission.md)). This is the
highest-risk area of the system: it is regulated, it involves a banking
relationship, and mistakes are not silently recoverable.

## Decision — payment methods

**Both cash and card are supported.** Decided by the project owner.

## Why this is the hardest option

Supporting both is not "card, plus an easy cash fallback". The two have
structurally different money flows:

```
Card:   customer → platform → (commission deducted) → master
Cash:   customer → master                           → master OWES the platform
```

**On a cash order the money never passes through the platform.** The master is
paid directly and in full, so commission cannot be deducted at source — it
becomes a **debt**.

### Consequences that follow directly

1. **A master balance (wallet) is required**, to record commission accrued on
   cash orders.
2. **A debt threshold is required.** Above it, a master must be unable to accept
   new work — otherwise the debt is never settled and cash becomes a way to use
   the platform for free.
3. **`master_wallets` and `commission_rules` may be needed with EPIC 12**, not
   deferred to EPIC 14 as originally planned. Confirm scope when EPIC 12 is
   scheduled.
4. **Cash orders still need a completion record** with the agreed amount, so the
   commission owed is computed from a recorded figure rather than a claim.

Cash also carries a dispute problem: there is no provider record to reconcile
against. The order's own history becomes the only evidence.

---

## PENDING — blocked on business and legal input

These cannot be researched. **Do not implement any payment code before they are
answered.**

1. **Does TezUsta hold customer funds, or only facilitate?**
   Holding funds — taking payment and paying the master later — is likely a
   regulated activity in Azerbaijan and needs **legal advice**, not an
   engineering decision. This is the single biggest open question.

   **The card flow drawn above assumes the answer is "holds funds".** That
   diagram is an illustration of one branch, not a decision — this item is why.
   If the answer turns out to be "facilitate only", the card money moves
   customer → master directly and the commission on a **card** order becomes a
   debt exactly as it already does on a cash order. The cash/card asymmetry
   that the wallet design rests on would then disappear, and the master
   commission balance would be the single mechanism for both. Do not build the
   asymmetry into the schema before this is answered.

2. **Which payment provider**, and is a merchant account established?
3. **How are masters paid out**, and on what cycle?
4. **What is the commission rate**, and is it added to or deducted from the
   master's price? (See [ADR-0010](ADR-0010-pricing-and-commission.md).)

### Candidate providers (research only — not a recommendation)

| Provider      | Notes                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Payriff**   | Azerbaijani gateway; AZN / USD / EUR; documented HTTP API                                                                              |
| **AzeriCard** | Long-established Azerbaijani processor (est. 1997, owned by IBA); serves 30+ banks; certified by Visa, Mastercard, UnionPay and others |

Provider choice normally follows the existing bank relationship, so this is
likely settled by the owner's banking situation rather than a technical
comparison.

---

## Architectural constraints — binding regardless of provider

These are settled now and must be respected whenever EPIC 12 starts:

- **Money is integer minor units (`bigint`), never a float.** Binary floating
  point cannot represent 0.10; commission sums will not reconcile.
- **The order freezes its own amount and commission rate.** A completed order
  settles at the figures in force when it completed, never at current values
  ([ADR-0010](ADR-0010-pricing-and-commission.md)).
- **Payment records are append-only.** State moves forward via new rows and
  status transitions, never by mutating history.
- **Every mutating payment operation is idempotent**, keyed by a client-supplied
  idempotency key. Networks retry; a retry must not charge twice.
- **Webhooks are the source of truth for settlement**, not the client's word.
  Verify the signature, and process each webhook idempotently — providers
  redeliver.
- **Prices come from the backend.** The client never submits an amount.
- **Reconciliation is a scheduled job** comparing our ledger to the provider's.
  Silent drift is the normal failure mode of payment integrations.
- **PCI scope stays at zero.** Card data never touches our servers — the
  provider's hosted page or SDK handles it. Never log, store, or proxy a PAN.
- **Amount, currency, and order id are recorded together**, so a dispute six
  months later can be answered from our own data.

## Do not

- Do not implement payment code before the fund-holding question is answered.
- Do not pick a provider by research alone — it depends on the owner's bank.
- Do not model money as a float, "just for now".
- Do not treat cash as an afterthought. It is the flow with **no provider record
  to reconcile against**, so it needs the wallet and the debt threshold designed
  in from the start, not bolted on.
