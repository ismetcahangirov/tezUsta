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

**Both HTTP guards now refuse a non-HTTP execution context.** They are
`APP_GUARD`s and are therefore asked about socket executions too, where
`switchToHttp().getRequest()` yields the socket. Nothing legitimate reaches
that branch today — this gateway has no message handler — and it exists so the
first one added fails loudly instead of being waved through.

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

## Security

- Authenticate on connect and on reconnect.
- **Authorize every room join.**
- Rate-limit inbound messages per connection. A client can otherwise flood
  location updates and consume server resources.
- Validate inbound payloads with Zod, exactly as with HTTP. A socket message is
  untrusted input.
- Never broadcast a master's location beyond the active order's customer.
- Cap connections per user to bound resource use from a malicious client.
