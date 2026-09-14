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
TanStack Query. **Do not put on the socket what a cached request can answer.**

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

| Room                     | Members                                             |
| ------------------------ | --------------------------------------------------- |
| `order:{orderId}`        | The customer and the assigned master                |
| `master:{masterId}`      | That master's devices                               |
| `dispatch:{geohashCell}` | Online masters in an area (dispatch model **OPEN**) |

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

Postgres holds the master's _intent_ (they toggled online); Redis holds the
_liveness_. Matching requires both.

## Event payloads

- Events carry **ids and the changed fields**, not whole object graphs. The
  client refetches detail through TanStack Query, which keeps one cache rather
  than two sources of truth.
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
