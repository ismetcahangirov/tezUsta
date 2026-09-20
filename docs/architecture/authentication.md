# Authentication and authorization

> **For customers and masters, sign-in is phone number + SMS OTP, and there is
> no other sign-in path** ([ADR-0008](../decisions/ADR-0008-otp-delivery.md)).
> The SMS provider is still open, and it blocks completing EPIC 2 — real
> sign-in. The sender sits behind a provider interface with a stub, so the rest
> of authentication is buildable; nobody can actually sign in until a provider
> is chosen.
>
> Social sign-in is **not** used. The phone number is simultaneously the identity
> and the contact channel, because the customer and the master must be able to
> call each other during a job.
>
> **Admin accounts are a separate credential path on a separate application**
> ([ADR-0014](../decisions/ADR-0014-admin-authentication.md)), with no account
> overlap. Everything below applies to the consumer path unless it says
> otherwise; the admin path is specified in its own section at the end.

## Sign-in flow

```
Enter phone number  →  SMS code  →  signed in
```

OTP proves ownership of the number. It does **not** create the session directly:
once the code is verified, the server issues its own access/refresh pair, and
everything from that point on is the token model below.

**One authentication vector on the consumer surface, not two.** No second
sign-in path may be added alongside this one for customers or masters — a weaker
parallel route would undo the protections here. That rule is about the consumer
surface; it was never a claim that an internal tool with its own account store
cannot exist ([ADR-0014](../decisions/ADR-0014-admin-authentication.md)).

### How it is implemented (issue #29)

`POST /auth/otp/request` and `POST /auth/otp/verify`, both public by necessity
and both rate limited (§ Rate limiting below). What is worth knowing without
reading `apps/api/src/modules/auth/otp.*`:

- **Codes live in Postgres (`otp_challenges`), counters live in Redis.** A code
  is a credential that must be consumed exactly once and audited afterwards; a
  counter is allowed to be lossy. Consumption is a single conditional `UPDATE`,
  so two concurrent verifications of one code cannot both succeed.
- **The stored digest is HMAC-SHA256 under `OTP_CODE_PEPPER`**, keyed by the
  challenge id as well. A six-digit code is ~20 bits, so an unkeyed digest in a
  leaked dump is invertible by enumeration in milliseconds; a slow KDF would
  not fix that and would break the atomic consumption above, since a per-row
  salted hash cannot be compared inside the `WHERE` clause
  ([`../engineering/dependency-policy.md`](../engineering/dependency-policy.md)).
