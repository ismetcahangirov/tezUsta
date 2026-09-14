# ADR-0009 — Dispatch model: parallel broadcast, first accept wins

- **Status:** **Accepted** (parameters pending tuning)
- **Date:** 2026-09-14
- **Decided by:** Project owner

## Context

When an order enters `SEARCHING`, it must reach masters. Two models were on the
table, and the choice shapes the matching engine, the realtime event set, and
the master experience.

## Decision

**Bolt's model: broadcast the order to all eligible nearby masters
simultaneously; the first to accept wins.**

```
Order created (SEARCHING)
        ↓
Broadcast to ALL eligible masters within the current radius
  (verified + online + offers this service + in range)
        ↓
Masters see: problem, distance, price
        ↓
FIRST TO ACCEPT WINS          ← the race lives here
        ↓
Losers are told immediately: "this order is gone"
        ↓
Nobody accepted → widen the radius → broadcast again
        ↓
Time limit reached → "no master found"
```

## Why

The owner selected Bolt's behaviour directly. On the merits it also fits this
product: urgent home repair rewards speed of fill, and a parallel broadcast
fills faster than walking a queue of sequential offers with a timeout at each
step.

## Alternatives considered

| Option                               | Why not                                                                                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sequential offers with a timeout** | Fairer and quieter — no losers on each order, and it permits ranked allocation. But it fills more slowly (each timeout is dead time for a customer with a leaking pipe), and it needs a timeout policy and a ranking model we have no data to tune. |
| **Manual pick by the customer**      | Puts a decision on someone who has an emergency, and leaves masters idle while the customer deliberates.                                                                                                                                            |

## Trade-offs accepted

- **Every order produces losers.** A master who reads an offer and loses the tap
  gets nothing. At scale this is demoralising, and it is the known cost of this
  model. It makes the "order already taken" realtime event **mandatory**, not a
  nicety — a stale offer that fails on tap is a support ticket.
- **Notification volume is higher** than sequential dispatch.
- **No ranked allocation initially.** A nearer or better-rated master has no
  advantage beyond seeing the same offer.

## Consequences — the critical one

**Concurrent accept correctness is now the single most important invariant in
the backend.** Several masters _will_ tap accept at the same moment, and
exactly one must win.

This cannot be solved by read-then-write — two requests both observe
`SEARCHING` and both write. The check must be atomic with the write:

```ts
const [claimed] = await db
  .update(orders)
  .set({ status: 'ACCEPTED', masterId, acceptedAt: new Date() })
  .where(
    and(
      eq(orders.id, orderId),
      eq(orders.status, 'SEARCHING'), // the guard, evaluated BY the database
      isNull(orders.masterId),
    ),
  )
  .returning();

if (!claimed) throw new OrderAlreadyTakenError();
```

The loser gets zero rows and a clean, specific error — never a generic 500.

A Redis lock may reduce contention but is **never** the correctness mechanism:
it can expire mid-operation, a conditional `UPDATE` cannot.

**This must be tested with genuinely parallel requests.** Sequential calls do
not exercise the race the guard exists to prevent.

Further consequences:

- **Losing masters must be notified immediately** over the realtime channel
  (EPIC 9). Without it, this model produces a bad experience on every order.
- **Radius must widen progressively.** A fixed radius produces far too many
  "no master found" outcomes.
- **An unactioned offer must expire**, not linger in a master's list.

## Matching scope — deliberately simple first

The first engine filters on **distance, availability, service category, and
verification**. Nothing else.

The weighted model in the original brief — rating, response rate, completion
rate, cancellation rate, workload — is **not** built yet. A weighted score
invented before launch is tuned against no data. It is added once real orders
exist to tune against.

## Parameters — pending tuning

Starting values, to be set in configuration (never hardcoded) and revised
against real data:

| Parameter                                      | Proposed start |
| ---------------------------------------------- | -------------- |
| Initial search radius                          | 3 km           |
| Maximum radius                                 | 10 km          |
| Radius widening interval                       | 30 s           |
| Total search duration before "no master found" | 3 min          |
| Masters broadcast to at once                   | nearest 20     |
| Re-offer an order a master declined            | no             |

These are hypotheses. EPIC 7 should replace them with measured values.

## Revisit when

- Master complaints about losing offers indicate the loser rate is too high, or
- Enough order data exists to tune a ranked or hybrid model (broadcast to a
  ranked shortlist rather than everyone in range).
