# ADR-0015 — Order lifecycle: the complete state set

- **Status:** **Accepted**
- **Date:** 2026-09-15
- **Supersedes:** the `TRANSITIONS` table in
  `docs/architecture/backend-architecture.md` as it stood before this ADR.

## Context

The order state machine is the spine of the product. Three outcomes that every
product document describes could not be represented in it, and one documented
transition did not exist.

| Documented outcome                                   | Where it is described            | State machine before this ADR                |
| ---------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| The assigned master cancels, the order goes back out | `customer-flow.md`               | No edge out of `ACCEPTED` except `CANCELLED` |
| Nobody accepted before the time limit                | ADR-0009, both flows             | Collapsed into `CANCELLED`                   |
| An admin resolves a dispute, or refunds              | `admin-flow.md`, `user-roles.md` | `DISPUTED` was terminal                      |
| The master departs before arriving                   | The table itself                 | No flow triggered it                         |

Each gap has a cost beyond tidiness. A timed-out order indistinguishable from a
customer cancellation corrupts the cancellation-rate metric that master quality
and admin intervention both depend on. A terminal `DISPUTED` means three
documented admin capabilities are unreachable. And `MASTER_ON_THE_WAY`, which
the customer tracking screen depends on, had nothing that entered it.

## Decision

The complete status set, and the only legal transitions:

```ts
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ['SEARCHING', 'CANCELLED'],
  SEARCHING: ['ACCEPTED', 'NO_MASTER_FOUND', 'CANCELLED'],
  ACCEPTED: ['MASTER_ON_THE_WAY', 'SEARCHING', 'CANCELLED'],
  MASTER_ON_THE_WAY: ['MASTER_ARRIVED', 'SEARCHING', 'CANCELLED'],
  MASTER_ARRIVED: ['IN_PROGRESS', 'SEARCHING', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['PAYMENT_PENDING', 'PAID', 'DISPUTED'],
  PAYMENT_PENDING: ['PAID', 'DISPUTED'],
  PAID: ['DISPUTED'],
  DISPUTED: ['RESOLVED', 'REFUNDED'],
  RESOLVED: [],
  REFUNDED: [],
  NO_MASTER_FOUND: [],
  CANCELLED: [],
} as const;
```

Three statuses are new — `NO_MASTER_FOUND`, `RESOLVED`, `REFUNDED` — and the
re-dispatch edges back to `SEARCHING` are new.

### `DRAFT` is the idempotency anchor

Order creation writes a `DRAFT` row together with the client's idempotency key,
then transitions it to `SEARCHING` in the same transaction. A retry carrying the
same key finds the existing order and returns it instead of creating a second
one. This is what `customer-flow.md` means by "no silent duplicate order on
retry". A `DRAFT` row that never reaches `SEARCHING` is an abandoned creation
attempt and is swept; the customer never sees the state.

### Re-dispatch

`ACCEPTED`, `MASTER_ON_THE_WAY` and `MASTER_ARRIVED` may return to `SEARCHING`.
The transition is triggered only by the assigned master cancelling, or by an
admin acting on a stuck order. It is never triggered by the customer, who
cancels to `CANCELLED` instead.

Re-dispatch, in one transaction:

1. Clears `master_id` and `price_minor`
   ([ADR-0013](ADR-0013-price-freeze-point.md)).
2. Increments `redispatch_count`.
3. Excludes the cancelling master from the next broadcast for this order.
4. Writes `order_status_history` with the actor and reason.

`redispatch_count` is capped by `MAX_ORDER_REDISPATCHES`. At the cap the order
goes to `NO_MASTER_FOUND` rather than searching again, so an order cannot
ping-pong indefinitely. Clearing `master_id` is what keeps ADR-0009's accept
guard — a conditional update on `master_id IS NULL` — correct on the second
round.

### `NO_MASTER_FOUND`

Terminal, and distinct from `CANCELLED`. Entered when the dispatch time limit
expires with no acceptance, or when re-dispatch hits its cap. It is not a
cancellation by anyone and must never be counted as one: cancellation rate is a
master and customer quality signal, and an unfilled order is a supply signal.

### `RESOLVED` and `REFUNDED`

`DISPUTED` is no longer terminal. An admin closes a dispute either way:

- `RESOLVED` — the dispute is closed with no money movement.
- `REFUNDED` — the dispute is closed and a refund was issued.

Both are terminal. Both require an admin actor and a mandatory reason. A refund
on a cash order is a commission adjustment against the master's balance, not a
card refund; the status is the same, the mechanism differs and is settled in
EPIC 12.

### Admin override does not bypass the table

`admin-flow.md` grants an admin the power to force a transition on a stuck
order. That power is over the **actor** check, not the **edge** table:

- An admin may perform a transition that the table permits, even though they
  are neither the customer nor the assigned master.
- An admin may **not** perform a transition the table does not contain.
- Every override writes `order_status_history` with actor, reason and
  timestamp. The reason is mandatory and is not free of consequence: it is what
  the audit trail is made of.

If an admin needs an edge that does not exist, the edge is missing from this
ADR and the answer is a new ADR, not a special case in a service.

## Why

**A status is how the system tells the truth about an order.** Collapsing "no
master was found" into "cancelled" is not a simplification, it is the system
recording something that did not happen. Everything downstream — the customer's
screen, the master's rating, the admin's queue, the supply dashboard — reads
that field and inherits the error.

**Re-dispatch rather than cancel-and-recreate.** The customer's problem has not
changed; only the master has. Recreating the order would lose the history, the
photos, the address and the idempotency key, and would show the customer a new
order they did not create.

**Terminal dispute states rather than a separate resolution table.** The
resolution is a fact about the order and belongs on the order. A parallel table
would let an order be simultaneously `DISPUTED` and resolved, which is exactly
the class of ambiguity a state machine exists to prevent.

## Alternatives considered

**A single `CLOSED` status with a reason column.** Fewer statuses, and the
reason carries the meaning. Rejected: every query would have to filter on the
reason to mean anything, which is a state machine with the compiler switched
off. Distinct statuses make an invalid transition a rejected write rather than
a report that quietly reads wrong.

**Keep `DISPUTED` terminal and track resolutions elsewhere.** Rejected, as
above.

**Let the customer confirm completion before `COMPLETED`.** This was recorded
as an open question in `customer-flow.md`. It is now closed as **no**: the
assigned master marks the work complete, and the customer's recourse is to open
a dispute within the dispute window. The alternative — an order that stalls
because the customer put their phone down — leaves the master unpaid for work
that is finished, and gives the customer a lever over payment that the dispute
process already provides more fairly. The actor rule already implied this; it
is now stated.

**Allow re-dispatch from `IN_PROGRESS`.** Rejected: once work has started, the
job is half-done and a different master cannot pick it up from an unknown
state. A master who abandons work in progress cancels, and that is a dispute
and a quality event, not a re-dispatch.

## Consequences

- `orders` gains `redispatch_count` (integer, default 0).
- `MAX_ORDER_REDISPATCHES` and the dispute window are configuration, not
  literals.
- `order_status_history` must record the actor for every transition; it already
  did, and re-dispatch and override make it load-bearing rather than
  informational.
- The status enum is a database enum plus a shared TypeScript union. Adding a
  status is a migration.
- Every transition in the table needs a test, and so does every transition not
  in it — `CLAUDE.md` § Testing already requires the invalid ones.
- **Still open, and owner-owned:** the cancellation policy — who may cancel at
  which status without penalty, and what the penalty is. That is the EPIC 8
  blocker already recorded, and this ADR does not settle it. This ADR settles
  only which transitions exist, not what they cost.
