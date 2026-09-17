# ADR-0020 — The service catalogue is public, and cached read-through in Redis

- **Status:** **Accepted**
- **Date:** 2026-09-17
- **Decided by:** Engineering, within EPIC 3's stated scope

## Context

Until EPIC 3, `AuthenticationGuard` sat as a global `APP_GUARD` in front of
every route, and a route was protected unless it carried an explicit
`@Public()`. The only two exemptions in the codebase were the health probes —
nothing a customer or master ever calls.

EPIC 3 / issue #32 asks for public read endpoints over the service catalogue,
and asks explicitly that "these are the only unauthenticated read endpoints in
the system so far" be confirmed as intended rather than assumed. That
confirmation is this ADR.

The catalogue itself — `service_categories` and `services` — is read on
essentially every app launch and changes on a human timescale: an admin adding
a service, a price correction. Nothing about it is scoped to a user.

## Decision

Two parts.

### 1. The catalogue reads are `@Public()`

`GET /services`, `GET /services/:id` and `GET /services/categories` in
`apps/api/src/modules/services/services.controller.ts` each carry `@Public()`
on the method, not on the controller class — the same reasoning
`HealthController` already established: a route added to this controller
later has to opt out of authentication deliberately, not inherit an exemption
nobody chose for it.

A customer has to be able to see what TezUsta does before surrendering a
phone number, and gating the catalogue behind sign-in would mean asking for
one before offering anything. The content is a menu of services and reference
prices — exactly what the product advertises publicly anyway — and nothing in
the response is scoped to a user, so there is no ownership dimension to get
wrong. The repository's projection already narrows the row to public fields
before this layer ever sees it: no `is_active`, no timestamps, no internal
identifier beyond the ids a client needs to ask a follow-up question with.

**What this does not open the door to.** Nothing scoped to a user, a master's
position, an address, or an order becomes public by this precedent. The
catalogue is public because it carries no ownership dimension at all; the
moment a response would differ by who is asking, this decision no longer
applies to it.

### 2. Reads are cached read-through in Redis

`ServicesService` (`apps/api/src/modules/services/services.service.ts`) wraps
`ServicesRepository` reads in `CacheService.readThrough`
(`apps/api/src/infra/cache/cache.service.ts`), keyed under the prefix
`catalogue:v1:`, with a TTL of `CATALOGUE_CACHE_TTL_SECONDS = 60`. The same
sixty seconds is echoed to the client:

```
Cache-Control: public, max-age=60
Vary: Accept-Language
```

`Vary: Accept-Language` is load-bearing, not decorative. The body is
translated per ADR-0019's locale map, resolved against the caller's
`Accept-Language` header. `Cache-Control: public` without `Vary` tells every
shared cache between the server and the phone that one stored copy serves
everybody — and the first Azerbaijani response would then be handed to a
caller who asked for English, for the next minute. `Vary` is what makes the
language part of the cache key rather than an accident of who arrived first.
`public` rather than `private` is correct here specifically because nothing in
a catalogue response is scoped to a caller; there is no per-caller content for
an intermediary to leak by sharing the copy.

## Why

**Redis, not in-process memory.** CLAUDE.md §12 forbids in-process state two
API instances would disagree about, and a local memory cache would
reintroduce exactly the staleness problem a shared cache solves for a
horizontally scaled API: instance A could keep serving a stale value for the
whole of its own TTL after instance B has already invalidated and refreshed
the shared one. `CacheService`'s own header comment makes the same point in
the negative: "Redis being down means falling all the way back to `load()`,
not to a second, worse cache."

**A cache outage must never become a request outage.** These are public,
unauthenticated read endpoints — adding a cache in front of them must not make
them _less_ available than before caching existed. Every Redis operation in
`CacheService` is wrapped so a failure degrades to "behave as if nothing were
cached" and falls through to the database. The one deliberate exception is
`load()` itself: if the real data source throws, that error is real and must
reach the caller, or a database outage would silently become an empty
response.

## Sub-decisions

**Only the first page is cached.** A cache key derived from a client-supplied
cursor is a key an anonymous caller can mint without limit: a thousand
plausible cursors are a thousand Redis entries and a thousand database reads,
on the one surface in the API that needs no account to hit. `ServicesService`
enforces this directly — `read()` calls `this.cache.readThrough(...)` only
when `position === null` (no cursor supplied) and calls the repository
directly otherwise. The first page carries essentially all of the traffic: the
launch catalogue is thirty-three rows and the default page size is fifty
(`DEFAULT_CATALOGUE_PAGE_SIZE`), so caching it captures the benefit and leaves
nothing worth attacking. A deeper page still costs one indexed keyset read,
which is the query the catalogue's partial indexes exist for in the first
place.

**A 404 is never cached.** `getServiceById` caches the repository's read, not
the "not found" outcome — `NotFoundError` is thrown from the outer function
after `readThrough` returns `null`, so the cache never holds an absence.
Caching "this id does not exist" would let anyone turn a public endpoint into
a way to fill Redis one random UUID at a time. A hit is cheap to cache and a
miss is already a single primary-key lookup, so declining to cache misses
costs nothing.