- **The request endpoint never reads `users`.** Identity is decided at
  verification, so a known and an unknown number do not merely answer
  identically — they execute the same statements. The account is created there,
  with **no role grant**; choosing customer or master is a separate decision.
  That decision is made by creating a role profile: `POST /customers` inserts
  the profile row and the `customer` grant in **one transaction** (EPIC 4,
  issue #34), so an account never sits in the half-state where it has a profile
  every guard refuses, or a grant with no profile behind it.
- **The attempt cap and the code are owned by different layers.**
  `RateLimiterService.consumeAttempt` counts guesses against the challenge id
  (so a new code gets a new budget); invalidating the code once the cap is
  spent belongs to the OTP module, which is the only one that knows what the
  counter was guarding.
- **Delivery sits behind the `SmsSender` interface** in
  `apps/api/src/infra/sms/`, and **the provider is still an open decision**
  (CLAUDE.md §1). Until one is chosen nobody can actually sign in: the only
  sender that exists is the development stub, which refuses to construct under
  `NODE_ENV=production`.

## Token model

| Token       | TTL                           | Stored where                                          |
| ----------- | ----------------------------- | ----------------------------------------------------- |
| **Access**  | 15 minutes                    | Memory on the client; sent as `Authorization: Bearer` |
| **Refresh** | 30 days, rotated on every use | `expo-secure-store`; **hashed** in Postgres           |

### Why a short access token

An access token is self-contained — the server does not check the database to
validate its signature. That makes it fast and stateless, and it also makes
revocation impossible before expiry. Fifteen minutes bounds the damage from a
stolen token while keeping the fast path fast.

Revocation is real at the **refresh** layer, which is stateful.

### Refresh rotation with reuse detection

Every refresh returns a **new** refresh token and invalidates the one presented.

If an already-used refresh token is presented again, that means two parties hold
it — the legitimate client and a thief. The response is to **invalidate the whole
session family**, forcing re-authentication.

```
normal:  RT1 → RT2 → RT3
theft:   RT1 → RT2          (client)
         RT1 → reuse!       (attacker) → entire family revoked
```

This turns a stolen refresh token from persistent access into a short window
plus a detectable event. Without rotation, a stolen refresh token is effectively
a permanent credential.

#### Reuse revokes **every** session, not only the family

The diagram above shows one family, and the narrower rule — revoke that family —
is the common implementation. TezUsta revokes every session the user holds.

A thief who captured one refresh token very likely captured whatever else was on
that device, so treating the rest as untouched is optimism rather than analysis.
The cost of being wrong is one SMS per device; the cost of the narrow rule being
wrong is a thief who still holds a working session on another family.

#### The concurrent-refresh window

Rotation with reuse detection has one failure mode that is not an attack: a
mobile client fires a refresh, the connection drops before the response arrives,
and the client retries with the token it still has. It has now presented one
token twice, through nobody's fault — and a naive detector reads that as theft
and signs the user out of every device because their train went into a tunnel.

So a second presentation is theft **only outside a short window**:

| Second presentation                       | Treated as                                      |
| ----------------------------------------- | ----------------------------------------------- |
| Within `REFRESH_REUSE_GRACE_SECONDS` (10) | The same client retrying — a new pair is issued |
| After it                                  | Reuse — every session revoked                   |

The window is configuration, bounded at 0–60 seconds, and `0` disables the retry
path entirely. Two genuinely concurrent refreshes are handled by the same rule:
consumption is a conditional `UPDATE`, exactly one caller wins it, and the loser
falls into the window and is served rather than punished.

This is a deliberate, bounded weakening. Inside those seconds a captured token
replayed immediately succeeds. That is a narrower opening than it looks —
the attacker must already hold the token and must use it within seconds of the
legitimate client — and it is the price of not signing users out for network
weather. Both tokens die with the family either way.

### Storage — `expo-secure-store`, never `AsyncStorage`

`AsyncStorage` is unencrypted plaintext on the filesystem. Any process with
filesystem access on a rooted or jailbroken device can read it — and that is a
realistic threat for an app that moves money.

`expo-secure-store` uses the iOS Keychain and Android Keystore: hardware-backed
where available, and encrypted at rest.

**Putting a token in `AsyncStorage` is forbidden** (CLAUDE.md §11, §20).

The access token stays in memory only. Persisting it buys nothing — it expires in
15 minutes and can be re-minted from the refresh token.

### At rest

Refresh tokens are **hashed** in the database, like passwords. A database read —
by a backup leak, a SQL injection, or an over-privileged admin — must not yield a
usable credential.

One row per device session: device id, user agent, created, last used, revoked.
This is what makes "sign out on that other phone" implementable.

#### The shape this takes in the schema (EPIC 2, issue #25)

Two tables, not one.

| Table            | Holds                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| `sessions`       | The device session — the refresh **family**. No token value at all.        |
| `refresh_tokens` | One row per refresh token ever **issued**, with its hash and its `used_at` |

Keeping the current hash on `sessions` and overwriting it on each rotation is
the obvious design and it cannot detect reuse: a replayed spent token would
hash to a value matching no row, which is indistinguishable from a corrupt
string. Retaining the spent rows is what makes a replay land on a row that
exists and is already marked used — the theft signal itself.

It also makes redemption atomic without a lock:
`UPDATE refresh_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL
RETURNING *`, where the loser of a concurrent race gets zero rows — the same
conditional-update pattern as the order accept.

The token presented by the client is `<row id>.<32 CSPRNG bytes>`, not a JWT. A
refresh token is checked against the database on every use regardless, so a
self-contained token would add claims to steal and buy nothing; carrying the row
id in the clear makes verification one indexed lookup rather than a scan that
re-hashes every candidate row. The secret half is stored as **HMAC-SHA256 keyed
by `JWT_REFRESH_SECRET`** — a pepper the database never holds — so a leaked dump
cannot be attacked without also stealing the application secret. Rotating that
secret signs every user out, which is the correct response to a compromised key.

## Sessions and devices

| Operation                              | Effect                              |
| -------------------------------------- | ----------------------------------- |
| Sign out                               | Revoke this session's refresh token |
| Sign out everywhere                    | Revoke all of the user's sessions   |
| **Phone number change**                | Revoke all of that user's sessions  |
| Admin password or second-factor change | Revoke all of that admin's sessions |
| Suspension by admin                    | Revoke all sessions                 |
| Reuse detected                         | Revoke the whole family             |

**There is no password on the consumer path.** A customer or master has a phone
number and an OTP, nothing else, so the credential whose change invalidates
their sessions is the phone number — it is the identity itself, and changing it
means the old number can no longer prove anything. Passwords and second factors
exist only for `admin_users`.

**A suspended account cannot open a new session at all.** The roles written
into an access token are read from the database when the session starts — they
are never supplied by whatever proved the credential. Passing them in would make
"mint a master token for a user holding no master grant" a one-argument mistake,
in the one place where a mistake is a privilege escalation.

Access tokens already issued remain valid until they expire — at most 15 minutes.
Where an action must take effect immediately (an admin suspending a master mid-
order), the **authorization check re-reads current status from the database**, so
the stale token still fails.

### Retention (issue #57)

One row is kept per refresh token ever issued, which is what makes reuse
detection possible at all — a replay has to land on a row that exists and is
already marked used. Nothing about that changes; what changes is that the rows
do not now live forever.

A `maintenance` queue job (`modules/maintenance`) deletes, in bounded batches:

- `refresh_tokens` whose `expires_at` is more than `AUTH_RETENTION_DAYS` past,
- then the `sessions` they belonged to, once no token points at them — that
  order is forced by the `ON DELETE RESTRICT` foreign key, not chosen.

`AUTH_RETENTION_DAYS` is validated to be **at least `JWT_REFRESH_TTL`**. Below
that the sweep deletes credentials that are still live, and destroys the spent
rows the theft signal reads, so a replayed token would hash to nothing and the
detection would fail silently. The shipped default leaves a fortnight past the
30-day family for an incident to be investigated after the fact.

**A family revoked for `reuse_detected` is held to its own, longer window**
(`AUTH_INCIDENT_RETENTION_DAYS`, validated to be at least
`AUTH_RETENTION_DAYS`). It is the only record that the theft signal fired and
it is where an investigation starts, and an investigation may begin long after
the event — so retiring it on the schedule that retires an ordinary sign-out
would leave the incident with no evidence.

**Longer, not forever.** A theft signal old enough that nobody will ever read
it is session metadata — `user_id`, `device_id`, `user_agent`, timestamps —
kept for no reason, and every other place this system holds personal data is
bounded: `master_locations`, `geocode_cache`, and now these two tables. "Keep
forever" is what every unbounded table was once justified by.

**The window is one year, and the record is kept whole**
([ADR-0027](../decisions/ADR-0027-refresh-token-incident-retention.md), #126).
A year is the outer edge of when the question these rows answer — _was this
credential replayed, when, and from which device?_ — still arrives: such
reports come from a user weeks to months after the event, never years. The
whole session row is retained rather than a reduced one, because `device_id`
and `user_agent` are the incident's content and not decoration around it; a
stub stripped of them would record that something happened to somebody. And it
is **one** window, not two: `refresh_tokens.session_id` is `ON DELETE RESTRICT`,
so a second window could only retire the tokens earlier than the session, which
is exactly the half carrying the timeline. The ADR records the alternatives —
90/180 days, keeping it indefinitely, and anonymising rather than deleting —
and why each was rejected.

That number is a product judgement, not a legal finding: no Azerbaijani
data-protection obligation has been established here. If counsel establishes
one, it supersedes ADR-0027 with a new ADR, and the mechanism — a bounded,
configurable window with a validated floor — already takes any number in range.

## Authorization

Three layers. Only the last two are security.

### 1. Client route guards — **not security**

The app hides what a role cannot use. This is UX. It is trivially bypassed by
anyone talking to the API directly.

### 2. Server guards — authentication and role

Verify the signature, expiry, and that the session is not revoked.

#### The shape this takes in the code (EPIC 2, issue #27)

Two global guards, registered as `APP_GUARD` providers in `AppModule` — not in
`main.ts`, so every integration test exercises the same wiring the service runs.

| Piece                      | Lives in                                      | Does                                                                                                             |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `AuthenticationGuard`      | `modules/auth/authentication.guard.ts`        | Reads the bearer token, verifies it, then **re-reads the actor from the database** and attaches it               |
| `ActorService`             | `modules/auth/actor.service.ts`               | The re-read itself: session usable, user live and `active`, roles from `user_roles`                              |
| `RolesGuard`               | `modules/auth/roles.guard.ts`                 | Enforces `@Roles('master')` against `request.actor.roles` — it never sees the token, so it cannot read the claim |
| `@Public()`                | `modules/auth/public.decorator.ts`            | The only way out. A route with no decorator is protected                                                         |
| `requireVisibleOrNotFound` | `common/authorization/resource-visibility.ts` | Layer 3, below                                                                                                   |

**Secure by default.** The decorator opts routes _out_, never in: forgetting an
`@Authenticated()` would ship an open endpoint that passes every test anyone
thought to write, while forgetting `@Public()` yields a 401 that is noticed
immediately and is never a breach. `/health/live` and `/health/ready` are the
only public routes today.

**The guards do not say which check failed.** Every authentication failure —
absent header, bad signature, expired token, revoked session, suspended account
— answers with one 401, one code and one message. The specific reason travels on
`InvalidAccessTokenError.reason` to the server log, beside the request id and
the actor id, and never into a response body. A client that can tell `expired`
from `session_revoked` holds an oracle it was never meant to have.

Because guards run **before** interceptors in Nest, and a rejecting guard
short-circuits the pipeline, `AuthenticationGuard` resolves the request id
itself (`common/request-context/request-context.ts`) rather than leaving it to
`RequestIdInterceptor`. Without that, every 401 in the system would be logged
and answered with no correlatable id.

### 3. Server ownership checks — the real control

**Being authenticated is not being entitled.**

`GET /orders/:id` must confirm that the caller is that order's customer, its
assigned master, or an admin. Without this, any authenticated user enumerates
every order in the system — including live home addresses.

```ts
// Every resource handler answers this, not just "is there a valid token".
const order = requireVisibleOrNotFound(
  await orders.findById(id),
  (candidate) => candidate.customerId === actor.userId,
);
```

**A 403 on someone else's order id confirms the order exists.** Return 404 for
"not yours" so the API is not an existence oracle.

"Does not exist" and "not yours" are one call, deliberately: written as two
statements they are two correct-looking lines that together leak, because the
first to grow a `details` payload reinstates the oracle without changing a
status code. `requireVisibleOrNotFound` throws the same argument-less
`NotFoundError` for both.

### Role claims are a cache, not an authority

A token issued before a master was suspended still carries `role: master`.
Therefore **every authorization decision re-checks current status against the
database** — verification status, suspension, and assignment. The token says who
you claim to be; the database says what you may currently do.

This is the difference between a master being suspended and a master _actually_
being unable to accept work.

## Rate limiting

Authentication endpoints are the most attacked surface, and for OTP the attack is
financial as much as technical — an unthrottled OTP endpoint spends real money on
SMS.

| Endpoint      | Limit                                               |
| ------------- | --------------------------------------------------- |
| OTP request   | Per phone **and** per IP, with backoff              |
| OTP verify    | 5 attempts per code, then invalidate                |
| Refresh       | Per session                                         |
| Admin sign-in | Per identifier **and** per IP, with account lockout |

**OTP request and OTP verify _are_ sign-in on the consumer path** — there is no
third endpoint to throttle, and listing one invites somebody to build it. The
only separate sign-in surface is the admin panel's email + password + TOTP form,
which needs lockout as well as a rate limit because it is guessable in a way an
OTP code delivered out of band is not
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)).

