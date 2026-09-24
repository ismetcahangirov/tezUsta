# ADR-0043 — The admin panel: roles, credentials, provisioning, disputes and the web app

- **Status:** Accepted
- **Date:** 24 September 2026
- **Context:** EPIC 13, issue #14
- **Supersedes:** nothing. Closes open questions 1, 2, 3 and 5 in
  [`admin-flow.md`](../product/admin-flow.md) and the "still open" line in
  [ADR-0014](ADR-0014-admin-authentication.md) § Consequences. ADR-0014's
  decision — a separate credential path, email + password + mandatory TOTP,
  8-hour refresh, 30-minute idle, httpOnly cookie — is unchanged and is what
  this ADR builds on.

## Context

The admin authorization layer already exists (issue #39): `admin_users`,
`admin_sessions`, the append-only `admin_audit_log`, its own token family, and
a guard that authenticates every route under `/admin` by path. Admin endpoints
for master verification, order overrides, photo reads, call records and review
moderation are live and tested against a fixture admin.

What is missing is everything a human needs to actually use them: a way to
sign in, a way to become an admin, a way to limit what each admin may do, and
the web application itself. EPIC 13 names four product decisions as blockers —
the permission levels, the second-factor supplier, who provisions admins, and
the dispute resolution policy. The owner delegated them. None of them depends
on a vendor contract or on legal advice, so they are made here.

## Decision

### 1. Four roles, many-to-many, permissions fixed in code

An admin holds **one or more** of four roles. A role is a named bundle of
permissions; the bundles live in code (`admin-permissions.ts`), the
assignment lives in the database (`admin_user_roles`).

| Permission         | What it allows                                                     | support | moderator | finance | super_admin |
| ------------------ | ------------------------------------------------------------------ | :-----: | :-------: | :-----: | :---------: |
| `dashboard.read`   | The operational dashboard                                          |    ✓    |     ✓     |    ✓    |      ✓      |
| `orders.read`      | Order list and order detail, including history and photos          |    ✓    |     ✓     |    ✓    |      ✓      |
| `orders.override`  | An admin transition on a live order (never into a dispute outcome) |    ✓    |           |         |      ✓      |
| `disputes.resolve` | `DISPUTED → RESOLVED`                                              |    ✓    |           |    ✓    |      ✓      |
| `disputes.refund`  | `DISPUTED → REFUNDED` (see § 5)                                    |         |           |    ✓    |      ✓      |
| `pii.read`         | Reveal a full phone number                                         |    ✓    |           |         |      ✓      |
| `calls.read`       | Call records                                                       |    ✓    |           |         |      ✓      |
| `masters.read`     | Master list, profile and verification documents                    |    ✓    |     ✓     |         |      ✓      |
| `masters.review`   | Verify, reject, request more                                       |         |     ✓     |         |      ✓      |
| `masters.suspend`  | Suspend and reinstate                                              |         |     ✓     |         |      ✓      |
| `reviews.moderate` | List reviews, remove one, recalculate aggregates                   |         |     ✓     |         |      ✓      |
| `catalogue.manage` | Create, edit, reorder, activate and deactivate the catalogue       |         |           |         |      ✓      |
| `audit.read`       | The audit log                                                      |         |           |         |      ✓      |
| `admins.manage`    | Invite, disable, re-enable, change roles, reset a second factor    |         |           |         |      ✓      |

- **Deny by default.** Every handler under `/admin` declares the permission it
  needs, and a handler that declares none is refused, not allowed. A test walks
  every registered admin route and fails if one is undeclared — the same
  "guarded by construction" argument that made the admin guard key on the path.
- The role set is a Postgres enum: it is a closed set the product decided, the
  opposite of `admin_audit_log.action`, which grows with every feature.
- **Nobody changes their own roles or disables themselves**, and the **last
  active `super_admin` cannot be disabled or demoted**. A panel with no one
  able to manage it can only be repaired from a database shell, which is the
  thing the panel exists to avoid.
- `catalogue.manage` is `super_admin` only at launch. The catalogue is small,
  edits to it are rare and product-shaped, and a wrong price shape is visible
  to every customer at once. When an operations team exists it gets a role in a
  new ADR, not a quiet permission added to `support`.

**Why these four.** They are the four EPIC 13 named, and they split along the
lines where a mistake costs different things: `support` touches live orders
and people's phone numbers, `moderator` touches supply (a master's livelihood)
and reviews, `finance` touches money outcomes, `super_admin` touches the
platform's own shape and the admins themselves. One person can hold several,
which is the realistic case for a small launch team — the permission model
exists so that the first hire who only answers calls does not also get the
power to suspend masters.

