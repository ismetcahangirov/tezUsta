# ADR-0030 — The customer's root is a tab bar, and the order list is one of its tabs

- **Status:** **Accepted** (for the customer tree. The master's root is
  deliberately left a stack — see _2. The master's root is not a tab bar yet_)
- **Date:** 2026-09-22
- **Amends:** [`design-system.md`](../design/design-system.md) § 9 and
  [`CLAUDE.md`](../../CLAUDE.md) § 17, both of which list "the navigation
  pattern — tab bar versus stack, and what sits at the root of each role's
  tree" as outstanding. This ADR settles it for the customer.
- **Builds on:** [ADR-0029](ADR-0029-customer-order-screen.md), which recorded
  the absence of a list under _Trade-offs accepted_ rather than as an oversight.
- **Decided by:** the project owner, who asked for [#160] to be worked on
  knowing it was filed as blocked on this decision — the same delegation that
  produced ADR-0029. CLAUDE.md § 17's "stop and ask" rule is answered for the
  customer's root and for this list, and for nothing else.

[#160]: https://github.com/ismetcahangirov/tezUsta/issues/160

## Context

An order has a screen ([ADR-0029](ADR-0029-customer-order-screen.md), #155) and
no way back to it. It is reachable from the end of order creation and from a
tapped notification, and from nowhere else — so a customer who backgrounds the
app while a master is on the way has no route back except waiting for the next
push.

The server side has been finished since EPIC 6: `GET /orders` is
cursor-paginated (#82), keyset-ordered `created_at desc, id desc`, twenty rows a
page, and **nothing in `apps/mobile` has ever called it.**

What blocked the app side was not the data layer. A list needs somewhere to be
reached _from_, and the customer's home is the service catalogue — so "where the
entry point lives" is the root navigation pattern, which was the owner's and
open. Three smaller decisions hang off the same question: whether an active
order is surfaced differently from a finished one, what an empty list says, and
whether a finished order is ever hidden.

## Decision

### 1. The customer's root is a bottom tab bar

Two tabs today: **the catalogue** (`Ana səhifə`) and **the order list**
(`Sifarişlər`).

They live in `app/(customer)/(tabs)/`, _inside_ the stack that
`app/(customer)/_layout.tsx` already owns. Order creation, one order, and saved
addresses stay outside the group and therefore push **over** the tab bar rather
than becoming tabs of their own. The distinction the file layout encodes is the
whole point of the pattern: **a tab is a place you return to; a stack screen is
a place you came from.** Order creation has its own back semantics and its own
exit; it is not a destination.

A link on the catalogue's header would have been a smaller diff. It would also
have made the order list a subordinate of the catalogue, which it is not: a
customer opening the app to see whether the master is still coming did not come
from the catalogue, and should not have to pass through it. And it would have
left the root question open to be answered again by the next screen that needs
somewhere to live.

### 2. The master's root is not a tab bar yet

The master's tree has exactly one destination — availability. A one-tab tab bar
is a worse stack, so the master keeps the stack until the job list (EPIC 8/9)
gives it a second place worth returning to, at which point this same decision
applies to it unchanged.

**The pattern is decided for both roles; where it is _applied_ is a function of
what the tree actually contains.** That is not an inconsistency to be tidied up
later by adding a tab bar to a screen that has nothing to put in it.

### 3. Open orders come first, under their own heading

The list is the server's order — newest first — partitioned into **open** and
**finished**, with headings rendered only when both sections have rows. A
customer with a master on the way has one order that matters and possibly twenty
that do not.

An order is **open** while something is still expected of somebody: `SEARCHING`,
`ACCEPTED`, `MASTER_ON_THE_WAY`, `MASTER_ARRIVED`, `IN_PROGRESS`, `COMPLETED`,
`PAYMENT_PENDING`, `DISPUTED`. It is **finished** at `PAID`, `RESOLVED`,
`REFUNDED`, `NO_MASTER_FOUND` and `CANCELLED`.

`PAID` is finished here even though the transition table still allows
`PAID → DISPUTED`: the test is not "can this order ever change again", it is "is
anyone waiting on anything". Nobody is.

The classification is **total over `OrderStatus`**, in the same file and for the
same reason as ADR-0029's tone table: a status added to
[ADR-0015](ADR-0015-order-lifecycle-states.md) without a decision here must be a
compile error, not a row that silently files itself under "finished".

**The known limit, recorded rather than hidden:** the partition sees only the
pages that have been loaded. An open order older than everything loaded is not
pinned until the customer pages down to it. Fixing that properly means a
status-**set** filter on `GET /orders` — today's `?status=` takes one value, and
"open" is nine — which is an API change for a customer who has more than twenty
orders with an old one still open. It is not made now.

### 4. Nothing is ever hidden, and nothing expires

A finished order stays in the list for as long as the account exists. The list
is the customer's only record of what they asked for and what they paid, and
reviews (EPIC 11) and payment history (EPIC 12) will hang off exactly these
rows. An app that quietly drops a cancelled order after thirty days is deleting
somebody's evidence to keep a screen tidy.

### 5. A row is the order in the customer's own words

Title: the **description** the customer wrote, at most two lines. Beneath it the
date, and the price once there is one. Beside it the `StatusPill` from
`presentOrderStatus`, and the price through `formatOrderPrice` — one status
vocabulary and one money formatter, not a second set for the list.

Not the service name. `Order` carries `serviceId` and nothing else — resolving
it means fetching the catalogue and holding a map — and "Santexnika" identifies
five of a customer's orders where "mətbəxdə kran sızır" identifies one.

### 6. Paginated with RTK Query's `infiniteQuery`

`build.infiniteQuery`, with the server's `nextCursor` as the page param and
`getNextPageParam` returning `undefined` at the end — not a single cache entry
with `serializeQueryArgs` + `merge`.

The difference is not style. `createOrder` invalidates `{ type: 'Order', id:
'LIST' }`, and **on invalidation a merged single entry refetches only its most
recent argument** — the last cursor — and merges that page back into the pages
it already holds. Every earlier page stays as it was, including the rows that
have since shifted a page down, which is the repeated row #160's acceptance
criteria forbid. An infinite query refetches the pages it is holding.

Verified against the installed artifact rather than from memory (CLAUDE.md § 9):
`@reduxjs/toolkit@2.12.0` ships `build.infiniteQuery` and `useInfiniteQuery`.

**The next page is a control the customer presses**, not a scroll position. A
list that fetches twenty more rows because a finger moved spends somebody's
mobile data on rows they did not ask for, on a network where that is a real
cost; the customer who came to check on a master never reaches row twenty
anyway; and a button is the half of this screen a screen-reader user can
actually operate.

### 7. The tab bar's active tint is `text`, never `accent`

§ 3 of the design system is explicit: on the light theme lime is a surface
colour and never type or an icon — `#c8f751` on `#ffffff` is 1.2:1. An active
tab is therefore `text` and an inactive one `text-muted`, in both schemes, and
the bar sits on `surface` above a `border` hairline. A lime icon would have been
the obvious "brand" choice and is the one thing the accent rule forbids.

## Consequences

- The customer's app becomes navigable for the first time: two destinations that
  both survive the app being closed.
- **Settings is still reachable from nowhere**, for either role. It is the
  obvious third tab, but `app/(shared)/settings.tsx` belongs to both roles and
  giving it a home in each tree is a decision of its own — filed separately, not
  smuggled in here.
- The list does not update itself. It refetches when the tab is focused and when
  an order is created; live status is EPIC 9's socket.
- Every string on the screen is a first draft, like the rest of `ORDERS_COPY`,
  and the empty state's words and artwork remain the owner's (§ 17).

## What this does not decide

The master's root, the onboarding flow, illustration and empty-state art,
motion, and the map style are untouched and still the owner's.

## Alternatives considered

| Alternative                                 | Why not                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A "My orders" link on the catalogue header  | Smallest diff, but makes the list subordinate to the catalogue and leaves the root question open for the next screen to re-ask |
| A drawer                                    | Hides both destinations behind a gesture, and neither this market's apps nor the reference design use one                      |
| A row inside settings                       | Buries the thing a waiting customer opens the app for, behind a screen that is itself unreachable                              |
| An `active=true` filter on `GET /orders`    | An API change, a second list request, and a second source of truth for "open" — for a case that needs twenty orders to appear  |
| `serializeQueryArgs` + `merge` on one entry | Refetches one page on invalidation and re-merges it into stale pages: the duplicated row the issue explicitly forbids          |