Responses must be **identical for known and unknown identifiers**, or the
endpoint becomes a user-enumeration oracle.

Details: [ADR-0008](../decisions/ADR-0008-otp-delivery.md),
[`../engineering/security.md`](../engineering/security.md).

### How it is implemented (issue #28)

`apps/api/src/infra/rate-limit/` holds a `RateLimiterService` written directly
against the `ioredis` client, and `@RateLimit({ policy, identifier })` +
`RateLimitGuard` apply it to a route. There is no `@nestjs/throttler`: no
published release of it peers against NestJS 12, which this repository pins
(recorded in [`../engineering/dependency-policy.md`](../engineering/dependency-policy.md)).

What is worth knowing without reading the code:

- **Three policy names, matching the table above**: `otp-request`, `sign-in`
  (which is OTP verify today and the admin form from EPIC 13), and `refresh`.
  Every budget comes from a validated, range-checked environment variable —
  `boundedInt` in `env.schema.ts` exists because a rate limit of `0` and one of
  `1000000` both pass a "positive integer" check and both disable the control.
- **Increment and expiry commit together**, in one Lua script. `INCR` followed
  by a separate `PEXPIRE` leaves an immortal key if the process dies between
  them, and an immortal counter is a permanent lockout for whoever was
  mid-request.
