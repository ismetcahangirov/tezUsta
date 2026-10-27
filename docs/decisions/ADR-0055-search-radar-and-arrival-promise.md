# ADR-0055 — The search radar and the arrival promise

- **Status:** **Accepted** (interim owner art, motion and copy listed below,
  awaiting the owner's acceptance; the fallback estimate's two constants are
  hypotheses until production routes calibrate them)
- **Amended by:** [ADR-0068](ADR-0068-cancellation-rules.md) — the
  consequences of lateness this ADR deferred are settled: none automatic, a
  late-arrival count on the master's admin file, and a free cancellation for
  the customer once the promise has passed by 10 minutes.
- **Date:** 2026-10-20
- **Context:** EPIC 21 (#393), issue [#394]
- **Decided by:** the owner settled four things on 20 October 2026, when they
  asked for a Bolt / Yandex Go-style search and arrival: the customer does not
  choose a master ("ustanı seçmək olmasın, hazırki kimi ustalardan kim cəld
  davrandı o götürsün"); the master does not type an arrival time, it comes
  from the map; **30 seconds** are added to the computed travel time; and the
  master should feel responsible for arriving by the time shown. Everything
  else was delegated, in the "decide and record it" pattern of ADR-0035 and
  ADR-0054. What is genuinely owner-owned ships as interim and is listed under
  _Interim, owner-owned_.
- **Amends:** [ADR-0035](ADR-0035-customer-tracking-map.md) § 1, which listed
  the tracking card's contents as a heading, a map and one state sentence. The
  card now also carries the arrival time (§ 12 below). The rest of ADR-0035
  stands, § 7 included: the customer still has nothing to navigate to, so no
  "open in Maps" link is added.
- **Supersedes in part:** [ADR-0004](ADR-0004-location-and-maps.md)'s naming
  of Google's **Distance Matrix** as the once-per-order ETA call. The call is
  the Routes API's `computeRoutes` (§ 7). The rule itself (routing once, for
  the assigned master, never for matching) is unchanged.
- **Builds on:** [ADR-0009](ADR-0009-dispatch-model.md) (parallel broadcast,
  first accept wins, unchanged), [ADR-0004](ADR-0004-location-and-maps.md)
  (Google Maps Platform behind an interface), [ADR-0029](ADR-0029-customer-order-screen.md)
  (whose "what this does not decide" left live position and ETA to EPIC 9),
  [ADR-0032](ADR-0032-realtime-transport.md) (the socket is a hint, HTTP is the
  truth), [ADR-0036](ADR-0036-master-work-surface.md) (the job is one pushed
  screen).

[#394]: https://github.com/ismetcahangirov/tezUsta/issues/394

## Context

Two stretches of an order leave the customer with nothing to look at.

**While the order is `SEARCHING`**, the customer sees one status card. Behind
it, dispatch broadcasts in six waves at t = 0, 30, …, 150 s, widening from
3 000 m to 10 000 m (`dispatch-schedule.ts`), to at most 20 masters per wave,
and gives up at 180 s. None of that is visible, so a search that is reaching
ten masters looks the same as one reaching nobody.

**After a master accepts**, the customer sees the master move (ADR-0035) but is
never told when they will arrive, and the master is never held to a time.
`location-services.md` § Distance and ETA has said since EPIC 4 that routing is
called "once, for the assigned master, to show the customer an ETA". That call
was never built.

The radar is also **the first surface that shows a person who is not a party to
an order anything derived from a master's position.** Until now the rule was
absolute: a master's live position goes only to the customer on the active
order, only while it is active (CLAUDE.md § 11, `security.md` § PII and
privacy). This ADR has to say exactly what that rule now permits, rather than
leave it to an implementation issue.

## Decision — the radar (while `SEARCHING`)

### 1. A card under the status card, in the slot the tracking card uses later

The radar is a card directly under the status card on `(customer)/order/[id]`,
the slot the tracking card takes after an accept. It holds a heading, a square
map at full card width, and one sentence. It is not a full-screen map with the
order in a sheet, for the reasons ADR-0035 § 1 gives: that is a navigation
pattern, and it would demote the status card ADR-0029 made the lead.

Like the tracking map, it is **a picture, not a control**. Pan, zoom, rotate
and tilt are off, because the map sits inside the screen's `ScrollView`. The
camera is framed once each time the ring's radius changes, to fit the ring,
and never per animation frame.

### 2. What it draws

- **The customer's own address** at the centre, with the same marker the
  tracking card uses for the destination.
- **A pulse**: a screen-space overlay centred on the card (the address is the
  camera's centre), animating only `transform: scale` and `opacity` on the
  native driver. It is not an animated map shape: re-rendering a native
  `Circle` radius at 60 fps is exactly the cost a mid-range Android cannot
  spare. With the system's reduce-motion setting on, the pulse does not run and
  a static ring stands in.
- **A ring** at the radius the search has reached:
  `currentDispatchRadiusM(searchingSince, now)`, the same function the engine
  broadcasts with, so the picture and the broadcast cannot disagree.
- **One point per coarse cell** (§ 3) that holds at least one master **the
  current search has offered this order to**.

It does **not** draw every master online nearby. A map of available masters
around any address would be a live supply map of the city, handed to anyone
willing to create an order. Restricting the points to masters this search
actually reached ties what the customer sees to their own order, and it is the
truthful answer to their question: who has been asked.

**Which masters count as "this search".** A master is part of the current
search when their `order_offers` row was offered **at or after the order's
current `searching_since`**: the last `SEARCHING` row in
`order_status_history`, the same generation every dispatch job is keyed on.
`order_offers` has one row per `(order_id, master_id)` for the life of the
order and re-offers by updating it, so its `created_at` says when the master
was _first_ reached, which after a re-dispatch may be a previous search.
`expires_at` cannot stand in either: an accept followed quickly by a
re-dispatch leaves `lost` rows from the old search whose windows run past the
new `searching_since`. So #397 adds **`order_offers.offered_at`**, set on
insert and on every re-offer, and the radar's predicate is
`offered_at >= searching_since`. It is the only predicate that is exact at
both edges.

A master who **declined** in the current search is still counted and still
drawn. Removing their point would tell the customer that a master near them
refused the order, which is both discouraging and a fact about that master the
customer has no use for. The radar shows reach, not interest.

A master is drawn only while their latest `master_locations` row is younger
than `DISPATCH_MAX_POSITION_AGE_SECONDS` (the eligibility rule) **and**
`masters.is_available` is still true. The second condition matters because the
age limit is 300 s and the whole search is 180 s: without it, a master who goes
offline during a search stays on its picture until the search ends, and going
offline is a master's way of saying they are not sharing their position.

### 3. Coarsening: a fixed 0.005° grid, snapped to cell centres, capped at 12

Each drawn master's latest point is snapped to a cell on a **global** grid and
replaced by the cell's centre:

```
rowHeightDeg = 0.005                      (≈ 557 m of latitude)
row          = floor(latitude / rowHeightDeg)
centreLat    = (row + 0.5) × rowHeightDeg
colWidthDeg  = rowHeightDeg / cos(centreLat)   (≈ 0.00657° at Baku, ≈ 557 m)
col          = floor(longitude / colWidthDeg)
centreLng    = (col + 0.5) × colWidthDeg
```

The cells are deduplicated, sorted by the distance from the order's address to
the cell centre (ties by row, then column), and **capped at 12**. A drawn point
is never more than half a cell's diagonal, about 390 m, from the master's real
position. The raw coordinate never
leaves the repository function that does the snapping.

**Why a fixed global grid, and not one centred on the customer.** A grid
anchored to the order's address moves whenever the address does. Someone who
places orders from a few addresses a couple of hundred metres apart would get
a differently placed cell around the same stationary master each time, and the
intersection of those cells shrinks towards the master's real position. A grid
anchored to the globe puts the same master in the same cell no matter whose
order is asking, so repeated observation never gets below one cell.

**Why snapping, and not random noise.** Noise averages out. The mean of twenty
jittered observations of a master sitting at home is the master's home. A snap
gives the same answer every time, and that answer is a cell.

**Why 0.005° (≈ 557 m × 557 m, about 0.31 km²).** The radar has one job:
showing that the search is reaching people, and roughly where. At a 3 km ring,
557 m cells still separate "two masters just round the corner" from "one master
at the edge", and at 10 km they are small dots. What a customer can learn is
bounded by that size, and the ADR states it plainly:

- **They can learn that some master is within a cell, never who.** No id, name,
  avatar, rating or distance goes with a point, and the cells are re-sorted by
  distance from the address, so the response's order says nothing about which
  master is which.
- **A stationary master at home stays in one cell across orders.** Someone who
  orders repeatedly can conclude that _a_ master spends time in a given
  0.31 km² cell. In Baku's apartment districts that is many blocks of flats,
  not a building. Linking the cell to a person requires that master to accept
  one of the observer's orders, at which point the observer is a party and is
  shown the master's identity and live position legitimately.
- **A master on the move can cross a cell boundary between two waves**, which
  places them near that boundary at that moment. That is a momentary position
  of somebody in transit, at most six times per search, and not a place they
  return to.
- **Probing is loud and bounded.** Each observation is a real order: it rings
  up to 20 real masters per wave, is recorded in `order_offers`, and is capped
  by `MAX_OPEN_ORDERS_PER_CUSTOMER` (3) and
  `ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR` (20) behind a phone sign-in. A
  customer who creates and cancels orders to watch the radar shows up in the
  cancellation-during-search data.

A 250 m cell (one or two blocks) was rejected as close to a building address.
A 1 km cell was considered and is the fallback if the owner or counsel judges
557 m too fine: it costs the radar its near-field detail (everything within a
kilometre collapses into a handful of points) without changing anything else
in this design. Changing it is a constant, not a redesign.

**Why a cap of 12.** Six waves of up to 20 masters can reach well over a
hundred. Past a dozen points the picture stops reading as individual people and
starts reading as a density map, which is the supply map § 2 refuses. The count
(§ 4) carries the full number.

### 4. What it says in words

One sentence with a count of the masters the current search has offered the
order to, for example "N masters have seen your request", and nothing that
identifies anyone. The count includes masters who are not drawn (stale,
unavailable, or past the cap of 12), so it never goes down during a search
while points can. The sentence is a polite live region, and on iOS is announced
with `announceForAccessibility`, as ADR-0035 § 3 does for the tracking state.

The radar shows **no time**: no elapsed clock and no countdown to the give-up.
`endsAt` is in the response so the client can tell a stalled search from a
finished one, not so it can count a customer down to disappointment.

### 5. When it updates: once per wave, by event, never by polling

The server publishes `order:search-wave` into `order:{orderId}` at the end of
every wave that reached the broadcast step, **including a wave that reached
nobody**, so the ring still grows. The frame carries `orderId`, `round`,
`radiusM`, `offeredCount` and `at`, and **no cells and no coordinates**. The
client re-reads `GET /orders/:id/search`, so the coarsening rule lives in one
place on the server.

The customer can already join `order:{orderId}` while the order is
`SEARCHING`: `room-authorizer.ts` admits the order's customer at every
non-terminal status. The frame is a hint and the read is the truth
(ADR-0032), so the client also reads on mount and once after a reconnect,
because a missed frame is not replayed.

The read answers only while the order is `SEARCHING`. Any other status answers
`409 ORDER_NOT_SEARCHING`, which the app treats as "the order has moved on"
rather than as an error; a non-owner gets `404`, as every other customer order
read does.

### 6. When it disappears

On every status other than `SEARCHING`. An accept swaps it for the tracking
card. `NO_MASTER_FOUND` and every other terminal status show the status card
alone. The radar's cache entry has `keepUnusedDataFor: 0`, so leaving the
screen drops the cells, as the tracking card's position is dropped.

## Decision — the arrival promise (after accept)

### 7. The source is Google Routes `computeRoutes`, one call per accept

The server calls `POST https://routes.googleapis.com/directions/v2:computeRoutes`
once per accept, with `travelMode: DRIVE`, `routingPreference: TRAFFIC_AWARE`,
no `departureTime` (it defaults to the time of the request) and the field mask
`routes.duration,routes.distanceMeters`. The mask is mandatory, since the API
returns an error without one and has no default field list, and the narrowest
mask keeps the request in the lowest SKU its other features allow. `duration`
is a string such as `"742s"`; with a traffic-aware preference it accounts for
traffic, where `staticDuration` does not.
([computeRoutes reference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes),
[choosing fields](https://developers.google.com/maps/documentation/routes/choose_fields),
[routing preference](https://developers.google.com/maps/documentation/routes/reference/rest/v2/RoutingPreference),
all read on 20 October 2026.)

**`TRAFFIC_AWARE`, and what it costs.** `TRAFFIC_UNAWARE` routes on "average
time-independent traffic conditions"; `TRAFFIC_AWARE` takes live traffic into
account. A Baku rush hour is exactly the case where the two diverge, and a
promise computed without traffic would mark masters late for traffic the
platform knew about and ignored. That is the error § 10 refuses for the
fallback, so the primary source should not make it either.

The price is the SKU. Setting `routingPreference` to `TRAFFIC_AWARE` or
`TRAFFIC_AWARE_OPTIMAL` moves a request from **Compute Routes Essentials** to
**Compute Routes Pro**; tolls, two-wheeler routing and traffic on polylines would
move it to Enterprise, and this request asks for none of them. On Google's
global price list (last updated 16 October 2026):

| SKU                       | Free each month | Then, per 1 000 (up to 100 000) |
| ------------------------- | --------------- | ------------------------------- |
| Compute Routes Essentials | 10 000          | USD 5.00                        |
| Compute Routes Pro        | 5 000           | USD 10.00                       |

([SKU details](https://developers.google.com/maps/billing-and-pricing/sku-details#compute-routes-pro-sku),
[pricing](https://developers.google.com/maps/billing-and-pricing/pricing).)
At 10 000 accepts a month that is about USD 50 for Pro against nothing for
Essentials; at 3 000 accepts it is nothing either way. The free allowance is
per SKU and per billing account, and resets monthly. One promise per accept,
plus one per accept after a re-dispatch, is the whole budget, so the cost grows
with completed business, never with browsing.

`TRAFFIC_AWARE_OPTIMAL` was rejected: same Pro SKU, "highest latency" by
Google's own description, against a 3 s timeout, for an accuracy gain Google
does not quantify.

**Coverage.** Google's coverage table marks Azerbaijan "good data quality and
availability" for both _Driving Directions_ and _Traffic Layer_
([coverage](https://developers.google.com/maps/coverage)). No Google page states
traffic-aware Routes coverage for Baku in particular. The traffic layer is the
closest evidence, and the fallback (§ 10) is what happens if it turns out
thinner than the table suggests.

**What we may keep from the answer is set by the licence.** The Maps terms
forbid caching Google Maps Content except where the Service Specific Terms
allow it (§ 3.2.3(b)). For the Routes API those terms allow latitude and
longitude for up to 30 days, and place ids
([Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
§ 19.3 and § A.3; [Routes policies](https://developers.google.com/maps/documentation/routes/policies)).
**Durations and distances are not on that list.** So:

- The route's duration and distance are used in the job that receives them and
  then discarded. **They are not stored**: no route-seconds or route-metres
  column, no log line carrying them, and no reuse for another order.
- What is stored is the platform's own commitment, `promised_arrival_at`, and
  whether it came from a route or from the estimate. That is a business record
  of what was promised to two people, not a copy of a route kept to avoid asking
  again. The terms do not address a derived timestamp either way; this is the
  reading this ADR takes, and it is listed under _What this does not decide_ for
  the owner, and counsel if they want one.
- Routes content shown beside a map must be on a Google map (§ 19.2). Both
  surfaces are Google maps on both platforms (ADR-0004). The development-only
  Apple Maps fallback on an iOS build without a key (ADR-0035) is not a
  release configuration.
- The terms forbid converting text driving times into synthesized speech
  (§ 3.2.3(c)(vi)). The countdown is not a live region and no announcement
  carries a time: the one announcement is the change to the late state.

A route whose `distanceMeters` is shorter than the straight line between the
two points is treated as no route, and the estimate is used. That is the one
use the distance has, in memory, before it is discarded.

### 8. Origin, destination and the formula

- **Origin:** the accepting master's latest `master_locations` point, if it is
  younger than `DISPATCH_MAX_POSITION_AGE_SECONDS`. It almost always is, since
  eligibility for the offer required it.
- **Destination:** the order address's dispatch origin
  (`AddressesService.getDispatchOrigin`), the same point dispatch measured
  from.
- **Formula:**

  ```
  promised_arrival_at = accepted_at + travel_seconds + ARRIVAL_PROMISE_BUFFER_SECONDS
  ```

  `ARRIVAL_PROMISE_BUFFER_SECONDS` defaults to **30**, the owner's number, and
  is configurable (0–600).

**Counted from `accepted_at`, not from when the computation finished.** The
promise is computed in a BullMQ job after the accept commits, because a network
call inside the accept transaction would slow the race that decides who wins
(`OrderOffersRepository.claim`). If that job runs twenty seconds late, a
promise counted from "now" would hand the master twenty seconds nobody decided
to give them, and would make the promise depend on queue health.

The job writes through a conditional `UPDATE` keyed on the order, the master,
`accepted_at` and `promised_arrival_at IS NULL`, so a replayed job, a job that
runs after a re-dispatch, and a job racing the backstop sweep each write at
most one promise, for the right master (#396).

### 9. Fixed once, editable by nobody

The promise is computed at accept and never again. It is not recomputed as the
master drives, and nobody can edit it, an admin included.

- **A promise that moves is not a promise.** If heavy traffic pushed the time
  back every few minutes, the master would never be late and the number would
  mean nothing.
- **Live recomputation multiplies the cost by the trip.** Re-calling Routes on
  every 15 s position fan-out would turn one request per order into dozens.
- **An admin edit would make the record unauditable.** What the admin can do is
  read the promise, the actual arrival and the difference (§ 11).

### 10. When routing fails, a generous estimate, and the accept never fails

When Routes throws, times out (`ROUTES_TIMEOUT_MS`, default 3 000), returns no
route, or the master has no fresh point, the promise comes from:

```
travel_seconds = straight_line_m × 1.4 ÷ (20 km/h)
```

with `source = 'estimate'`. The straight line is PostGIS `ST_Distance` on
`geography` from the master's point, or the accepted offer's stored
`distance_m` when there is no fresh point. Both constants live in one pure
function (`estimateDrivingSeconds`) that the stub routing provider also uses, so
tests know its exact output. At these values 3 km becomes about 12.6 minutes
and 10 km about 42 minutes.

**Why being generous is the right error.** An estimate that is too long makes
the master look early, which costs nobody anything. An estimate that is too
short marks a master late because our routing call failed, which charges the
platform's failure to the master and, once lateness has consequences, could
cost them. So both constants lean slow:

- **1.4** is a deliberately high detour factor. Baku's bays, rail lines and
  one-way grid make roads longer than the straight line, and the lower end of
  the usual urban range would understate that.
- **20 km/h** is a deliberately low average for a car in the city, chosen
  below free-flow speeds because the estimate is used precisely when we have no
  traffic data.

Neither is measured. Both are hypotheses, and the data to replace them is our
own rather than Google's: every order records when the master accepted, when
they arrived (`order_status_history`) and how far away they were at the offer
(`order_offers.distance_m`). A few hundred real arrivals give the actual time it
takes a master to cover a given straight-line distance in Baku, which is the
quantity the estimate is trying to predict. Route durations cannot serve,
because they are not stored (§ 7).

**An accept never fails because routing failed.** The master won the job the
moment the claim committed. A queue error after the commit is logged and
swallowed (as `dispatch.ended()` is), and a recurring sweep re-schedules the
job for any accepted order that has had no promise for more than 60 s (#396).

### 11. Re-dispatch, and lateness recorded but not punished

**A re-dispatch clears the promise** in the same `UPDATE` that clears
`master_id` and `accepted_at`. The next master to accept gets a new promise,
computed from their own position and counted from their own `accepted_at`.

**Lateness is derived, not stored.** It is the first `MASTER_ARRIVED` row in
`order_status_history` at or after the current `accepted_at`, minus
`promised_arrival_at`, and may be negative (early). It is shown to the admin on
the order detail page (promised time, actual arrival, difference) and live to
both parties as "late by N min" (§ 12).

**What happens to a master who is late repeatedly is not decided here.**
Rating weight, suspension or subscription consequences belong to the open
"Cancellation rules and penalties" decision in CLAUDE.md § 1. Until it is made,
lateness is information.

### 12. What each party sees

| Party    | Counting                                                                       | Late                                       |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| Customer | On the tracking card, above the map: the promised clock time and the countdown | "Late by N min", in the ordinary text tone |
| Master   | On `JobDetail`, a prominent row: "be there by" the clock time, and time left   | "You are N min late", in the `danger` tone |

- Shown in `ACCEPTED` and `MASTER_ON_THE_WAY`, exactly when the tracking card
  is. On the customer's card the time shows **even when the map is in its
  `absent` state**, because the promise does not depend on a position having
  arrived. Both rows are hidden from `MASTER_ARRIVED` onwards.
- **The master's late state is `danger`, the customer's is not.** The promise
  is addressed to the master; they are the one asked to act. The customer is
  informed, not alarmed, and the closed palette has no `warning` token to put
  between the two (ADR-0011, ADR-0048), so none is invented.
- Before the promise arrives (the few seconds between accept and the job), both
  show a pending sentence ("calculating arrival time").
- **`source = 'estimate'` changes nothing on either screen.** It is an audit
  fact for the admin. Showing it would only invite argument about which number
  counts.
- **Rounding.** While counting, minutes left are rounded up (`ceil`), and under
  one minute a "less than a minute" sentence replaces the number. Late minutes
  are also rounded up, so the first late second reads "late by 1 min". A
  countdown that showed "0 min" while not yet late would contradict itself.
- **Accessibility.** The countdown is not a live region, since it would speak
  every second. The change to the late state is announced once, and the
  announcement names the state, not a number of minutes (§ 7).

### 13. Two clocks: the countdown never trusts the phone's wall clock

The promise is a server timestamp and the countdown runs on a phone whose clock
may be minutes off. ADR-0035 § 4 refused to trust the phone's wall clock for
freshness, and the countdown follows the same rule.

- **Every HTTP read returns `secondsRemaining`**, computed by the server at
  response time (negative once late), beside `promisedAt`.
- **A socket frame carries `promisedAt` and `at`**, both from server clocks, so
  the remaining time is `promisedAt − at`.
- The client anchors that number to its **monotonic** clock on receipt
  (`deadline = monotonicNow() + secondsRemaining × 1000`) and counts down from
  the anchor. It re-anchors on every newer read or frame, under the subject's
  ordering guard.
- The phone's wall clock is used for one thing only: formatting the clock time
  ("14:32") in the phone's own time zone.

The error left over is the network delay of the read that set the anchor,
which is seconds, not the minutes of skew a mid-range phone can carry.
`performance.now()` can pause while the JS thread is suspended in the
background on some platforms; returning to the foreground re-reads the order,
which re-anchors (#399 verifies this on Android).

## Interim, owner-owned

Shipped so the feature works, each awaiting the owner's acceptance or
replacement. None of them is final because it shipped.

- **Radar motion** — the pulse's duration, easing, number of rings and stagger.
  Functional, not the owner's motion language, which is still unspecified.
- **Radar colours** — the pulse and ring in `accent` at reduced opacity, the
  coarse points in `surface-alt` with a `text-muted` ring, the address marker
  identical to the tracking card's destination marker. Existing tokens only.
- **The radar's proportion** — square, full card width, as the tracking map.
- **The countdown's typography** — from the existing type scale; which step, and
  whether the clock time or the minutes lead, is the owner's.
- **The countdown row's placement** on the tracking card (above the map) and on
  `JobDetail` (a prominent row under the status).
- **Every string** — the radar's heading, count sentence, error and
  reconnecting sentences; the countdown, "less than a minute", pending and late
  sentences for both parties. All in the features' `*-copy.ts` files, marked
  placeholder.
- **The cell size and the cap** are engineering decisions, but the owner may
  ask for a coarser grid (§ 3 names 1 km as the fallback).

## What this does not decide

- **Choosing a master.** Parallel broadcast with first accept wins (ADR-0009)
  is unchanged, as the owner reconfirmed.
- **Consequences of lateness.** The open "Cancellation rules and penalties"
  decision.
- **How masters are told** that a coarse cell of their position is shown to
  customers during a search. That is privacy-notice and terms wording, which is
  the owner's and possibly counsel's, and it should exist before launch.
- **Whether storing `promised_arrival_at` is within Google's terms.** § 7 takes
  the reading that a promise is the platform's own record, not cached Maps
  content. The terms are silent on derived values; the owner or counsel may
  want to confirm it.
- **Turn-by-turn navigation for the master.** `JobDetail` already hands off to
  Google Maps.
- **The map style JSON and marker art**, still owner art (ADR-0011).

## Alternatives considered

| Option                                            | Why not                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Draw every available master near the address      | A live supply map of the city for anyone who creates an order; and not what the customer asked, which is who has been reached |
| Draw masters' real positions while searching      | Gives a non-party a master's precise location; CLAUDE.md § 11                                                                 |
| A grid centred on the customer's address          | Moves with the address, so orders from shifted addresses intersect cells down towards the master's real position              |
| Random jitter instead of a snap                   | Averages out over repeated observations                                                                                       |
| Show only a count, no map                         | Loses the picture the owner asked for; the ring and points are what make a search feel alive                                  |
| Poll the search progress every few seconds        | CLAUDE.md § 12; the server already knows exactly when something changes, once per wave                                        |
| Put cells in the realtime frame                   | Two places applying the coarsening rule, and a second copy of a position derivative pushed to every socket in the room        |
| Store the route's duration and distance for audit | Not among what the Maps terms allow to be cached (§ 7); calibration uses our own arrival times instead                        |
| The master types their own ETA                    | Ruled out by the owner                                                                                                        |
| Recompute the ETA live as the master drives       | A promise that moves is not one; multiplies the Routes cost by the trip length                                                |
| Compute the route inside the accept transaction   | A network call inside the race that decides who wins                                                                          |
| Count the promise from when the job ran           | A slow queue hands the master extra time nobody decided to give                                                               |
| Fail or delay the accept when routing fails       | The master won the job at the commit; our dependency's failure must not take it back                                          |
| Count down against the phone's wall clock         | A phone minutes off shows a master late, or early, who is neither                                                             |
| Keep a per-assignment promise history table       | Needed only once lateness has consequences; deferred to that decision (see _Trade-offs_)                                      |

## Trade-offs accepted

- **A re-dispatched master's punctuality is not kept.** The promise lives on
  the order and is cleared when the order goes back out, so a master who was
  late and then lost the job leaves no promise behind; their accept and arrival
  are still in `order_status_history`. When lateness gets consequences, a
  per-assignment record will be needed, and that decision is the place to add
  it.
- **The promise ignores what happens after accept.** A master who accepts and
  then spends five minutes finishing a coffee is late by five minutes, which is
  the point. A master who hits an accident nobody could foresee is also late,
  and the 30 s buffer does not absorb that. Lateness is information until the
  penalties decision says otherwise.
- **The fallback constants are guesses**, chosen to err in the master's favour,
  and replaced from production arrivals (§ 10).
- **Not storing the route makes the promise harder to explain.** An admin sees
  the promised time and its source, not the road time and the buffer
  separately. The buffer is configuration, so the road time can be derived for
  one order on demand; it is not kept as a column (§ 7).
- **The promise costs Pro-SKU money once free usage is exhausted** (§ 7), for
  traffic accuracy that has not yet been measured in Baku.
- **A coarse cell is still a derivative of a master's position shown to a
  non-party.** § 3 bounds what it reveals; it does not make it nothing. If the
  owner or counsel wants less, 1 km is the next step.
- **The radar's frame rate on a mid-range Android is not measured here.** The
  design is chosen to be cheap (one memoised `MapView`, the pulse on the UI
  thread, the camera moving once per wave), and #398 counts renders in tests,
  but a profiler on real hardware is #173's.

## Consequences

- `order_offers` gains `offered_at` (#397). `orders` gains
  `promised_arrival_at` and `arrival_promise_source` (#396), and **no** column
  holding a route's duration or distance (§ 7).
- `apps/api/src/infra/geo/` gains a `RoutingProvider` beside the geocoding
  provider, with a Google Routes implementation and a deterministic stub
  (#395). `googleapis` and Google types stay inside that directory.
- Two realtime events join the table in `realtime-architecture.md`:
  `order:search-wave` and `order:arrival-promise`. Neither carries a
  coordinate.
- New configuration: `ROUTES_TIMEOUT_MS` (#395) and
  `ARRIVAL_PROMISE_BUFFER_SECONDS` (#396).
- **Owner action outside the repository:** enable the Routes API on the Google
  Cloud project behind `GOOGLE_MAPS_SERVER_API_KEY` and add it to the key's API
  restrictions, before `MAPS_PROVIDER=google` is deployed with this Epic.
  Until then every promise comes from the estimate, and the accept still
  works.

## Revisit when

- The penalties decision gives lateness consequences (a per-assignment promise
  record, and possibly a review of the 30 s buffer).
- A few hundred real arrivals exist to calibrate the fallback's 1.4 and
  20 km/h.
- Google's terms start, or stop, allowing route durations to be stored.
- The Routes bill, or Google's pricing for the chosen request, changes enough
  to matter (§ 7).
- The owner or counsel asks for a coarser radar grid, or masters object to it.
- The owner supplies motion, colours, typography or copy for either surface.
- `DISPATCH_MAX_RADIUS_M` or the wave count changes enough that 12 points or a
  557 m cell no longer reads at the ring's scale.
