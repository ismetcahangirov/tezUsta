# ADR-0032 — The realtime transport: socket.io on the API's own port, fanned out over Redis streams

- **Status:** Accepted
- **Date:** 22 September 2026
- **Context:** EPIC 9, issue #166
- **Supersedes:** nothing. Refines
  [`realtime-architecture.md`](../architecture/realtime-architecture.md) §
  Transport, which required "WebSocket, with a Redis pub/sub adapter" without
  naming a library.

## Context

[`technology-stack.md`](../architecture/technology-stack.md) § 7 pins
"WebSocket + Redis adapter" and stops there. EPIC 9 cannot proceed on that: a
library has to be chosen, a Redis adapter has to be chosen, and both choices
have consequences that are expensive to reverse once clients are in the field.

Three things were already decided and are not reopened here:

- The adapter is **not optional**. Without it a client connected to instance A
  never receives an event published on instance B, and the bug surfaces as
  "sometimes the app doesn't update".
- The socket is **not the source of truth**. On reconnect the client refetches
  state over HTTP; events are not a durable log and are never replayed.
- Authentication uses the **same access token as HTTP**, verified the same way.

## Decision

### 1. socket.io, via `@nestjs/websockets` + `@nestjs/platform-socket.io`, pinned at `12.0.1`

`12.0.1`, not `12.0.4` and not `12.0.0`:

- `12.0.0` and every `12.0.0-alpha` still declare `"@nestjs/core": "^11.0.0"` —
  a real peer conflict against our `@nestjs/core@12.0.1`. The peers were
  corrected in `12.0.1`.
- `12.0.4` is fine on peers, but would put the websocket packages a patch ahead
  of `@nestjs/core`, `@nestjs/common` and `@nestjs/platform-fastify`, all of
  which are `12.0.1`. Match the line.

`socket.io` and `socket.io-adapter` arrive as **exact regular dependencies** of
`@nestjs/platform-socket.io` (`socket.io@4.8.3`), not as peers, so their
versions are not ours to pin. `socket.io@4.8.3` is nevertheless declared in
`apps/api/package.json` because the gateway imports its types directly, and
`no-non-package-json` (CLAUDE.md §14) counts a transitive resolution as a
phantom dependency.

### 2. It attaches to the existing Fastify server and port

`@WebSocketGateway()` is given options only. Passing a port as the first
argument would open a second listener, which deployment would then have to
expose and firewall separately for no gain.

The official NestJS websocket documentation never mentions Fastify, so this was
verified by execution rather than taken on trust: REST and a real `websocket`
transport upgrade coexist on one port under `FastifyAdapter`.

`serveClient: false`, because socket.io otherwise serves its browser client
bundle at `/socket.io/socket.io.js`. The mobile app bundles its own client, and
an API that serves JavaScript is a surface with no reason to exist.

### 3. `@socket.io/redis-streams-adapter@0.3.1`, driven by our existing `ioredis@6`

The alternative was `@socket.io/redis-adapter@8.3.0`, the conventional
pub/sub-based choice. Both were executed against this repository's own
`redis:7-alpine` with two real Nest instances; both work with `ioredis@6.0.0`.

**The deciding argument is not the one the adapter's own documentation leads
with.** socket.io recommends the streams adapter for "connection state
recovery" and for resuming "without losing any packets" across a client
disconnect — and for us that is worth little, because this architecture already
says the socket is not the source of truth and the client refetches over HTTP
on reconnect. A client-side gap is already handled.

What decides it is the **server-side** gap. With the pub/sub adapter, a Redis
restart or a network blip between two instances silently discards everything
published during that window. No client learns anything: its own socket stayed
up, so nothing triggers the refetch that would repair the UI. The result is a
permanently stale screen with no signal anywhere — precisely the
"sometimes the app doesn't update" failure
[`realtime-architecture.md`](../architecture/realtime-architecture.md) calls the
worst class of bug to diagnose. A stream that resumes from its last offset does
not have that failure mode.