- **Backoff** means a request made while _already_ over a limit pushes that
  window's reset out by one more window, up to
  `AUTH_RATE_LIMIT_BACKOFF_MULTIPLIER` windows. Honest callers never see it.
- **The subject is never stored in the clear.** The Redis key contains an
  HMAC-SHA256 of the phone number (or IP, or session id) under
  `RATE_LIMIT_KEY_SECRET`. A bare hash would not do: the `+994` mobile keyspace
  is under 10^9 candidates, so anyone with `KEYS`/`MONITOR` could invert it.
  `RateLimitModule` refuses to start without that pepper.
- **A route with no `@RateLimit` decorator is not limited.** This is the
  opposite default from the authentication guard, deliberately: "require a
  token" is a safe default, but there is no safe default _number_, and an
  arbitrary threshold is protection in appearance only.
- **`trustProxy` is off**, so the per-IP key is the socket peer. It stays off
  until a reverse proxy exists to trust (EPIC 17) — enabling it earlier would
  make `X-Forwarded-For` client-controlled and let a caller mint a fresh budget
  per request.

Issue #29 owns OTP itself, including invalidating a code once the attempt cap
reports it spent; the counting primitive it uses is
`RateLimiterService.consumeAttempt`.

## Admin authentication

**A separate credential path, on a separate application, with no account
overlap** ([ADR-0014](../decisions/ADR-0014-admin-authentication.md)).

