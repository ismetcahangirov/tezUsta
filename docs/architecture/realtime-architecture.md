# Realtime architecture

## What actually needs to be realtime

| Event               | Direction                  | Why it cannot be polled                |
| ------------------- | -------------------------- | -------------------------------------- |
| New order offer     | server → master            | Dispatch is a race; seconds matter     |
| Order accepted      | server → customer          | The customer is waiting on this screen |
| Order status change | server → both              | Drives the live view                   |
| Master location     | master → server → customer | Continuous while travelling            |
| Master availability | master → server            | Feeds matching                         |

Everything else — order history, catalogue, profile — is ordinary HTTP through
RTK Query. **Do not put on the socket what a cached request can answer.**

## Transport

**WebSocket, with a Redis adapter.**

**The library is settled** (issue #166,
[ADR-0032](../decisions/ADR-0032-realtime-transport.md)): socket.io through
`@nestjs/websockets` + `@nestjs/platform-socket.io`, attached to the API's
**existing Fastify port** rather than a second one, fanned out with
`@socket.io/redis-streams-adapter` over the same Redis everything else uses.

Streams rather than plain pub/sub, and not for the reason the adapter's own
documentation leads with. Client-side gaps are already handled here — the
socket is not the source of truth and a reconnecting client refetches over
HTTP. The gap that decided it is the **server-side** one: with pub/sub, a Redis
blip silently discards everything published during it, and no client learns
anything, because its own socket stayed up. The screen stays wrong forever with
no signal anywhere. A stream resumed from its last offset does not have that
failure mode. The full argument, the alternatives and the accepted 0.x risk are
in the ADR.

The adapter is not optional. With more than one API instance, a customer
connected to instance A never receives an event published on instance B. The fix
is either sticky sessions (which breaks stateless scaling and makes deploys
disruptive) or a shared pub/sub bus. We use the bus from the start — retrofitting
it after the second instance is added means debugging "sometimes the app doesn't
update", which is the worst class of bug to diagnose.

```
master app ──┐                              ┌── customer app
             ▼                              ▼
      ┌────────────┐   publish    ┌────────────┐
      │ api #1     │─────────────►│ api #2     │
      └─────┬──────┘              └─────┬──────┘
            └──────► Redis pub/sub ◄────┘
```

### Rooms

| Room                | Members                              |
| ------------------- | ------------------------------------ |
| `order:{orderId}`   | The customer and the assigned master |
| `master:{masterId}` | That master's devices                |

**There is no geographic room, and no geohash.** Dispatch is settled — parallel
broadcast, first accept wins
([ADR-0009](../decisions/ADR-0009-dispatch-model.md)) — and the broadcast set is
**computed by the PostGIS eligibility query**
([`database-architecture.md`](database-architecture.md) § The nearby-masters
query), then delivered to each winner's own `master:{masterId}` room.

A `dispatch:{geohashCell}` room would be a second spatial partitioning scheme
beside PostGIS, with no owner and no defined cell size, and the two would
disagree: a master sitting near a cell boundary lands in a different room than
the radius query puts them in, so they either miss an order they were eligible
for or receive one they were not. **One spatial authority, and it is PostGIS.**

**Room membership is authorized on join, server-side.** Subscribing to
`order:{id}` requires being a party to that order. Without that check, the
socket is an unauthenticated read API for every order in the system — including
live home addresses.

### Connection lifecycle

- Authenticate **on connect**, using the same access token as HTTP. An
  unauthenticated socket is never upgraded.
- Re-authenticate on reconnect; a revoked session must not survive via a
  long-lived socket.
- Reconnect with exponential backoff and jitter. Without jitter, an API restart
  causes a synchronised reconnect stampede.
- **The socket is not the source of truth.** On reconnect the client refetches
  current state over HTTP and resumes listening. Missed events must never leave
  the UI permanently wrong.

#### How it is implemented (issue #166)

Authentication is **socket.io middleware**, not `handleConnection`. The
difference is the one the first bullet above states: middleware runs before the
socket exists, so the client receives `connect_error`, never fires `connect`,
and no `Socket` is ever created. Authenticating in `handleConnection` would
accept the socket and then close it — briefly a real, addressable connection
for a caller who proved nothing.

What that does **not** do is close the underlying transport; see
`connectTimeout` below.