Maintenance points the same way: `@socket.io/redis-adapter`'s last release was
March 2024; the streams adapter shipped `0.3.0` in February 2026 and `0.3.1` in
March 2026.

**`ioredis@6` support could not be established from metadata and was not
assumed.** Neither adapter declares an `ioredis` or `redis` peer dependency at
all — the client is passed in and duck-typed, and `createAdapter`'s shipped
type declares it as `any`. What the adapter actually calls on a non-`redis@4`
client is `send_command("PUBSUB", …)`, the `messageBuffer` / `pmessageBuffer` /
`smessageBuffer` events, and `options.lazyConnect` + `.duplicate()`. All four
survive in the shipped `ioredis@6.0.0`, and cross-instance delivery,
`serverCount()`, `fetchSockets()` and `serverSideEmit()` were all exercised
against the real container. This is the doc-versus-artifact rule (CLAUDE.md §9)
doing its job: no published document answers this question.

### 4. A third Redis client, for the same reason BullMQ has a second

The adapter polls with a blocking `XREAD … BLOCK 5000` and builds every client
it needs by calling `.duplicate()` on the one it is handed — and `.duplicate()`
copies options across. Handing it `REDIS_CLIENT`, whose `maxRetriesPerRequest: 1`
is load-bearing for `/health/ready`, would put that limit on a blocking read:
the poll would be abandoned and the instance would stop receiving events with
nothing in the logs saying so.

So `REALTIME_REDIS_CLIENT` is built exactly as `BULLMQ_REDIS_CLIENT` is
([ADR-0025](ADR-0025-deferred-work-on-bullmq.md)) — `maxRetriesPerRequest: null`,
same URL, same never-give-up retry strategy.

Every key the adapter builds is namespaced under `REDIS_KEY_PREFIX`
(`streamName`, `channelPrefix`, `sessionKeyPrefix`), for the reason issue #125
gives: Redis is shared, and the adapter's defaults are bare constants.

### 5. Authentication is socket.io middleware, not `handleConnection`

Middleware rejects **before** the connection is established: the client
receives `connect_error` and never fires `connect`. Authenticating in
`handleConnection` would mean accepting the socket and then closing it — an
upgraded, briefly-live connection for a caller who proved nothing.

The token is read from the handshake's `auth` payload and from **nowhere
else** — not the query string, which is part of the URL and lands in proxy and
access logs, where CLAUDE.md §11 says a live credential may never be written.
There is no `Authorization` header path either: a browser cannot set headers on
a WebSocket upgrade, so it would be a second way in that only some clients can
use.

Every refusal returns the single string `unauthorized`. The specific reason
goes to the server log only, exactly as issue #27 established for HTTP 401s.

**The token is destroyed the instant it has been spent.** socket.io keeps
`handshake` for the socket's lifetime, and the cluster adapter serialises the
_entire_ handshake into its `FETCH_SOCKETS_RESPONSE`, stripping only
`sessionStore`. So one cluster-wide `fetchSockets()` would publish every
connected user's live access token onto the Redis channel this ADR records
below as unsigned and unauthenticated. This was not theoretical — running that
call across two instances returned the token — so `authenticate()` clears
`handshake.auth` once the actor is resolved, and an e2e test asserts the token
does not appear in the serialised response.

Note the corollary: **`socket.data` crosses the cluster too.** Nothing placed
there may be a credential. It currently carries the resolved actor, which
includes `sessionId` — an identifier, not a bearer token, and already inside
the JWT — but #167 should not add to it casually.

### 5b. A socket may not outlive the access token that opened it

Re-authenticating on reconnect satisfies the requirement only for clients that
reconnect. A phone left on a screen holds one socket for hours, and the actor
on it is resolved once and then frozen — so an admin suspending a master
mid-shift would not reach them, which is exactly what
[`authentication.md`](../architecture/authentication.md) § Role claims are a
cache exists to prevent.