|                   | Customer / master                        | Admin                                               |
| ----------------- | ---------------------------------------- | --------------------------------------------------- |
| Application       | `apps/mobile`                            | `apps/admin` (web, EPIC 13)                         |
| Credential        | Phone + SMS OTP                          | Email + password + **mandatory TOTP second factor** |
| Account store     | `users`                                  | `admin_users` — a distinct table                    |
| Self-registration | Yes                                      | **No.** Admins are provisioned by an existing admin |
| Session lifetime  | Access 15 min / refresh 30 days, rotated | Access 15 min / refresh **8 hours**, rotated        |
| Idle timeout      | None                                     | **30 minutes**                                      |
| Token storage     | `expo-secure-store`                      | httpOnly, `Secure`, `SameSite=Strict` cookie        |

Rules:

- **One human, two accounts.** An admin who is also a customer has an
  `admin_users` row and a separate `users` row. Nothing links them, and an admin
  session never grants customer or master capability.
- **The two paths share no issuer, no audience claim, and no refresh family**,
  so an admin credential cannot sign in to the mobile app and a phone OTP cannot
  sign in to the admin panel. That is a structural guarantee, not a check
  somebody can forget.
- **A cookie rather than a bearer token, for the web app only.** The admin panel
  is a browser application, where an httpOnly cookie removes the XSS token-theft
  path `localStorage` would open. The mobile app has no such option and keeps
  `expo-secure-store`.