**`invalidatePrefix` uses `SCAN` + `UNLINK`, never `KEYS` or `DEL`.** `KEYS
prefix*` walks the entire keyspace in one command and blocks every other
client for however long that walk takes — on a keyspace shared with rate-limit
counters and sessions, that is a stall imposed on every unrelated request in
flight by one cache invalidation. `SCAN` walks the same keyspace
incrementally, interleaved with everything else Redis is serving. `DEL` frees
memory synchronously on the same thread answering everyone else's commands;
`UNLINK` reclaims it on a background thread and returns immediately. Nothing
calls `invalidatePrefix` yet — there is no writer — so this is prepared for
EPIC 13, not exercised today.

**The catalogue reads are not rate-limited, and that is a scope boundary, not
an oversight.** `RateLimitPolicyName` in
`apps/api/src/infra/rate-limit/rate-limit.config.ts` lists exactly three
policies — `otp-request`, `sign-in`, `refresh` — and its own comment states
the boundary directly: it names OTP request and OTP verify as sign-in on the
consumer path, "there is no third endpoint to throttle, and listing one
invites somebody to build it," and separately excludes WebSocket flooding as
the wrong shape of limit for that enum. A catalogue policy is absent for the
same reason — it was left out of EPIC 3's scope, not forgotten. What mitigates
the gap today: the first page — the page nearly every request lands on — is
answered from cache rather than the database; `limit` is capped at
`MAX_CATALOGUE_PAGE_SIZE = 100` so no single request can force an unbounded
scan; and there is no cacheable, attacker-controlled key, since only the
uncursored first page is ever written to Redis. This is recorded below as a
revisit trigger, not closed.

## Alternatives considered

**Require a token for the catalogue.** Rejected: it forces sign-up before the
product has shown the caller anything, and it protects data — a public price
list — that carries no sensitivity to protect.

**HTTP cache headers alone, no server-side cache.** Rejected: mobile clients
and intermediaries cache inconsistently, and the first request after every
TTL expiry from _every_ client would still land on Postgres. A server-side
cache is what makes the read cost independent of client count; `Cache-Control`
only reduces how often a given client re-asks.

**In-process memory cache (a `Map` with a TTL).** Rejected: two API instances
would disagree about the catalogue's freshness, which CLAUDE.md §12 forbids
outright. It is also invisible to an admin trying to force a refresh — there
is nothing a second process could call to clear the first process's memory.

**Cache every page, keyed by cursor.** Rejected for the flooding reason given
above: a cursor is client-supplied, so keying the cache on it hands an
anonymous caller a lever to mint unbounded cache entries and unbounded
database reads.

**Explicit invalidation instead of a TTL.** Not rejected — deferred. There is
no writer yet: nothing in the running system edits `service_categories` or
`services`. When EPIC 13's admin panel lands, a write should call
`CacheService.invalidatePrefix(CATALOGUE_CACHE_PREFIX)`, and the TTL becomes
the backstop rather than the mechanism. `invalidatePrefix`'s `SCAN`/`UNLINK`
implementation already exists in `CacheService` for exactly that call.

## Trade-offs accepted

- An admin's edit to the catalogue takes up to sixty seconds to appear in a
  fresh server read, because there is no invalidation path yet — only a TTL.
- A client holding a `max-age=60` response can serve it for a further minute
  on top of that, so the worst-case staleness a caller can observe is
  bounded but not small.
- The cache key does not name a database — `catalogue:v1:categories:50`, say,
  carries no environment or database identifier. That is correct in
  production, where one Redis backs one Postgres, and it is why the
  integration test suite clears the `catalogue:v1:` prefix itself rather than
  relying on key isolation.
- The catalogue read path has no dedicated rate limit. The mitigations above
  bound the exposure; they do not remove it.

## Consequences

- `docs/architecture/backend-architecture.md` § API conventions records, in the
  same commit, that `apps/api/src/modules/services/` is the one module with
  unauthenticated read routes, and why.
- A future write path for the catalogue (EPIC 13) must call
  `CacheService.invalidatePrefix(CATALOGUE_CACHE_PREFIX)` after a successful
  write, not rely on the TTL alone, or an admin's correction will sit invisible
  for up to a minute with no way to force it sooner.
- Any future public, unauthenticated read endpoint should be checked against
  this ADR's boundary — no ownership dimension in the response — before it is
  granted `@Public()`, and should re-ask the caching questions here (cursor
  flooding, miss caching, rate limiting) rather than assume they were answered
  once for the whole API.

## Revisit when

The catalogue read shows up in load metrics as a Redis hotspot; the admin
panel needs the catalogue to reflect an edit instantly rather than within a
TTL window; or a public endpoint's traffic pattern needs a per-IP rate limit,
at which point `RateLimitPolicyName` gains a fourth member and this ADR's
"not rate-limited" sub-decision is superseded.