The gateway therefore closes each socket at the `exp` of the token that opened
it. The bound is the credential's own lifetime — 15 minutes — so a stale
snapshot can outlive the truth by no longer than HTTP already allows. The
client reconnects (a fresh authentication) and refetches over HTTP, both of
which `realtime-architecture.md` § Connection lifecycle already requires of it.

This is a _bound_, not a substitute for re-reading current state. #167 must
still resolve the actor through `ActorService` before authorising a room join;
trusting the snapshot on `socket.data` would be the same mistake as trusting a
token's `roles` claim.

### 5c. Refused connections are bounded by `connectTimeout`, not by the account cap

A middleware refusal rejects the _namespace_ connection, not the _transport_
one: socket.io sends `CONNECT_ERROR` and leaves the engine.io connection open
until `connectTimeout`, whose default is 45 seconds. A cooperative client
closes at once; a hostile one does not — verified by holding raw WebSockets
past a rejecting middleware, where five refused clients kept five live
transports.

`ConnectionRegistry` cannot bound these, because they have no account to be
counted against, and `RateLimitGuard` explicitly opts out of non-HTTP contexts.
So the cheapest exhaustion path needs no credential at all, and the cap the
issue asked for does not reach it. `connectTimeout` is set to 3 seconds —
comfortably past the round trip an honest client needs to read `connect_error`
and close, and fifteen times tighter than the default.

**Residual risk, stated rather than hidden:** an unauthenticated flood can
still hold a file descriptor for up to 3 seconds per attempt. Bounding it
properly needs a per-IP handshake limit, which belongs with EPIC 15 and the
hosting choice (a load balancer is the better place for it) rather than being
invented here.

### 6. The connection cap evicts the oldest socket rather than refusing the new one

Both directions bound the resource identically, so the tiebreaker is which
behaves better for an honest client. A master whose phone dropped off a tunnel
reconnects while the server is still holding sockets it has not yet noticed are
dead — socket.io only reaps them after `pingTimeout`. Refusing the new
connection would lock that master out of their own account for as long as the
corpses survive, repeatedly, on exactly the mobile networks this market runs
on. Evicting the oldest is not the weaker control: whoever reaches that code
already holds a valid access token for the account.

The registry is **per-instance and in-process**, which is the correct scope
rather than a CLAUDE.md §12 violation: a socket consumes file descriptors and
event-loop time on the one instance holding it, so each instance bounds what it
actually pays for. The cluster-wide ceiling is therefore
`REALTIME_MAX_CONNECTIONS_PER_USER × instances`, which is the honest
description of a resource bound.

### 7. The HTTP guards fail closed on a non-HTTP context

`AuthenticationGuard` and `RolesGuard` are `APP_GUARD`s, so they are asked
about every execution context — including, from now on, WebSocket ones. Both
read `context.switchToHttp().getRequest()`, which for a socket yields the
socket. Both now refuse a non-HTTP context outright.

Nothing legitimate reaches that branch today: this gateway has no message
handler, and the socket authenticates in its own middleware. It exists so that
the first `@SubscribeMessage` handler added in #167 fails loudly instead of
being silently waved through the API's secure-by-default promise.

## Alternatives considered

