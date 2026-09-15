# ADR-0014 — Admin authentication is a separate credential path

- **Status:** **Accepted** (second-factor provider pending)
- **Date:** 2026-09-15
- **Amends:** the scope of [ADR-0008](ADR-0008-otp-delivery.md). ADR-0008's
  decision is unchanged for customers and masters; this ADR states that it was
  never a statement about admin accounts.

## Context

[ADR-0008](ADR-0008-otp-delivery.md) says: "Sign-in is phone number + SMS OTP.
There is no other sign-in path," and "Do not build a second sign-in path. One
authentication vector, not two." `CLAUDE.md` repeats it without qualification.

`docs/product/admin-flow.md` says the admin panel is a separate web
application with its own authentication and its own session policy, and
expects a second factor.

Read literally, the two cannot both be true and the admin panel cannot exist.
ADR-0008's Context is scoped to customers and masters, but its Decision is
written absolutely, and `CLAUDE.md` is the higher-priority document. A rule
that forbids something the product requires gets ignored, and a rule that gets
ignored stops protecting anything — so the scope has to be written down rather
than inferred.

## Decision

**ADR-0008 governs customer and master accounts. Admin accounts use a
separate credential path, on a separate application, with no account overlap.**

|                   | Customer / master                        | Admin                                               |
| ----------------- | ---------------------------------------- | --------------------------------------------------- |
| Application       | `apps/mobile`                            | `apps/admin` (web)                                  |
| Credential        | Phone + SMS OTP                          | Email + password + mandatory TOTP second factor     |
| Account store     | `users`                                  | `admin_users` — a distinct table                    |
| Self-registration | Yes                                      | **No.** Admins are provisioned by an existing admin |
| Session lifetime  | Access 15 min / refresh 30 days, rotated | Access 15 min / refresh **8 hours**, rotated        |
| Idle timeout      | None                                     | 30 minutes                                          |
| Token storage     | `expo-secure-store`                      | httpOnly, `Secure`, `SameSite=Strict` cookie        |

Rules:

1. **One human, two accounts.** An admin who is also a customer has an
   `admin_users` row and a separate `users` row. Nothing links them, and an
   admin session never grants customer or master capability.
2. **An admin credential cannot sign in to the mobile app, and a phone OTP
   cannot sign in to the admin panel.** The two paths do not share an issuer,
   an audience claim, or a refresh family.
3. **Admin authorization lives in the shared authorization layer and ships with
   EPIC 2**, not EPIC 13. The `admin` role, its permission checks, and the
   guard that enforces them are part of the authorization work every module
   depends on.
4. **Admin credential issuance, the session policy above, and `apps/admin`
   ship in EPIC 13.** Until then, admin-only endpoints exist, are guarded, and
   are covered by tests, but no production admin credential is issued.
5. **Every admin action writes an audit record** — actor, action, target,
   reason, timestamp — including reads of personal data. This is stricter than
   the customer and master paths, and deliberately so.

## Why

**The threat models are not comparable.** A customer account can create an
order. An admin account can suspend a master, resolve a dispute, and read
personal data across the whole platform. Binding that to an SMS OTP makes SIM
swap a platform-wide compromise rather than a single-account one, in a market
where SIM swap is the realistic attack on phone-based sign-in — a weakness
ADR-0008 itself records.

**"One authentication vector" was a statement about the consumer surface.** Its
purpose was to stop a second consumer-facing sign-in path appearing beside OTP,
because two paths means two sets of recovery flows, two attack surfaces, and a
weakest link. An internal tool on a different application with a different
account store is not that.

**Deferring admin authorization to EPIC 13 creates a dependency cycle.** EPIC
3, EPIC 5 and EPIC 8 each ship admin endpoints. If the admin role does not
exist until EPIC 13, and EPIC 13 depends on 5 and 8, the graph closes on
itself. Putting the role and the guard in EPIC 2 and the credentials in EPIC 13
breaks it.

**Cookies rather than a bearer token, for the web app only.** The admin panel
is a browser application, where an httpOnly cookie removes the XSS token-theft
path that `localStorage` would open. The mobile app has no such option and
keeps `expo-secure-store`.

## Alternatives considered

**Phone + OTP for admins too, for literal consistency with ADR-0008.**
Rejected: it makes the highest-privilege account the one protected by the
weakest factor.

**Reuse the `users` table with an `is_admin` flag.** Rejected: a privilege
escalation bug becomes a total compromise, and it makes "an admin cannot sign
in with a phone" impossible to enforce structurally rather than by a check
somebody can forget.

**An external identity provider (Google Workspace, Auth0) for admins.**
Genuinely attractive: it removes password storage and brings MFA and
provisioning for free. Deferred rather than rejected — it is a vendor choice
with a cost and an availability dependency, and it can replace the password
factor later without changing anything else in this ADR. Revisit when EPIC 13
is scheduled.

**No second factor at launch.** Rejected: the audit trail an admin panel
produces is only as trustworthy as the weakest admin credential.

## Consequences

- `admin_users` is a distinct table with its own session table.
- The authorization layer in EPIC 2 carries an `admin` role from the start,
  even though no credential issues it until EPIC 13.
- Admin endpoints written in EPIC 3, 5 and 8 are testable immediately, against
  a fixture admin.
- The security documentation gains an admin section; the rate-limit table gains
  admin sign-in.
- **Still open:** which TOTP library or identity provider supplies the second
  factor, and whether admin accounts require hardware keys for the highest
  privileges. Neither blocks EPIC 2, 3, 5 or 8.