The middleware runs on every connection attempt, including every reconnect,
which is what makes re-authentication automatic rather than a thing to
remember. It resolves through the same `TokenService` + `ActorService` pair the
HTTP guard uses, so a revoked session, a withdrawn role and a suspended account
behave identically on both surfaces
([`authentication.md`](authentication.md) § Role claims are a cache).

**The token comes from the handshake's `auth` payload and nowhere else.** Not
the query string: that is part of the URL and lands in proxy and access logs,
which is where CLAUDE.md §11 says a live credential may never be written. Not
an `Authorization` header either — a browser cannot set headers on a WebSocket
upgrade, so it would be a second way in that only some clients can use.

Every refusal returns the single string `unauthorized`; the specific reason
goes to the server log only, exactly as issue #27 established for HTTP.

**The token is destroyed once it has been verified.** `handshake` survives for
the socket's lifetime and the cluster adapter serialises all of it over Redis,
so leaving the token there would publish a live credential to every instance.
`socket.data` crosses the cluster for the same reason — it may hold the
resolved actor, never a credential.

**A socket is closed when its access token expires.** Re-authenticating on
reconnect only binds clients that reconnect; a phone on a home screen holds one
socket for hours with an actor resolved once and then frozen. Bounding the
socket by the credential's own `exp` keeps a stale snapshot no longer-lived
than HTTP already allows. It is a bound, not a substitute for re-reading
current state before an authorization decision.

**A refused upgrade is bounded by `connectTimeout`, not by the account cap.** A
middleware refusal rejects the namespace connection and leaves the transport
open until that timeout — 45 seconds by default, 3 here. A hostile client that
ignores `connect_error` holds a socket for that long with no account to be
counted against, so the per-account cap does not reach this path at all. A
per-IP handshake limit is EPIC 15's.

**Connections per account are capped** (`REALTIME_MAX_CONNECTIONS_PER_USER`,
default 5), and past the cap the **oldest** socket is closed rather than the
new one refused. Both bound the resource equally; only one of them lets a
master coming back from a tunnel reconnect while the server still holds sockets
it has not yet noticed are dead. The registry is per-instance in-process state
on purpose — a socket costs the instance holding it, so each bounds what it
actually pays for.

**The HTTP guards all handle a non-HTTP execution context explicitly.** They
are `APP_GUARD`s and are therefore asked about socket executions too, where
`switchToHttp().getRequest()` yields the socket. `AuthenticationGuard` admits a
socket that already carries the actor `SocketAuthenticator` resolved at the
upgrade and refuses one that does not; `RateLimitGuard` and the admin guard
skip, because neither budget nor admin surface exists here. None of them reads
a socket as though it were a request.

#### Rooms and their authorization (issue #167)

**A room name never arrives from a client.** The wire carries
`{ kind: 'order', orderId }` or `{ kind: 'master', masterId }`, validated with
Zod, and the name is built server-side from ids that have already been
authorized. A payload that is neither shape is refused without closing the
connection — a live socket may be carrying an order, and one bad frame must not
cost it.

**Every join is a database read, and nothing is cached.** `order:{id}` admits
the order's customer and the master `orders.master_id` names _right now_;
`master:{id}` admits only the account behind that profile. An admin gets no
blanket join. A terminal order is not a live room: there is nothing further to
publish and the history is read over HTTP.

**Every refusal is the same code.** `ROOM_FORBIDDEN` covers a missing order, a
finished one, somebody else's and a foreign master profile alike, so the socket
cannot be used to ask whether an order id exists — the same reasoning that
makes every authentication failure one `unauthorized`.

**Losing the right removes you.** Every committed transition reaches the
gateway through `OrderRoomsRegistry`, which re-authorizes each socket in that
order's room and drops the ones that are no longer parties — so a master who
re-dispatches stops hearing the order without reconnecting, and a cancellation
empties the room. Eviction is cluster-wide: `fetchSockets()` reaches sockets
held by other instances.

**Inbound messages are budgeted per connection**
(`REALTIME_INBOUND_MESSAGES_PER_SECOND`, `REALTIME_INBOUND_BURST`), by an
in-process token bucket rather than the Redis-backed HTTP limiter. A frame
arrives on the one instance holding the connection and consumes that instance's
event loop, so a round trip per message would bound a resource nothing shares —
the same argument the connection cap makes, and the one `rate-limit.config.ts`
already recorded for this case.

## Location update budget

**The constraint:** a master's phone reports position all day. Naive
implementations flatten the battery, and a master whose battery dies stops being
supply.