| Alternative                                                            | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nestjs/platform-ws` (plain `ws`)                                     | `ws` offers exactly one collection primitive: a flat `Set` of open sockets. `socket.io-adapter` maintains the room↔socket maps in both directions **and** defines the interface a Redis adapter plugs into; with `ws` there is no such seam, so cross-instance fan-out means hand-writing a room registry, a Redis wire protocol with self-echo suppression, message framing, acknowledgement correlation, dead-connection reaping and client re-subscription after reconnect. CLAUDE.md §10 asks whether a dependency is "a few lines of our own code". This is emphatically not. |
| `@socket.io/redis-adapter@8.3.0`                                       | Verified working with `ioredis@6`, and the more conservative pin at a stable major. Rejected for the silent server-side gap described above. It remains the fallback: the adapter is constructed in one place, so switching is a one-file change.                                                                                                                                                                                                                                                                                                                                  |
| `createShardedAdapter`                                                 | socket.io recommends it "for new developments", but sharded pub/sub targets Redis **cluster** mode — `shardedSubscribers` is a `ClusterOptions` field — and we run standalone `redis:7-alpine`. It also carries the same "connection state recovery: no". Revisit if we move to Redis Cluster.                                                                                                                                                                                                                                                                                     |
| `redis` (node-redis) as the adapter client, per the NestJS doc example | Would add a second Redis client library beside the `ioredis@6` that `apps/api` and BullMQ already use, and socket.io's own documentation warns that `redis` "seems to have problems restoring the Redis subscriptions after reconnection".                                                                                                                                                                                                                                                                                                                                         |

## Consequences

### Accepted risk: a 0.x dependency on the delivery path

`@socket.io/redis-streams-adapter` is `0.3.1` and carries no 1.0 stability
promise; `0.2.x → 0.3.x` happened twice in 2026. It is published and maintained
by the socket.io team and listed in the official adapter index, but a breaking
`0.4` is a realistic event.

The mitigation is structural: the adapter is constructed in exactly one place,
`realtime-io.adapter.ts`, and `@socket.io/redis-adapter@8.3.0` has been
verified to work identically minus recovery. Falling back is one file.

### More Redis work than pub/sub

Every broadcast is an `XADD` (trimmed at `maxLen` 10 000, `~`), and each
instance runs a blocking `XREAD`. That is more load than fire-and-forget
pub/sub, on the same Redis BullMQ already uses. If it ever matters, a separate
logical database or instance is the answer; it is not worth pre-splitting now.

### Sticky sessions remain a hosting decision, deferred to the client

The NestJS documentation is blunt: with multiple load-balanced instances you
must either disable polling by setting `transports: ['websocket']` on the
client, or enable sticky sessions in the load balancer — "Redis alone is not
enough."

The hosting provider is still an open decision (CLAUDE.md §1), so this ADR does
not settle the load balancer. The server accepts both transports; **the mobile
client (#170) sets `transports: ['websocket']`**, which removes the requirement
entirely. The cost is losing socket.io's long-polling fallback, which is the
fallback that helps most on a bad mobile network — so this is worth revisiting
together with the hosting choice rather than treated as settled.

### Redis is trusted infrastructure

Both adapters carry the same warning: messages exchanged through them are not
signed, encrypted or authenticated, so anyone able to publish into the adapter's
keyspace can inject packets or forge events to connected clients. Given that
#169 will fan out live master coordinates, Redis has to be network-isolated
wherever this is deployed. That is an EPIC 17 constraint, recorded here so it is
not discovered later.

### Not covered by this decision

- **Connection state recovery is not enabled.** The adapter supports it; this
  issue does not turn it on, because the architecture's answer to a gap is a
  refetch. Enabling it is a separate decision with its own Redis cost.
- **The client side is unverified.** Whether `socket.io-client` behaves on Expo
  SDK 57 / RN 0.86 / Hermes, and what it costs in bundle size on a mid-range
  Android, is #170's question and was not investigated here.
- **The polling transport over Fastify is untested.** Every test forces
  `transports: ['websocket']`, which is also what the client will do.
- **Per-IP handshake rate limiting is not implemented.** See §5c: the residual
  unauthenticated-connection cost is bounded to 3 seconds per attempt and no
  further. EPIC 15.
- **Nothing revokes a live socket on demand.** §5b bounds a stale actor to the
  access token's lifetime, which is the guarantee HTTP already gives. Pushing a
  revocation to a connected socket — so a suspension takes effect in
  milliseconds rather than minutes — would need `RealtimeModule` to stop being
  a leaf, and is not required by anything today.