### 2. Password + TOTP, implemented on `node:crypto`, no new dependency

- **Password:** `scrypt` from `node:crypto`, N = 2^17, r = 8, p = 1, 16-byte
  salt, 64-byte key — OWASP's minimum for scrypt. Stored as one self-describing
  string (`scrypt$<N>$<r>$<p>$<salt>$<hash>`, base64url) so the parameters can
  be raised later and old hashes still verify, and a sign-in on an old
  parameter set rehashes. Length 12–128, no composition rules (NIST SP 800-63B
  §3.1.1.2). Comparison is constant-time.
- **Second factor:** TOTP per RFC 6238 — HMAC-SHA-1, 6 digits, 30-second step,
  accepting the current step and one either side. SHA-1 and six digits because
  that is what every authenticator app implements; the "stronger" variants are
  silently mis-generated by several of them. A step that has been accepted
  once is **not accepted again** (`last_totp_step`), so a code read over a
  shoulder is dead the moment it is used.
- **The TOTP secret is encrypted at rest** with AES-256-GCM under
  `ADMIN_TOTP_ENCRYPTION_KEY`, a key of its own. A database dump alone must not
  be enough to mint codes.
- **No recovery codes.** An admin who loses their authenticator asks a
  `super_admin` to reset the second factor, which revokes every session of that
  admin and issues a fresh setup link (§ 3). Recovery codes are a second
  credential to store, audit and leak for a population small enough to reset by
  hand. A `super_admin` with nobody left to reset them recovers with
  `admin:bootstrap --reissue <email>` (§ 3), which needs server access — the
  right bar for the most powerful account.
- **Hardware keys (WebAuthn)** are not required at launch. They are the right
  next step for `super_admin` and can be added beside TOTP without changing
  anything above.
