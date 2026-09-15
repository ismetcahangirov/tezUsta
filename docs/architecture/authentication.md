# Authentication and authorization

> **For customers and masters, sign-in is phone number + SMS OTP, and there is
> no other sign-in path** ([ADR-0008](../decisions/ADR-0008-otp-delivery.md)).
> The SMS provider is still open, and it blocks EPIC 2 — nothing can be signed
> into without it.
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

**Shipping order.** The `admin` role, its permission checks, and the guard that
enforces them ship in **EPIC 2** — every module depends on them, and deferring
them to EPIC 13 would close a dependency cycle on itself. Admin credential
issuance, the session policy above, and `apps/admin` ship in **EPIC 13**. Until
then admin-only endpoints exist, are guarded, and are tested against a fixture
admin, but no production admin credential is issued.

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
