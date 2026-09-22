# ADR-0029 — The customer's order screen is one status card, not a stepper or a timeline

- **Status:** **Accepted** (the order _list_ and the customer's actions on an
  order are deliberately not decided here — see _What this does not decide_)
- **Date:** 2026-09-22
- **Amends:** [`design-system.md`](../design/design-system.md) § 9, which listed
  "a tone for an unfilled order" as outstanding; this ADR settles it.
- **Decided by:** the project owner, who delegated the design decisions on
  issues [#155], [#157] and [#158] rather than supplying artwork and layouts for
  them. CLAUDE.md §17's "stop and ask" rule is answered for this screen and this
  screen only.

[#155]: https://github.com/ismetcahangirov/tezUsta/issues/155
[#157]: https://github.com/ismetcahangirov/tezUsta/issues/157
[#158]: https://github.com/ismetcahangirov/tezUsta/issues/158

## Context

The server has rendered an order in full since EPIC 6 and EPIC 8: `GET
/orders/:id`, the fourteen statuses of
[ADR-0015](ADR-0015-order-lifecycle-states.md), the transitions of #134–#137,
and the photos of #83. **The app rendered none of it.** An order was created and
then vanished from the customer's view: `CreateOrder` ended on an `EmptyState`
that said the order existed and went nowhere, and `resolveNotificationRoute`
(#146) sent every order-related notification to the role home, because there was
no screen for an order id to open.

What blocked it was not the data layer. It was that an order screen is a
composition of decisions the design system does not make: colour, type, spacing
and the component inventory are settled ([ADR-0011](ADR-0011-design-system.md)),
and how fourteen statuses are shown to a person is not.

## Decision

### 1. One status card, not a stepper and not a timeline

The screen leads with a single `StatusPill` and **one sentence saying what
happens next**. There is no stepper and no timeline of past transitions.

A stepper asserts that the lifecycle is a line, and it is not: a re-dispatch
sends an accepted order back to `SEARCHING` (#136), a dispute branches away from
payment, and `NO_MASTER_FOUND` ends the journey without reaching any of the
steps drawn after it. Any stepper honest about those is a diagram, not a
component. A timeline answers "what has happened", which is an audit question —
it belongs to the admin surface that reads `order_status_history`, not to a
customer standing in their kitchen waiting for somebody.

The question a customer actually has is **"where is my order now, and what
happens next"**, and it has exactly two parts. The card answers both.

### 2. Every status is named, including the ones a customer rarely sees

`order-status-presentation.ts` maps all fourteen statuses to a tone, a label and
a next-step line — total over `OrderStatus`, so a status added to
[ADR-0015](ADR-0015-order-lifecycle-states.md) without copy is a compile error
rather than a blank card. Statuses that are indistinguishable to a customer
still get distinct copy: `PAYMENT_PENDING` and `PAID` are the same money
changing hands from the platform's point of view and are not the same sentence
to the person paying.

### 3. `NO_MASTER_FOUND` gets a fifth status tone, `unfilled`

`design-system.md` § 9 asked for either a fifth tone or a deliberate decision to
reuse `pending`. This is the deliberate decision: a fifth `StatusTone` named
`unfilled`, rendered today with the **neutral** badge.

Reusing `cancelled` was rejected for the reason that document gives — nobody
cancelled; the platform had no supply, and painting it in the failure colour is
the visual form of exactly the conflation the status exists to prevent. Reusing
`pending` outright was rejected too: it is a terminal state, and `pending` reads
as "still going". Naming it separately while rendering it as neutral costs one
line and makes a future badge tone a one-line change instead of a search through
every screen. The design system's own rule carries the meaning either way:
colour never says what a status is, the label does.

### 4. The screen reads; it does not act

There is no cancel button, and no other transition control.

The customer's cancel edge exists on the server (#135), but **the cancellation
policy does not** — penalties and rules are one of the open decisions CLAUDE.md
§ 2 lists, and they are a legal and commercial question rather than a design
one. A cancel button has to say what cancelling costs, and no one can yet write
that sentence. Shipping it without the sentence would be shipping the one
control on this screen whose consequences we cannot state.

### 5. The route is a stack screen, `/(customer)/order/[id]`

It sits in the existing customer `Stack`, beside `order/new`. It is not a tab,
not a modal, and it does not touch the root navigation pattern — which is still
the owner's and still open. A stack screen is the smallest thing that can be
pushed from creation and replaced into from a notification, and it prejudges
nothing about what the root eventually looks like.

`resolveNotificationRoute` now names this route for every order notification
whose audience is the customer, and continues to name the **role home** for a
master: there is no master-facing order screen yet, and inventing a destination
for one would be the sort of guess that table exists to prevent.

### 6. The order's state always comes from the server

The screen takes an id from the route and nothing else. It does not accept an
order object through navigation, and creation does not hand it one — a status
carried in a navigation parameter is a status that was true when the navigation
started, and this is the screen whose whole subject is what changed since then.

The four request states the catalogue established are all rendered
deliberately: loading, loaded, a refresh that failed over content already on
screen, and a failure with nothing behind it. A 404 — which is what the API
answers for somebody else's order, never a 403 — is rendered as a plain "this
order is not available", not as an error to retry.

### 7. Photos are thumbnails, and nothing more

Attached photos render as a row of thumbnails, each fetching its own short-lived
download URL (`GET /orders/:id/photos/:photoId/download`). There is no
full-screen viewer, no gallery and no zoom: a lightbox is a component the
inventory does not have, and adding one would be inventing a visual pattern
rather than using the settled ones.

### 8. The master is an id, and stays one

The screen shows no master name, photograph, rating or position. `Order` carries
`masterId` alone on purpose, and who the master is reaches the customer through
the tracking surface of EPIC 9, only while the order is active
(`docs/engineering/security.md` § PII and privacy). The status line says a
master has accepted; it does not say who.

## Alternatives considered

| Option                                             | Why not                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A stepper across the happy path                    | The lifecycle is not a line. Re-dispatch, dispute and `NO_MASTER_FOUND` all leave it, and a stepper that draws them is a diagram                             |
| A timeline of `order_status_history`               | Answers an audit question, not the customer's. It is also a second endpoint and a second empty state for information nobody asked for while they are waiting |
| Fold the order into a modal over the catalogue     | A notification has to be able to land on it directly, and a modal is a poor deep-link target. It would also decide part of the root navigation by accident   |
| Pass the created order through navigation params   | Saves one request and makes the screen lie the first time a status changes between navigation and render                                                     |
| Ship a cancel button with placeholder penalty copy | Placeholder copy about money is a promise. The one control with a consequence is the one that must not be guessed                                            |

## Trade-offs accepted

- **A customer still has no list of their orders.** This screen is reachable
  from creation and from a notification, and nowhere else: closing the app loses
  the way back in. That is a real hole and it is left open deliberately, because
  a list needs pagination, an empty state and a place in the root navigation —
  the last of which is the owner's. It is filed as its own issue rather than
  smuggled in here.
- **No live updates.** The screen reads on mount and refetches on its own cache
  policy; a status that changes while it is open is not pushed. That is EPIC 9's
  socket, and opening one here would build half of it in the wrong place.
- **Fourteen statuses means fourteen strings**, and they are a first draft in
  Azerbaijani. Being in one table makes them one file to replace.
- **One request per photo thumbnail.** The download URL is presigned per photo
  and deliberately not embedded in the list response
  ([ADR-0005](ADR-0005-object-storage.md)), so a three-photo order costs three
  small requests. The route is rate-limited; three is well inside it.

## Consequences

- `StatusTone` gains `unfilled`, and `design-system.md` § 9 loses its open item.
- `resolveNotificationRoute` returns a route object rather than only a role
  home, so the half of #146 that was waiting on a destination is closed.
- `CreateOrder` no longer ends on a dead end: `app/(customer)/order/new.tsx`
  replaces itself with the order.
- The service name and the address are read through the endpoints that already
  cache them, so an order shows what the customer chose without either being
  stored on the order.

## What this does not decide

- **The customer's order list**, and therefore the way back to an order after
  the app is closed. Its own issue.
- **Any action on an order** — cancelling above all, which waits on the
  cancellation policy.
- **The root navigation pattern.** Still open, still the owner's.
- **Live position and ETA.** EPIC 9.
- **The words.** Every string is a first draft; replacing them is one file.

## Revisit when

The cancellation policy is settled (a cancel control belongs here), EPIC 9 lands
(live status and position change what the card shows), or the root navigation
pattern is decided (the screen may become a tab's detail rather than a stack
push).
