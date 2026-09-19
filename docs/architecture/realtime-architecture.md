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

**WebSocket, with a Redis pub/sub adapter.**

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

## Location update budget

**The constraint:** a master's phone reports position all day. Naive
implementations flatten the battery, and a master whose battery dies stops being
supply.

**Location updates are a budget, not a stream.**

### Proposed policy — requires field validation

| Master state         | Interval      | Distance filter |
| -------------------- | ------------- | --------------- |
| Offline              | none          | —               |
| Online, no order     | 60–120 s      | 100 m           |
| Assigned, travelling | 10–15 s       | 25 m            |
| Arrived / working    | 120 s or none | —               |
| Order complete       | stop          | —               |

Additional rules:

- **Distance filter first.** A stationary phone sends nothing. `expo-location`'s
  `distanceInterval` does this natively, without waking the JS thread.
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

**The heartbeat is HTTP today**, not a socket ping:
`POST /masters/me/availability/heartbeat` — or, for a master who is reporting
position, `POST /masters/me/location`, which refreshes the same key (issue #98),
so the beat costs nothing extra once location reporting has started. There is no gateway yet (EPIC 9),
and this document is explicit that the socket is for the five events that need
pushing rather than for everything that repeats. When the gateway lands a ping
can refresh the same key; the endpoint stays as the path that works when the
socket does not.

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
