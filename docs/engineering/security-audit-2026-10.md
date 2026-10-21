# Security audit — October 2026 (delta)

This is a delta review under EPIC 15 (#16), issue #391. It was done on 19 October 2026 against `main` at `2b9613a`.

It covers what the [September audit](security-audit-2026-09.md) could not: the 58 commits since `5869249`, which added or changed 13 controllers:

- the portfolio and public profile (EPIC 19)
- the master's avatar
- reports about a party (#330)
- admin customer accounts (#328)
- admin password change and reset (#329)
- portfolio moderation
- the subscription (EPIC 14)

The September page is still where a full audit starts. This page adds only what changed.

## Scope and method

The method is September's:

- every handler traced into the SQL predicate, or the explicit comparison, that binds the resource to the caller;
- admin handlers checked against ADR-0043: a permission on every handler, every action audited, every personal-data read audited.

| Area         | What was checked                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership    | `portfolio`, `public-profile`, `master-avatar`, `reports`, `master-subscription`, `subscriptions`                                                                                                                 |
| Admin        | `admin-customers`, `admin-reports`, `admin-accounts`, `admin-identity`, `admin-portfolio`, `admin-dashboard`, `admin-subscription`                                                                                |
| Public paths | Every `@Public()` and `@PublicAdminRoute()` handler. None was added or removed since `5869249`                                                                                                                    |
| Rate limits  | The four new policies: `report-submit` 20/60, `portfolio-upload` 120/240, `portfolio-write` 120/240, `profile-read` 300/600. The two numbers are per user and per IP per hour. All are keyed on the verified user |
| Logging      | Every logger call added since `5869249`                                                                                                                                                                           |
| Secrets      | The full history of every branch (`git log --all -p`) against key, token and private-key patterns, plus every `.pem`, `.key`, `.p12` or `.env` file ever added                                                    |
| Dependencies | `pnpm audit`                                                                                                                                                                                                      |

## Findings

No Critical, High or Medium finding. All four Low findings are fixed in #391, and each fix has a test that fails against the old code.

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                              | Fix  |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Low      | The cursor of a master's own post list was not bound to the master. A cursor naming another master's post returned the caller's older posts instead of an empty page, which told the caller whether that id exists in any status, draft and removed included. Ids are UUIDv7, so this needs an id already in hand                                    | #391 |
| 2   | Low      | An admin grant checked the master's verification status before its transaction. A rejection that committed in between still let days be granted to a master ADR-0047 § 3 says must be refused. The check now runs inside the grant's transaction, under a share lock on the master row                                                               | #391 |
| 3   | Low      | Closing a report as `master_suspended` or `customer_suspended` checked the suspension before its transaction. A reinstatement that committed in between left a closed report, and an audit row, claiming a suspension that had ended. The check now runs inside the close's transaction, under a share lock                                          | #391 |
| 4   | Low      | When cancelling a suspended customer's searching orders failed, the log line wrote `String(error)`. A Drizzle error's message includes its bound parameters. The line now goes through `describeDatabaseFailure`, as `AllExceptionsFilter` does. The parameters of that call are ids, statuses and a constant reason, so no PII was expected to leak | #391 |

Fixes 2 and 3 take the master or user row lock before the subscription's advisory lock. Verification approval takes them in the same order (`startTrial`), so the two cannot deadlock.

Nothing is deployed yet (EPIC 17), so none of these was ever exposed to real users.

## What was checked and found sound

- **Portfolio and avatar:**
  - The caller's master is always found from `actor.userId`. No route takes a master id from the client.
  - A media id is bound to its post, and the post to the caller.
  - Storage keys are made by the server and read back from the caller's row, so nobody can confirm an upload into someone else's key.
  - "Not yours" answers the same `404` as "does not exist".
- **Public profile:**
  - The ADR-0045 § 2 rule holds on both routes.
  - Drafts, processing, failed, deleted and removed posts are never served, and neither are photos that are not `ready`.
  - A suspended, unverified or deleted master answers the same `404` as a missing one.
  - The response is built from an allow-list: no phone, location, storage key or presigned URL.
- **Reports:**
  - Only a party to the order can report, and only about the other party.
  - A master cannot name another master, and a customer can name only a master who accepted the order.
  - There is one report per pairing, enforced by a unique index.
  - Nobody can read a report about themselves.
- **Admin customers:**
  - Lists show masked phones. The full number comes only from `pii.read`, with a reason, audited before it is returned.
  - Search patterns are escaped and parameterised.
  - A suspension revokes the customer's sessions in the same transaction as its audit row.
- **Admin password reset:**
  - The token is 256 bits, stored only as its SHA-256, single use and valid for 24 hours.
  - It is bound to the target admin, and redeeming it needs that admin's TOTP.
  - It sits in the URL fragment, so it never reaches a server log.
  - Only `super_admin` holds `admins.manage`, and nobody can reset their own password through it.
  - Every session is revoked on reset and on a password change.
- **Subscriptions:**
  - A master can only read their own subscription, and has no write route.
  - Every admin write declares its permission, has a strict body with a required reason, and writes a before/after audit row in the same transaction.
  - No payment webhook exists yet (#323).
- **Secrets:** none ever committed. Every hit was a test fixture or a documented local-development value: the RFC TOTP example secret, the LiveKit dev pair, test passwords and a 26-character Maps key sentinel.
- **Logging:** no new log line writes a phone number, token, OTP code, coordinate, message or report body, or password.
- **`pnpm audit`:** 0 high. The two unpatched high advisories stay ignored with their reasons in `pnpm-workspace.yaml`. Five moderate advisories:
  - `esbuild`, `uuid` and `decode-uri-component`, for the reasons the September page gives;
  - `sprintf-js`, which is only in Jest's coverage tooling;
  - `postcss-selector-parser`, which arrives through Tailwind 3 and NativeWind and runs at build time on this repository's own CSS.

## Accepted, with reasons

| Item                                                                             | Why it stays                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portfolio and avatar routes carry no `@Roles('master')`                          | The master row is found from `actor.userId`, so a customer reaches nothing. Customers get the stable `PORTFOLIO_MASTER_NOT_ACTIVE`, which the e2e tests pin. Adding the role would change that contract and close no hole                                                   |
| Reading a removed portfolio post's evidence is not audited                       | The photos were published by the master themselves, so they are not a third party's personal data revealed by the read. Removal is audited (`portfolio_post.remove`). Revisit if ADR-0045's content rules (an open owner decision) classify home interiors as personal data |
| Inviting an admin and claiming a report carry no reason                          | Both are audited with who and when. An invitation is itself the reason, and a claim only says "I am handling this". A reason is required wherever an admin changes someone else's state                                                                                     |
| Admin role changes replace rows in `admin_user_roles`                            | The audit row keeps before and after, so history is not lost                                                                                                                                                                                                                |
| A `super_admin` can reset another `super_admin`'s second factor                  | Within ADR-0043 and audited. A two-person rule is worth adding when there is more than a handful of super admins                                                                                                                                                            |
| The dashboard's availability grid can show a cell with one master                | ADR-0043 § 7 accepts the grid: a cell is about 2 km and only admins see it. A minimum count per cell is a product choice                                                                                                                                                    |
| A phone search that finds nobody is neither audited nor rate-limited             | Only `customers.read` holders can search, and every hit is audited. Auditing misses would add a row for every typo                                                                                                                                                          |
| A media job can finish for a master suspended while it ran                       | Nothing is shown while they are suspended (`findShownMaster`). ADR-0045 § 6 keeps a suspended master's content for their reinstatement                                                                                                                                      |
| The public profile may answer a shown master one query slower than a missing one | Not measured. It is bounded by `profile-read` (300 per hour) and by unguessable UUIDv7 ids                                                                                                                                                                                  |
| The subscription routes have no `@RateLimit`                                     | They are authenticated, cheap reads or admin-only writes                                                                                                                                                                                                                    |

## Billing delta — 21 October 2026 (#424)

CLAUDE.md § 1 says a second audit is due once subscription billing exists. Billing landed on 21 October:

- #415: the provider port, the checkout, the signed webhook and reconciliation (ADR-0057);
- #417: auto-renewal on a saved card (ADR-0058).

This section reviews them, together with everything else merged since `2b9613a`:

- the address pre-fill (#413);
- the "master nearby" push (#414);
- `vite` 8.3.3 (#418).

It was done against `main` at `55e8c81`. The method is the one above.

### Billing findings

No Critical or High finding. Every finding is fixed in #424, and each fix has a test that fails against the old code.

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fix  |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 5   | Medium   | **A precise coordinate could reach a log line.** A Drizzle query error's message includes its bound parameters (`Failed query: … params: …`). `MasterLocationRegistry` and `OrderSearchWavesRegistry` logged `error.message` when a listener failed, and their listeners' queries are bound to points: the master's reported position (#414) and the order's address (#397, the radar). A database failure on either path wrote the point to the log, against CLAUDE.md § 11. Both now log through `describeDatabaseFailure`, which keeps the statement and drops the parameters, as finding 4 does | #424 |
| 6   | Medium   | **A card could be charged against the master's latest choice.** A master who saved a card on one purchase and then paid by hand with auto-renewal unticked kept the old card live, so the next period was charged anyway. A hosted payment that buys a period without consent now revokes the live card: the latest purchase decides                                                                                                                                                                                                                                                                | #424 |
| 7   | Low      | **Saved-card tokens were stored in plaintext.** The token is useless without the merchant credentials, but a database dump plus a leaked credential would be enough to charge cards. Tokens are now sealed with AES-256-GCM under `BILLING_TOKEN_ENCRYPTION_KEY`, with the row's id as context, as ADR-0043 § 2 does for TOTP secrets. `SecretBox` moved to `common/crypto/` so both modules use one implementation. Production refuses to start without the key. The stub uses a key generated per process, and a token that cannot be opened is never charged                                     | #424 |
| 8   | Low      | **`BILLING_RETURN_URL` accepted `http://`.** The checkout's return page is now `https` only, refused at boot like any other bad setting                                                                                                                                                                                                                                                                                                                                                                                                                                                             | #424 |

Nothing is deployed yet (EPIC 17), so none of these was ever exposed to real users.

### Billing: checked and found sound

- **Checkout** (`POST /masters/me/subscription/checkout`):
  - The master is found from `actor.userId`, and verification is checked.
  - `.strict()` refuses `amountMinor` and `priceId`. The amount and price version come from `subscription_prices` on the server, and are recorded on the checkout.
  - Every refusal happens before the provider is called: purchases closed, no price, or a period already queued.
  - A reused checkout is the caller's own, under a per-master advisory lock.
  - The endpoint is rate-limited per verified user (`subscription-checkout`, 20 per user and 60 per IP per hour).
- **Webhook** (`POST /webhooks/billing/:provider`):
  - The signature is HMAC-SHA256 over the exact bytes, compared with `timingSafeEqual`, before any database read.
  - The body is captured for that one URL and capped at 64 KiB, by declared length and while streaming.
  - Any failed check gets the same 401. A provider other than the configured one gets 404.
  - It is idempotent on `(provider, provider_event_id)`, enforced by a unique index, and on the payment reference in `subscription_events`. Concurrent duplicates leave one row and one period.
  - The amount and currency are checked against the checkout before anything is activated.
  - Activation uses the checkout's recorded price, not the current one.
  - A refund or a failure moves nothing.
- **Auto-renewal:**
  - It charges once per period: a unique `(master, renews_period_end)`, checked under the lock, with the row id as the idempotency key.
  - There is no charge for a trial, a period in grace, a cancelled subscription, a suspended master, a card saved before a cancellation, or a changed price without its #326 notice.
  - `GET` on the auto-renewal route returns only `{ enabled }`.
  - The opt-out is idempotent and rate-limited.
  - The `subscription_payment_methods` trigger allows only a single revoke.
- **Stored payment data:** no card number, expiry, CVV or fragment exists anywhere. The token is never logged or returned.
- **Reconciliation:** read-only, logs counts only, corrects nothing.
- **#413:** the coordinate goes to `/geocode/reverse` and the saved address only. The mobile code logs nothing.
- **#414:** the payload carries `orderId` and the status only. The position-path read is one probe of `orders_one_active_per_master`, pinned by a plan probe.
- **Logging:** every logger call added since `2b9613a` was checked. The billing lines name the provider, the event kind, our own checkout id and counts. None writes a body, a token, a reference, an amount or a master.
- **Secrets:** `git log --all -p 2b9613a..` and the added files were checked. Every hit is a test fixture (an invalid Google-key sentinel, an admin setup-link token, the RFC TOTP example), and no secret file was added.
- **`pnpm audit`:** 0 high after #418 (`vite` 8.3.3). The two ignored highs and five moderates are as above.

### Billing: accepted, with reasons

| Item                                                                                                  | Why it stays                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The webhook has no timestamp replay window                                                            | The stub signs no timestamp. A replayed delivery is a no-op: the event id is unique, and the payment reference buys one period at most, so replaying cannot change state. A real adapter whose provider signs a timestamp checks it, in that adapter's ADR |
| A provider name other than the configured one gets 404, so the URL shows which provider is configured | The candidates are named in the repository and in the ADRs. The answer reveals nothing the code does not                                                                                                                                                   |
| Turning auto-renewal off does not stop a charge already started at the provider                       | That charge's success activates a period the master paid for. Its failure moves nothing                                                                                                                                                                    |
| The webhook has no rate limit                                                                         | The LiveKit webhook's reason: what a forger can spend is one HMAC over at most 64 KiB, before any read                                                                                                                                                     |
| The checkout transaction stays open across the provider call                                          | The rate limit bounds it. A real adapter adds a timeout (ADR-0057)                                                                                                                                                                                         |

## Still owed by EPIC 15

- Rate limits tuned against real traffic (EPIC 17).
- When a real billing provider is chosen, its adapter's ADR must cover:
  - the webhook's signature scheme and replay window;
  - its body format;
  - its call timeouts.

The webhook items the September and October pages listed are now in place (#424 § Billing delta):

- an HMAC signature compared with `timingSafeEqual`;
- a raw-body capture;
- idempotency.
