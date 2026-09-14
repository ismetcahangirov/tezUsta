# Authentication and authorization

> Sign-in **method** (phone/OTP vs email vs social) is an open product decision —
> [ADR-0008](../decisions/ADR-0008-otp-delivery.md). Everything below is the
> token and authorization architecture, which holds regardless of that choice.

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

## Sessions and devices

| Operation             | Effect                              |
| --------------------- | ----------------------------------- |
| Sign out              | Revoke this session's refresh token |
| Sign out everywhere   | Revoke all of the user's sessions   |
| Password/phone change | Revoke all sessions                 |
| Suspension by admin   | Revoke all sessions                 |
| Reuse detected        | Revoke the whole family             |

Access tokens already issued remain valid until they expire — at most 15 minutes.
Where an action must take effect immediately (an admin suspending a master mid-
order), the **authorization check re-reads current status from the database**, so
the stale token still fails.

## Authorization

Three layers. Only the last two are security.

### 1. Client route guards — **not security**

The app hides what a role cannot use. This is UX. It is trivially bypassed by
anyone talking to the API directly.

### 2. Server guards — authentication and role

Verify the signature, expiry, and that the session is not revoked.

### 3. Server ownership checks — the real control

**Being authenticated is not being entitled.**

`GET /orders/:id` must confirm that the caller is that order's customer, its
assigned master, or an admin. Without this, any authenticated user enumerates
every order in the system — including live home addresses.

```ts
// Every resource handler answers this, not just "is there a valid token".
const order = await orders.findById(id);
if (!order) throw new NotFoundError();
if (!canView(actor, order)) throw new NotFoundError(); // 404, not 403 — see below
```

**A 403 on someone else's order id confirms the order exists.** Return 404 for
"not yours" so the API is not an existence oracle.

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

| Endpoint    | Limit                                  |
| ----------- | -------------------------------------- |
| OTP request | Per phone **and** per IP, with backoff |
| OTP verify  | 5 attempts per code, then invalidate   |
| Refresh     | Per session                            |
| Sign-in     | Per identifier and per IP              |

Responses must be **identical for known and unknown identifiers**, or the
endpoint becomes a user-enumeration oracle.

Details: [ADR-0008](../decisions/ADR-0008-otp-delivery.md),
[`../engineering/security.md`](../engineering/security.md).

## Admin authentication

Separate and stronger:

- Its own surface (`apps/admin`), never a role flag on a customer endpoint
- Shorter sessions
- MFA expected (**OPEN** — confirm with the owner)
- Every privileged action audit-logged with actor and reason

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