**Location updates are a budget, not a stream.**

### Proposed policy — requires field validation

| Master state         | Interval — the floor, always sent | Distance filter — extra reports above the floor |
| -------------------- | --------------------------------- | ----------------------------------------------- |
| Offline              | none                              | —                                               |
| Online, no order     | 60–120 s                          | 100 m                                           |
| Assigned, travelling | 10–15 s                           | 25 m                                            |
| Arrived / working    | 120 s or none                     | —                                               |
| Order complete       | stop                              | —                                               |

Additional rules:

- **While a master is online, the app reports at least once per interval,
  regardless of movement** ([ADR-0026](../decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)).
  The interval column is a **floor**, not a ceiling: it is sent whether or not
  the phone has moved a metre. The distance filter suppresses only the _extra_
  reports above that floor — it never suppresses the floor itself.

  This is not a detail of the app. Dispatch excludes a master whose newest
  position is older than `DISPATCH_MAX_POSITION_AGE_SECONDS`, and that bound is
  derived from this floor plus tolerance. A reporter that fires only on movement
  deletes every parked master from every broadcast, which is precisely the
  failure ADR-0026 was written for. **A movement-only reporter is not a
  compliant implementation of this budget.**

- **The distance filter decides the reports between floors.** `expo-location`'s
  `distanceInterval` does that natively, without waking the JS thread, and it is
  what keeps a phone crossing town from reporting on a fixed clock. It is a
  filter on the surplus, and the surplus only.
- **The floor should cost the cheapest fix that is still true.** For an idle
  master the last known position is enough — the expensive part of a report on a
  mid-range Android is the GNSS fix, not the request. Accuracy matters while
  travelling, where the customer is watching the marker, and that cadence is
  unchanged.
- **Batch when possible.** Several points in one request beats several requests.
- **Never send at a fixed high rate regardless of state.** Reporting every 5
  seconds while a master is idle at home is pure waste.
- **Fan out only to the room that needs it.** A location update goes to the
  customer on that order — nobody else.
- **Throttle server → customer** independently of ingest. The customer's map does
  not need 10-second precision; ~15 s with client-side interpolation looks
  smoother _and_ costs less.

