# Security audit — September 2026

The first whole-system review under EPIC 15 (#16). It was done on 25 September
2026 against `main` at `5869249`, after EPIC 8's state machine and EPIC 13's
admin panel had landed, which EPIC 15 names as the point where a full audit is
meaningful.

This page records **what was checked, what was found and what was deliberately
accepted**. Most of the fixes live in their own issues. The page says which
issue fixes each finding, so the next audit can start from here instead of
starting over.

## Scope and method

| Area              | How it was checked                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ownership (IDOR)  | Every handler in all 36 controllers and every WebSocket frame, traced into the SQL predicate or explicit comparison that binds the resource to the caller          |
| Guard chain       | The global guard order in `app.module.ts`, `@Public()` opt-outs, admin route classification, and the LiveKit webhook signature                                     |
| Marketplace abuse | The vectors in [security.md § Rate limiting and abuse](security.md#rate-limiting-and-abuse): OTP cost, fake orders, reviews, accept-then-cancel, location spoofing |
| Rate limiting     | Every `@RateLimit` policy, its values, its Redis backing, and what it keys on                                                                                      |
| Secrets           | The full history of every branch (`git log --all -p`) against key, token and private-key patterns, plus every file ever added that looks like a credential         |
| Logging           | Every logger call in `apps/api/src`, checked for tokens, OTP codes, phone numbers, coordinates, message bodies and credentials                                     |
| Retention         | Every table holding PII or ephemeral secrets, checked against the jobs that age it out                                                                             |
| Dependencies      | `pnpm audit`                                                                                                                                                       |

## Findings

| #   | Severity | Finding                                                                                                                                     | Fix  |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Critical | The admin surface was decided from the raw URL, so a non-canonical spelling of an admin path could run an admin list handler for a consumer | #269 |
| 2   | High     | An assigned master could keep reading the customer's exact address after the order ended                                                    | #270 |
| 3   | High     | No platform-wide ceiling on OTP SMS sends. Per-phone and per-IP limits do not stop a distributed attacker                                   | #272 |
| 4   | High     | No cap on how many orders a customer holds open at once, so one account could flood nearby masters                                          | #273 |
| 5   | High     | Master position reports were range-checked but not checked for plausibility, so a master could teleport to appear near every order          | #274 |
| 6   | High     | Two tables grew forever: `otp_challenges` (phone numbers) and admin sessions                                                                | #276 |
| 7   | Medium   | A per-account rate-limit bucket was chosen from an **unverified** token, so a forged token could spend someone else's budget                | #271 |
| 8   | Medium   | No security response headers, an implicit body limit, and nothing to stop a future unsafe `trustProxy`                                      | #275 |

Nothing is deployed yet (EPIC 17), so none of these was ever exposed to real
users.

## What was checked and found sound

- **Ownership:** every consumer handler binds the resource to the caller in SQL
  or in an explicit comparison, and "not yours" answers the same `404` as "does
  not exist". WebSocket room joins are authorised per order and per master.
- **Reviews:** a unique constraint, a composite foreign key onto the order's
  parties, re-authorisation inside the write, and blind reveal (ADR-0042).
- **Order creation:** idempotent on `(customer_id, idempotency_key)` (ADR-0015).
- **Rate limiter:** Redis-backed, atomic, subjects HMAC-keyed, and not
  spoofable through `X-Forwarded-For`, because `trustProxy` is off.
- **OTP:** only `+994` numbers are accepted, codes are HMAC-hashed and never
  logged, and phone numbers are masked in logs.
- **Secrets:** no real secret has ever been committed on any branch. The one
  real-looking value in `.env.example`, the LiveKit pair, is LiveKit's
  local-development credential for `ws://localhost:7880`.
- **Logging:** no token, OTP code, full phone number, coordinate, message body
  or credential reaches a log line. Database errors are redacted by
  `AllExceptionsFilter`.
- **Location retention:** the trail is pruned on the write path, and a sweep
  covers masters who stopped reporting (#98, #105).

## Accepted, with reasons

| Item                                                                                         | Why it stays                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm audit`: 3 moderate, 0 high                                                             | `esbuild` is inside `drizzle-kit`'s loader and `uuid` inside Expo's `xcode` build tool. Neither ships in the API or the app. `decode-uri-component@0.2.2` does ship, via `expo-router` → `query-string@7`, but the patched line is a new minor that `query-string`'s `^0.2.2` does not accept, and forcing it could break route parsing. Revisit on the next Expo SDK bump. CI still gates on **high**. |
| A master who repeatedly accepts and then re-dispatches                                       | Each order is capped at `MAX_ORDER_REDISPATCHES`, but nothing yet counts it **per master**. The penalty is the cancellation policy, which is an open owner decision (CLAUDE.md §1). Building a penalty before that decision would be inventing it.                                                                                                                                                      |
| Suspending a customer                                                                        | There is no admin action yet, only the master one. The runbook gives the SQL, and `ActorService` enforces `users.status` on every request. It becomes an admin screen when there is a reason to build one.                                                                                                                                                                                              |
| WebSocket frame budget is per connection, and call invites share it                          | Bounded at 10 frames/s with a burst of 20, and the number of connections is capped. A dedicated per-account ring budget is worth adding if nuisance ringing is reported.                                                                                                                                                                                                                                |
| A socket joined before logout can keep joining rooms of its own orders                       | Bounded by the 15-minute access token. Call frames already re-validate the actor.                                                                                                                                                                                                                                                                                                                       |
| The assigned master keeps problem photos and the read-only conversation after the order ends | Dispute evidence (ADR-0033). The exact address is not kept (#270).                                                                                                                                                                                                                                                                                                                                      |

## Still owed by EPIC 15

- **Rate limits under real traffic:** the limits have been checked for
  correctness and atomicity, but tuning them needs production traffic
  (EPIC 17).
- **A second audit** once payments (EPIC 12) exist, since money changes the
  threat model more than anything built so far.