- **Why not an identity provider** (ADR-0014's deferred alternative): it would
  put admin availability behind a vendor and a contract nobody has signed, for
  a login used by a handful of people. The password factor can still be
  replaced by one later; nothing here prevents it.

Implementing RFC 6238 and scrypt ourselves is the dependency policy's "a few
lines of our own code": both are thin wrappers over `node:crypto` primitives,
and both are tested against the RFC 6238 Appendix B vectors and a fixed scrypt
vector rather than against themselves.

### 3. Provisioning: invitation by a `super_admin`, bootstrap by a command

- **The first `super_admin`** is created by
  `pnpm --filter api admin:bootstrap --email … --name …`, which refuses to run
  if any active `super_admin` exists. It prints a one-time setup link. With
  `--reissue <email>` it instead resets an existing `super_admin`'s password and
  second factor and prints a new link. Server access is the credential.
- **Every later admin** is invited from the panel by a `super_admin`, with an
  email, a display name and at least one role. The server returns a **setup
  link once**; it is stored only as a SHA-256 hash, expires after **24 hours**,
  and is single-use. The inviter hands it over out of band.
- **The setup page** sets the password and enrols TOTP (a QR code and the
  secret in text), and is complete only when the admin has entered a valid
  code from the new authenticator. **An account without an enrolled second
  factor cannot sign in** — there is no "enrol later".
- **No email is sent.** No email provider is chosen, and a setup link in an
  email is a credential in someone's inbox forever. When a provider exists,
  sending the link is an addition, not a redesign.
- Disabling an admin revokes all their sessions immediately. Nothing is ever
  deleted (`admin-flow.md` non-negotiable 5).

### 4. Sessions: two httpOnly cookies, same origin, no CORS

- Sign-in is **one step**: `email + password + code` in one request. A
  two-step flow creates a half-authenticated state that has to be stored,
  expired and defended; one step has none, and the uniform `401` tells an
  attacker nothing about which factor was wrong.
- Two cookies, both `HttpOnly; Secure; SameSite=Strict; Path=/`: the access
  token (15 minutes) and the refresh token (rotated on every use, reuse of a
  rotated token revokes the whole session — the consumer path's reuse rule).
  The session's 8-hour absolute lifetime and 30-minute idle timeout are
  ADR-0014's and are unchanged.
- **The panel and the API share an origin.** `apps/admin` is served as static
  files and reaches the API through the same host (`/api/*`, proxied); in
  development the Vite dev server proxies. The API enables **no CORS at all**.
- **CSRF:** `SameSite=Strict` plus a required `X-TezUsta-Admin: 1` request
  header on every cookie-authenticated admin request. A cross-site page cannot
  set a custom header without a CORS preflight, and the API answers no
  preflight.
- A bearer `Authorization` header keeps working on `/admin` for tests and
  scripts. It is not a CSRF vector — a browser never attaches one on its own.
- **Rate limits:** admin sign-in has its own policy — 5 failures per email and
  20 per IP per 15 minutes, with the existing backoff. The setup endpoint is
  limited per token and per IP.

### 5. Disputes

- The panel shows a **dispute queue**: every `DISPUTED` order, oldest first.
- A resolver reads the order, its full status history, its photos, the
  conversation transcript and both parties' names and masked phones. Each such
  read is audited.
- `RESOLVED` needs `disputes.resolve` and a reason — it closes the dispute with
  no money movement.
- **`REFUNDED` is refused by the server until EPIC 12 ships a refund
  mechanism**, with the stable code `REFUND_NOT_AVAILABLE`. Recording "refunded"
  when no money moved would make the audit trail state something false, and a
  customer support answer built on it would be a lie. The edge stays in the
  state machine (ADR-0015); only the admin action is withheld, and the
  permission for it already exists so nothing else changes when EPIC 12 lands.
- **There is no dispute deadline for the admin**, but the queue is ordered by
  age and the dashboard counts open disputes, which is what makes a stale one
  visible.

### 6. Audit: before and after, and every personal-data read

`admin_audit_log` gains nullable `before` and `after` JSON columns, filled
wherever an action changes a record (catalogue edits, role changes, status
overrides). Reads of personal data — an order's detail, a revealed phone
number, a transcript — are audited as their own actions. Revealing a phone
number requires a reason. The log stays append-only; the trigger is unchanged.

### 7. The dashboard defines "area" as a 0.02° grid cell

Addresses carry a point and no district. "Unfilled orders by area" therefore
groups by a **0.02° grid cell** (about 2.2 km by 1.8 km in Baku), shown as the
cell's centre and a link to open it on a map. A cell is coarse enough that no
single address can be read back out of it, and it needs no polygon data and no
geocoding call. Named districts replace it when a districts dataset is chosen.
Unfilled means `NO_MASTER_FOUND` and is never counted as a cancellation
(`admin-flow.md` § 6).

### 8. `apps/admin` is a Vite + React SPA

| Concern | Choice                                                        |
| ------- | ------------------------------------------------------------- |
| Build   | Vite 8 (already in the tree for Storybook)                    |
| UI      | React 19.2.3, the version `apps/mobile` pins                  |
| Routing | `react-router@7` (see below)                                  |
| State   | Redux Toolkit + RTK Query (ADR-0017)                          |
| Styling | Tailwind 3.4.17, the repository pin, with the ADR-0011 tokens |
| QR code | `uqr` — zero dependencies, renders an SVG string              |
| Tests   | Vitest + Testing Library + jsdom                              |

- **React Router 7, not 8.** `react-router@8` declares `react >=19.2.7`; the
  repository has exactly one React, 19.2.3, pinned by Expo SDK 57, and the
  hoisted tree cannot hold two. 7.x is maintained on its own dist-tag and
  accepts `react >=18`. Revisit when Expo moves React.
- **An SPA, not Next.js.** The panel is behind a login, has no SEO and no
  public page, and a server runtime would be a second thing to host and patch
  for nothing. Static files behind the same origin as the API is the whole
  deployment.
- **Visual language:** the design system's tokens — Anybody, the lime accent,
  the closed palette, light and dark (ADR-0011) — with a desktop layout: a
  fixed left navigation, a top bar with the admin's name and sign-out, and
  dense tables. The panel targets a laptop screen (≥ 1024 px); it is not
  designed for phones, on purpose (`admin-flow.md` § Why admin is web).
- Contracts that cross HTTP go in `packages/types`, which gains its third
  consumer.

### 9. Out of scope for EPIC 13

- **Reports about a party** ("act on reports about either party"). No
  reporting mechanism exists in either app; building the admin side of a
  feature that has no input would be designing for a guess. It gets its own
  issue when the mobile reporting flow is designed.
- A PII data-retention policy (needs legal input, `admin-flow.md` question 6).

## Alternatives considered

| Option                                         | Why not                                                                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A single role with every permission            | The first support hire could suspend masters and rewrite the catalogue. The permission check is cheap to build now and expensive to retrofit once people rely on "everyone can do everything". |
| Permissions stored per admin, no roles         | Every new admin becomes a checklist of fourteen boxes, and two admins in the same job drift apart. Roles are the unit people actually reason about.                                            |
| `argon2` for passwords                         | A native addon on every developer machine and CI image for a login used by a handful of people; scrypt from `node:crypto` is an OWASP-listed choice with no install.                           |
| `otplib` / `speakeasy` for TOTP                | RFC 6238 is thirty lines over `createHmac`; `speakeasy` is unmaintained and `otplib` brings a plugin system we would not use.                                                                  |
| Recovery codes                                 | A second credential to store and leak for a population that a `super_admin` can reset by hand in a minute.                                                                                     |
| Two-step sign-in (password, then code)         | A half-authenticated state to persist and defend, and a response that tells an attacker the password was right.                                                                                |
| CORS with credentials to a separate API origin | Every CORS misconfiguration is a credentialed cross-origin read. Same origin removes the class.                                                                                                |
| Next.js for the panel                          | A server runtime to host and patch for an internal tool with no public page.                                                                                                                   |
| Send the setup link by email                   | No provider is chosen, and it leaves a live credential in an inbox.                                                                                                                            |
| Allow `REFUNDED` now as a status only          | Records a refund that did not happen.                                                                                                                                                          |

## Trade-offs accepted

- **We own two small crypto wrappers.** They are tested against published
  vectors, and a mistake in them is the kind the tests catch; the alternative
  was a dependency whose mistakes we would not see.
- **A lost authenticator needs a human.** Acceptable for a handful of staff; it
  is the reason every `super_admin` action is audited and why there should be
  at least two of them.
- **Grid cells are less readable than district names.** They are honest about
  what the data holds today.
- **The panel is desktop-only.** An admin on call reaches for a laptop.

## Consequences

- One migration adds `admin_user_roles`, the password and TOTP columns on
  `admin_users`, `admin_invitations`, `admin_refresh_tokens`, and `before` /
  `after` on `admin_audit_log`.
- Every existing admin handler gains a permission; the fixture admin in tests
  becomes a `super_admin` unless a test asks for less.
- New environment: `ADMIN_TOTP_ENCRYPTION_KEY`, `ADMIN_SETUP_LINK_BASE_URL`.
- `apps/admin` joins the workspace, the dependency-cruiser rules and CI.
- `admin-flow.md`, `authentication.md`, `security.md` and CLAUDE.md's decision
  table are updated in the same PR as this ADR.

## Revisit when

- An operations team exists that needs catalogue access without `super_admin`.
- A payment provider exists (EPIC 12) — enable `REFUNDED`.
- A districts dataset is chosen — replace grid cells.
- Expo moves to React ≥ 19.2.7 — `react-router@8` becomes possible.
- The admin population grows past what a `super_admin` can reset by hand —
  reconsider recovery codes or WebAuthn.