**These numbers are a starting hypothesis.** The real values depend on measured
battery drain on mid-range Android hardware and on how ETA accuracy actually
feels. They must be validated in EPIC 9 and revised here with the measurements.
The procedure, including the shift, the `adb` captures, the server-side
cadence query and the results template, is
[`battery-measurement.md`](../engineering/battery-measurement.md) (#173).

### The server → customer throttle (issue #169)

`REALTIME_POSITION_FANOUT_SECONDS`, defaulted to **15**, is the value the
bullet above names, now enforced. It is **not** the same knob as ingest:
`MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR` bounds how often a master's app may
_report_, this bounds how often one order's room is _told_. #169 does not
loosen the first and adds no second limiter beside it.

Fifteen seconds rather than the reporting floor, because the two answer
different questions. A master travelling reports on a 10–15 s floor **plus** a
25 m distance filter, so a car in traffic produces a report every couple of
seconds; passing all of them on would spend the customer's battery and data on
precision a map does not have. The client interpolates between points, and
raising this number to make the marker smoother is the wrong fix.

**The throttle lives in Redis, one key per order**
(`realtime/master-position.publisher.ts`), not in process. Two API instances
holding their own timers would each publish once per window, and the throttle
would quietly become "once per window per instance" — the in-process state
CLAUDE.md §12 rules out.

**Leading edge: the report that opens a window is the one broadcast.** Holding
the newest report and flushing it when the window closes would need a scheduled
job per order per window and buys nothing — either way the room receives one
point per window, and either way that point is fresh at the instant it is sent.
What leading edge costs is the tail: the surplus report that arrives after the
last broadcast and is never superseded because reporting stopped. That cannot
strand a _moving_ master's marker, because
[ADR-0026](../decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)
makes the floor unconditional — every window of a compliant app contains a
report, so the marker advances every window for as long as the master is
online.

**Where it goes, and where it stops.** The destination is resolved per report
from `orders.master_id` as it stands, restricted to the four statuses in which
an order has a master and is still live. A master with no such order broadcasts
nothing — their reports still land in `master_locations` and still feed
dispatch. A terminal status and a re-dispatch both leave that set, so the next
report resolves to nothing; and the room has already been emptied on the
transition itself (issue #167), so even a report racing the transition reaches
an empty room. The re-dispatch case is the one the eviction does _not_ cover —
the order stays live and the customer stays in the room — and there the lookup
is the only thing between the ex-master's position and the customer.

### The budget is enforced, not advised (issue #98)

`POST /masters/me/location` carries the `location-report` rate-limit policy,
`MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR`, defaulted to 600 an hour — above
the fastest interval in the table (one report every 10–15 s is 240–360 an hour)
with room for retries, and far below a client reporting continuously. Until
that limit existed, "the server is the authority on the interval" was a
sentence an app could ignore with one bad `setInterval`, and every ignored
report wrote another row of somebody's movements into `master_locations`. The
per-IP half of the policy is deliberately loose: masters are on mobile
networks, where a carrier NAT hides an unknown number of them behind one
address.

**A position report is also the heartbeat.** The same call refreshes the Redis
presence key, so a reporting app does not beat separately — which is what the
alignment between the two intervals below was always for.

### Background location

Required while an order is in progress — a master will lock their phone while
driving.

- Request background permission **only** when an order is accepted, with a plain
  explanation. Requesting it at onboarding gets denied.
- Stop background updates the moment the order ends. Continuing afterwards is a
  privacy violation and an app-store review failure.
- Handle denial gracefully: the order still works, tracking degrades.
- Android battery optimisation will kill the reporter. Detect staleness and tell
  the master, rather than silently showing them as active.

**How the app does it** (issue #171, [ADR-0036](../decisions/ADR-0036-master-work-surface.md)):

- **One reporter, one mode.** `MasterWorkProvider`, mounted at the master's
  layout, derives the reporter's state from the server's availability and the
  job `GET /masters/me/jobs/current` returns. It asks for background mode only
  while that job is engaged **and** the master has granted "Always". The
  background session is the same subscription delivered through
  `expo-task-manager`'s task (`src/location/background-task.ts`). Removing
  the subscription ends the session, so there is no second "stop" call to
  forget. Completion, a customer cancellation and a re-dispatch all arrive
  as the job read answering `null`, and all three stop it.
- **The stop works with the socket closed.** The socket closes when the app is
  backgrounded, which is exactly when a master is driving, so a cancellation
  is seldom delivered as a frame. Every location report's answer therefore
  carries `engagedOrderId`, the order the server still has the master on. An
  app whose job has gone re-reads it and ends the session within one report.
  Resuming the socket also re-reads the job and the offer feed.
- **One mode change at a time.** The reporter serialises mode changes and waits
  for the platform to stop the old subscription before starting the next. Two
  interleaved starts would each leave a subscription and a floor timer that
  nothing could stop. A background session that delivers to nobody, restored
  by the OS from an earlier run, ends itself on its first delivery.
- **Asked once per order, at accept.** Background access is requested when a
  job first appears, after foreground access is already held, and never when
  going online. A refusal leaves the job on foreground updates and shows the
  master what that costs.
- **Android** runs the session as a foreground service with an ongoing
  notification (`killServiceOnDestroy`, so swiping the app away ends it). The
  JS thread stays alive, so the reporter's floor timer keeps firing. **iOS**
  suspends a backgrounded app's timers, so only movement past the distance
  filter wakes it. For a master driving to a job that is the stretch that
  matters, but a stationary, backgrounded iOS master does not meet the floor.
  #173's measurement should say whether that matters in practice.
- **Batching.** A deferred batch from the platform is collapsed on the device
  to its newest point and sent as one report. The server contract stays one
  point per request (#98). The older points would only have been written to a
  trail nothing reads and superseded in the same request. **No accuracy field
  is added** for the same reason: nothing on the server or the customer's
  screen would read it.
- **Relaunch with nobody listening.** If the OS relaunches the app just to
  deliver a location, no master screen is mounted. The point is dropped, not
  sent by the task on its own. Only the reporter sends, so the rate-limit
  backoff and the staleness check see every report.

## Presence

Master availability lives in **Redis with a TTL**, refreshed by a heartbeat.

A TTL is what makes a crashed app self-correcting: if the process dies, presence
expires and the master stops receiving offers. A boolean column in Postgres has
no such property — it would leave phantom masters online forever, and dispatch
would keep offering work to a phone that is switched off.

**The numbers, and where they come from.** This document described the
mechanism and supplied no seconds, so issue #40 chose them and wrote down why
rather than leaving a constant nobody can argue with:

| Value                        | Default | Why                                                                                                                                                                                                                                                            |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRESENCE_HEARTBEAT_SECONDS` | 60      | Aligned with the 60–120 s location-reporting interval for an online master with no order, so the beat rides alongside a report the app was already going to make instead of adding a wake-up to somebody's battery.                                            |
| `PRESENCE_TTL_SECONDS`       | 180     | Three heartbeats, so two can be lost to a tunnel, a GC pause or a bad minute of signal before a working master is dropped. Shorter and a master flickers offline on a normal Baku commute; much longer and the TTL stops making a crashed app self-correcting. |

`env.schema.ts` refuses a TTL under twice the heartbeat. Both values pass their
own range checks independently, so only the comparison catches the
configuration where presence expires before the next beat arrives — every
master flickering offline between heartbeats, dispatch finding nobody, and
nothing in the logs saying why.

**The key is namespaced** (issue #125): `<REDIS_KEY_PREFIX>:presence:master:<id>`,
built in one place (`infra/presence/master-presence.service.ts`). Redis is
shared — two checkouts, or a CI job and a developer's `pnpm test`, point at
one container — and a keyspace whose name is a constant lets one run read,
overwrite and delete another's. It is a separate variable from `QUEUE_PREFIX`
rather than the same one: that one names keys BullMQ owns, and renaming it
strands delayed jobs, whereas everything under this one is a cache of
something authoritative elsewhere. Presence in particular is back within one
heartbeat, so the cost of changing it is one cold interval. The catalogue
cache (`<REDIS_KEY_PREFIX>:catalogue:v1:…`) is under the same namespace, and
every key in it carries a TTL, so an abandoned namespace empties itself rather
than needing a sweep.

**The heartbeat is HTTP today**, not a socket ping:
`POST /masters/me/availability/heartbeat` — or, for a master who is reporting
position, `POST /masters/me/location`, which refreshes the same key (issue #98),
so the beat costs nothing extra once location reporting has started. There is no
gateway yet (EPIC 9), and this document is explicit that the socket is for the
five events that need pushing rather than for everything that repeats. When the
gateway lands a ping can refresh the same key; the endpoint stays as the path
that works when the socket does not.

**A heartbeat re-checks eligibility, not just liveness.** An admin who suspends
a master mid-shift gets them off the platform within one beat: the presence key
is dropped, the stored intent is set back to offline so a restart cannot show
them as working, and the 409 tells the app to stop. Dispatch would have
excluded them anyway — `assertCanAcceptWork` re-reads the database — but
waiting for dispatch to notice would leave a suspended master watching a screen
that says they are taking orders.

Postgres holds the master's _intent_ (they toggled online); Redis holds the
_liveness_. **Matching requires both**, evaluated together before an offer is
sent rather than as two independent checks whose results could diverge — the
canonical form is in
[`database-architecture.md`](database-architecture.md) § The nearby-masters
query, which also carries the verification, service, radius and
commission-debt terms. Any dispatch path that reads `masters.is_available`
without intersecting the live set is offering work to a switched-off phone.

**`PRESENCE_TTL_SECONDS` is not a bound on position age, and must never be
reused as one.** A position report refreshes presence, but a heartbeat does
_not_ write a position — so presence can be minutes fresher than the newest
`master_locations` row for the same master, which is the normal state of a
parked master beating on `POST /masters/me/availability/heartbeat`. The two
windows answer different questions: presence is "can we reach this app",
position age is "is this position still true". Dispatch bounds the second with
`DISPATCH_MAX_POSITION_AGE_SECONDS`, derived from the reporting floor above
([ADR-0026](../decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)).

## Event payloads

- Events carry **ids and the changed fields**, not whole object graphs. The
  client applies them to the RTK Query cache — `api.util.invalidateTags` to make
  the affected queries refetch, or `api.util.updateQueryData` to patch a cached
  result in place where the payload is enough to do so. Either way there is one
  cache, not a second store fed by the socket
  ([ADR-0017](../decisions/ADR-0017-state-management.md)).
- Every event carries a **monotonic sequence or timestamp** so a client can
  discard an out-of-order delivery. Under reconnection, out-of-order arrival is
  normal.
- Events are **not** a durable log. A client that was offline refetches state; it
  does not replay.

### What the server publishes (issue #168)

These events exist, and their contract lives in `packages/types` because it
crosses the WS boundary and both apps read it
(`packages/types/src/realtime-event.ts`). It is **types only** — the package
ships TypeScript source with no build step, so each side writes the event name
itself and lets the shared union refuse a typo.

| Event                   | Room                | Payload                                                     |
| ----------------------- | ------------------- | ----------------------------------------------------------- |
| `order:offer`           | `master:{masterId}` | `orderId`, `at`                                             |
| `order:transition`      | `order:{orderId}`   | `orderId`, `status`, `masterId`, `priceMinor`, `at`         |
| `order:master-position` | `order:{orderId}`   | `orderId`, `latitude`, `longitude`, `at` (issue #169)       |
| `message:new`           | `order:{orderId}`   | `orderId`, `message`, `at` (issue #179)                     |
| `message:read`          | `order:{orderId}`   | `orderId`, `readerKind`, `throughMessageId`, `readAt`, `at` |
| `conversation:typing`   | `order:{orderId}`   | `orderId`, `at` — relayed, never stored                     |

An offer goes to the master's **own** room and never to the order's: a master
who has been offered a job is not yet a party to it and may not join
`order:{orderId}` (issue #167).

`at` is epoch milliseconds. For an order event it is the publishing instance's
clock, taken immediately after the transaction committed; for a position it is
the database's `master_locations.recorded_at`, which is what the marker's age
is measured from. The client discards an event
strictly older than the last one it applied for the same subject and keeps a
tie. It is not a per-order sequence, and the honest limits are written down in
`realtime-event.ts`: two events can share a millisecond, and ordering across
instances is only as good as their clock skew — which is sound because one
order's transitions are separated by human-scale gaps rather than racing, and
because a client that needs certainty refetches over HTTP.

**The publisher is a second subscriber to the same seam the push notifications
use.** `OrderNotificationsRegistry` admits more than one consumer and isolates
their failures from each other, so `modules/orders` gains no import of
`modules/realtime` and a socket that is down cannot cost a push its delivery,
or either of them cost the transition anything.

**The actor of a transition is subtracted from the broadcast**, matching the
rule already applied to notifications. Both parties sit in one room, so this is
`except(user:{actorUserId})` rather than a choice of recipients — every socket
joins its own personal room on connect, from its authenticated actor and never
from the wire.

**A transition is published before the room is revalidated**, and the order
matters: a terminal order has no parties, so evicting first would empty the
room a cancellation is about to be published into and the master whose job was
cancelled would be the one person never told. The transition is therefore the
last thing a departing party hears (`orders.service.ts`).

### Messages, read receipts and typing (issue #179)

An order's conversation ([ADR-0033](../decisions/ADR-0033-in-order-messaging.md))
adds no transport and no room. `order:{orderId}` already holds exactly the two
parties, decided from the database on join and re-decided on every transition,
so it is the conversation's audience too.

- **`message:new` and `message:read` are raised after the HTTP write
  returns**, through `ConversationEventsRegistry` in `modules/orders` — the
  same one-way seam order events use, with failures swallowed because the
  message is written either way. A send that fails in the database raises
  nothing.
- **`message:new` carries the message itself**, presented as the recipient
  sees it, so it appears without a refetch. That is safe only because the room
  is party-only: nothing on the frame is more than `GET /orders/:id/messages`
  returns to the same person.
- **The writer and the reader are subtracted** with `except(user:{userId})`,
  as the actor of a transition is. The sender reconciles against the `POST`
  response; a frame racing it would turn one message into two bubbles.
- **`conversation:typing` is the one inbound frame besides a room request.**
  ADR-0033 calls it `typing`; it is namespaced like every other event name.
  Validated with Zod, spent against the per-connection `InboundBudget`,
  accepted only from a socket already in the order's room — membership _is_
  the authorization, so a keystroke costs no query — and relayed at most once
  per two seconds per socket and order (`typing-relay.ts`). It is never
  persisted, and has no "stopped" twin: the client lets its indicator lapse.

### A message nobody read raises a push (issue #180)

ADR-0033 § 5 says an undelivered message raises a push. **Whether it was
delivered is answered by the database, not by the socket.** "Does the recipient
have a live socket?" is a cluster-wide question (the connection registry is
per-instance) that races delivery both ways — a socket present when asked can
be gone before the frame lands. What matters is whether the recipient _saw_ it,
and the conversation screen reports that with a read receipt.

So each committed message schedules a deferred `message-push` job
`MESSAGE_PUSH_DELAY_SECONDS` (default 10) later, with a job id bucketed per
recipient, conversation and window — a burst coalesces into one job. When it
runs it pushes `message-received` only if the recipient still has something
unread. The push names the sender and the service and **never carries the
body**; it goes through the ordinary notification worker, on its own
`messages` Android channel. The cost is stated in
`message-notifications.service.ts`: a recipient with the app open on another
screen can get the frame _and_ a push — a duplicate rather than a silent drop.

### Call signalling (issue #185)

In-app voice ([ADR-0034](../decisions/ADR-0034-in-app-voice-calls.md)) rings
over this gateway; the media itself goes to LiveKit. The state machine lives in
`modules/calls`, persisted in `calls`, with the legal edges in one table
(`call-lifecycle.ts`): `RINGING → ACCEPTED | REJECTED | CANCELLED | TIMED_OUT |
ENDED`, `ACCEPTED → ENDED`, and `BUSY` inserted terminal. Every write is a
conditional `UPDATE … WHERE status = <expected>`, so a hangup, the ring timeout
and #186's webhook racing one row change it exactly once.

- **Five inbound frames** — `call:invite`, `call:accept`, `call:reject`,
  `call:cancel`, `call:hangup` — each Zod-validated, spent against
  `InboundBudget`, and answered with an ack carrying a stable code
  (`CALL_INVALID`, `CALL_FORBIDDEN`, `CALL_STALE`, `CALL_RATE_LIMITED`,
  `CALL_UNAVAILABLE`, `RATE_LIMITED`). Unlike a typing frame, **a call frame
  re-reads the actor** (`ActorService.current`) before anything else: it rings
  a phone or mints a credential, so the handshake's frozen actor is not enough.
- **An invite names the order and nothing else.** The callee is derived from
  the order; the room is `call-<callId>`. A call is possible exactly when the
  order's conversation is open and writable — `ConversationsService.requireParty`
  plus `isWritable`, the same rule, so chat and calling open and close together.
- **Outbound frames go to `user:{userId}`, not `order:{orderId}`** — the callee
  need not have joined the order's room to be rung, and every device an account
  holds must hear an answer so its other phones stop ringing. `call:incoming`
  goes to the callee, `call:busy` to the caller, the rest to both, each
  presented as the recipient's own call. They leave through
  `CallEventsRegistry`, a slot this module fills, so `modules/calls` never
  imports `modules/realtime`.
- **Busy is decided under two advisory locks**, one per account, taken in
  sorted order, before the live-call check and the insert — so simultaneous
  invites (A→B twice, A→B with B→A, two masters ringing one customer) leave
  one live call and a `BUSY` row. `calls_one_live_per_order` is the second line.
- **A token is minted on accept only** (ADR-0034 § 3): the callee's in the ack
  of its own `call:accept`, the caller's — or a reconnecting party's — from
  `POST /calls/:callId/join`, which answers only a party to an `ACCEPTED` call
  on a live order. No frame, push or log line carries one.
- **The ring timeout is a delayed job** (`call-ring-timeout`,
  `CALL_RING_TIMEOUT_SECONDS`, default 30) doing a conditional
  `RINGING → TIMED_OUT`; it needs nobody's socket, so a caller whose app was
  killed still leaves a finished call. It is not cancelled on answer — the
  conditional update makes a late run a no-op.
- **An order that stops being writable ends its call** (`order_closed`),
  ringing or answered, through `OrderNotificationsRegistry` — the seam every
  transition already raises after its commit. Room deletion on hangup and on
  close is best effort; #186's reaper is what guarantees it.
- **Invites are rate-limited per account per order**
  (`CALL_INVITE_RATE_LIMIT_PER_ORDER` per `CALL_INVITE_RATE_LIMIT_WINDOW_SECONDS`,
  default 6 per 10 minutes) on the shared Redis limiter — a refused, busy
  invite counts too.

## Security

- Authenticate on connect and on reconnect.
- **Authorize every room join.**
- Rate-limit inbound messages per connection. A client can otherwise flood
  location updates and consume server resources.
- Validate inbound payloads with Zod, exactly as with HTTP. A socket message is
  untrusted input.
- Never broadcast a master's location beyond the active order's customer —
  enforced by resolving the destination from `orders.master_id` per report
  (issue #169), not from anything the reporting client sent.
- Cap connections per user to bound resource use from a malicious client.