- **Every admin action writes an audit record** — actor, action, target, reason,
  timestamp — including reads of personal data. Stricter than the consumer path,
  deliberately.

**Why not OTP for admins too:** a customer account can create an order; an admin
account can suspend a master, resolve a dispute, and read personal data across
the whole platform. Binding that to SMS makes SIM swap a platform-wide
compromise rather than a single-account one.

**Shipping order.** Admin authorization — the account store, its session
model, and the guard that enforces them — was assigned to **EPIC 2**, because
every module depends on it and deferring it to EPIC 13 would close a dependency
cycle on itself ([ADR-0014](../decisions/ADR-0014-admin-authentication.md)).
**EPIC 2 shipped without it**, and issue #39 is where that cycle actually bit:
EPIC 5's admin review endpoints had nothing to be guarded by. The layer was
therefore built there, in `apps/api/src/modules/admin/`:

- `admin_users`, `admin_sessions` and the append-only `admin_audit_log`
  (migration `0009_admin_identity`).
- An admin token family with its own signing key and its own `aud` claim, so a
  consumer token fails an admin route and an admin token fails a consumer one
  without either verifier checking anything extra.
- `AdminAuthenticationGuard`, a global guard that authenticates **every request
  under `/admin`** by path rather than by decorator — a forgotten marker would
  otherwise leave an admin route on the consumer guard, where a customer's
  token authenticates and, with no `@Roles()`, passes. `AuthenticationGuard`
  refuses to serve an `/admin` request that has no admin actor on it, so the
  mistake of unregistering the admin guard is a 401 across the surface rather
  than an open one.
- `AdminActorService`, which re-reads the admin row and the session on every
  request, and enforces the 30-minute idle timeout.

Admin credential issuance — email, password, mandatory TOTP, the sign-in form —
and `apps/admin` still ship in **EPIC 13**, as does the granular permission
model. `admin_users` therefore carries no password or TOTP column yet: adding
one would mean choosing a hashing scheme for a flow nobody has written. Until
then admin-only endpoints exist, are guarded, and are tested against a fixture
admin whose session is opened directly through `AdminSessionService`, but no
production admin credential is issued — which is exactly the interim state
ADR-0014 described.

**Still open:** which TOTP library or identity provider supplies the second
factor. It blocks nothing before EPIC 13.

## Testing requirements

Auth is exactly where "it works" is not evidence. Required tests:

- Expired access token is rejected
- Revoked session cannot refresh
- **Refresh reuse revokes the family**
- A customer cannot read another customer's order (**and gets 404, not 403**)
- A non-assigned master cannot advance an order
- A suspended master cannot accept, **even with a token issued before suspension**
- OTP rate limits trigger and reset correctly
- Unauthenticated WebSocket upgrade is refused
- Room join is authorized
