# Security

Security is a first-class requirement from the first line of code, not EPIC 15.
EPIC 15 hardens and audits; it does not introduce security.

TezUsta sends a stranger to someone's home and moves money. The consequences of
a failure here are physical, not just financial.

## Non-negotiables

| Rule                                                                        | Why                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------- |
| Validate **all** input at the API boundary with Zod                         | The client is untrusted, always                    |
| Authorize **server-side, per request**                                      | A client role check is a UX affordance             |
| Ownership checks on every resource read                                     | Authenticated ≠ entitled                           |
| Parameterised queries only (Drizzle builder)                                | Never string-concatenated SQL                      |
| Tokens in `expo-secure-store`                                               | `AsyncStorage` is plaintext                        |
| Rate-limit auth, OTP, order creation, reviews                               | Abuse and cost control                             |
| Never log tokens, OTP codes, full phone numbers, coordinates                | Logs have a wider audience than expected           |
| Errors never leak internals                                                 | No stack traces, SQL, or infrastructure detail     |
| Nothing that grants server authority or billing power behind `EXPO_PUBLIC_` | That prefix ships in the app bundle                |
| Every environment variable validated once, at process start                 | A missing secret must fail the boot, not a request |

## Never commit

```
.env            API keys       private keys
tokens          passwords      production credentials
google-services.json           GoogleService-Info.plist
*.keystore  *.jks  *.p8  *.p12
```

`.gitignore` covers these. **If a secret is ever committed, rotate it.** Removing
it from history does not un-leak it — the repository is public, and the value
must be assumed compromised from the moment of the push.

Use `.env.example` with placeholders for documentation.

### `EXPO_PUBLIC_` and what counts as a secret

Anything prefixed `EXPO_PUBLIC_` is embedded in the shipped app bundle and is
readable by anyone who unzips the APK. Treat every such value as published.

**A value is a secret if it grants server authority or billing power.** Those
never carry `EXPO_PUBLIC_` — `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`DATABASE_URL`, `S3_SECRET_ACCESS_KEY`, `SMS_API_KEY`, and the billable
`GOOGLE_MAPS_SERVER_API_KEY` belong to the API process alone.

**Platform-restricted client map keys are the one documented exception.**
`EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY` and
`EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY` ship in the bundle because the client
cannot render a map without them. They are restricted by bundle id / package
name and scoped to the Maps SDK, and it is the **restriction**, not the secrecy,
that protects them: the same key sent from another application is refused
([ADR-0004](../decisions/ADR-0004-location-and-maps.md)).

So a new `EXPO_PUBLIC_` variable has to satisfy one of two conditions: it grants
nothing on its own, or it is platform-restricted and scoped to the one API it
needs. If neither holds, it is a secret and the prefix is wrong.

## Environment validation

`.env.example` lists the variables. It is not the contract — the contract is a
**single schema, parsed once at process start**.

- **One schema, and it is the only reader of `process.env`.** A second reader is
  a variable nobody validated, and it is discovered in production.
- **Fail fast: a missing or malformed variable refuses the boot.** A process that
  starts with `JWT_ACCESS_SECRET` undefined and finds out on the first sign-in
  has converted a configuration error into an outage with a delay.
- **Validate ranges, not just presence.** `OTP_TTL_SECONDS=0` and
  `DISPATCH_MAX_RADIUS_M=1` are both well-formed strings and both wrong.
- **Never log a value.** Report the **name** of the variable that failed; an
  error message quoting a malformed secret publishes it to the log.
- Downstream code takes the typed, frozen config object, so a mistyped variable
  name is a compile error rather than an `undefined` that ships.

Per [ADR-0016](../decisions/ADR-0016-shared-package-timing.md) this schema lives
in `apps/api/src/infra/config/` while the API is its only consumer, and moves to
`packages/config` when a second workspace needs it. `apps/mobile` validates its
`EXPO_PUBLIC_*` values by the same rules at app start.

## Authentication and session security

Full design: [`../architecture/authentication.md`](../architecture/authentication.md).

- 15-minute access tokens; 30-day refresh tokens rotated on every use.
- **Refresh reuse detection** revokes the whole session family — this converts a
  stolen token from permanent access into a short window plus an alarm.
- Refresh tokens hashed at rest.
- Role claims re-checked against the database on every authorization decision; a
  token issued before suspension must not still work.
- Identical responses for known and unknown identifiers, or the endpoint becomes
  a user-enumeration oracle.

The rows above describe the consumer path: phone + SMS OTP, tokens in
`expo-secure-store`. That path is unchanged.

### Admin accounts use a separate credential path

[ADR-0014](../decisions/ADR-0014-admin-authentication.md) scopes
[ADR-0008](../decisions/ADR-0008-otp-delivery.md) to customers and masters. An
admin can suspend a master, resolve a dispute, and read personal data across the
whole platform, so binding that to an SMS OTP would make SIM swap a
platform-wide compromise rather than a single-account one.

|                   | Customer / master   | Admin                                               |
| ----------------- | ------------------- | --------------------------------------------------- |
| Application       | `apps/mobile`       | `apps/admin` (web, planned — EPIC 13)               |
| Credential        | Phone + SMS OTP     | Email + password + **mandatory TOTP** second factor |
| Account store     | `users`             | `admin_users` — a distinct table                    |
| Self-registration | Yes                 | **No.** Provisioned by an existing admin            |
| Refresh lifetime  | 30 days, rotated    | **8 hours**, rotated                                |
| Idle timeout      | None                | **30 minutes**                                      |
| Token storage     | `expo-secure-store` | httpOnly, `Secure`, `SameSite=Strict` cookie        |

- **No account overlap.** An admin who is also a customer holds two unlinked
  accounts. The two paths share no issuer, no audience claim, and no refresh
  family, so an admin credential cannot sign in to the mobile app and a phone OTP
  cannot sign in to the admin panel.
- **A cookie rather than a bearer token, for the web app only.** The admin panel
  is a browser application, where an httpOnly cookie removes the XSS token-theft
  path `localStorage` would open. The mobile app has no equivalent and keeps
  `expo-secure-store`.
- **Every admin action is audited** — actor, action, target, reason, timestamp —
  **including reads of personal data.** This is stricter than the consumer paths
  on purpose: an audit trail is only as trustworthy as the weakest admin
  credential and the least-logged admin action.

## Input validation

Zod at every boundary, including WebSocket messages. Nothing reaches a service
unvalidated.

- Reject unknown fields (strict schemas) — mass-assignment protection.
- Bound every string, array, and number. An unbounded text field is a
  denial-of-service vector and a storage problem.
- Validate types **and** ranges: a radius of 10,000 km is well-typed and wrong.
- Validate path and query parameters, not just bodies.

## Injection

| Vector         | Control                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| SQL            | Drizzle's parameterised builder. Raw SQL only via its parameterised template — **never string interpolation** |
| XSS            | React Native escapes by default; never render untrusted HTML in a WebView                                     |
| Command        | No shell invocation with user input                                                                           |
| SSRF           | No user-supplied URL is fetched server-side                                                                   |
| Path traversal | Storage keys are server-generated UUIDs, never client filenames                                               |

## File upload

Untrusted binaries from untrusted clients. Full design:
[ADR-0005](../decisions/ADR-0005-object-storage.md), amended by
[ADR-0024](../decisions/ADR-0024-presigned-upload-mechanism.md).

- Presigned URLs, short-lived, and **single-use because this server makes them
  so**. S3 offers no such guarantee — AWS documents that a presigned URL works
  repeatedly until it expires — so the control is a row the server issued and a
  conditional transition out of it that only one confirm can win.
- Content-type **allow-list** (allow-lists fail closed; deny-lists do not).
- **Size cap enforced at confirm, against the real object**, and the object is
  deleted when it fails. ADR-0005 asked for the cap to sit in the presign
  policy; the only S3 mechanism that does that is the POST form policy, and
  Cloudflare R2 — the chosen provider — does not implement POST at all. The
  reasoning, and exactly what is given up, is ADR-0024.
- **Validate the actual leading bytes**, not the declared `Content-Type`. A
  declared type is a client assertion. This was always a post-upload check:
  no signature mechanism on any provider inspects file contents.
- Server-generated keys; private bucket; reads via short-lived presigned GETs.
- **Ownership is the row, never the key.** Every check — "is this photo the
  caller's", "is it attached to this order", "may this master see it" — reads
  `order_photos` / `master_documents`, so nothing anywhere parses an
  identifier back out of a key string.
- **A key whose presigned URL is shown to more than its owner carries no
  identifier at all.** Both providers copy the key verbatim into the signed
  URL's path, so anything in it is published to whoever is shown that URL.
  Order problem photos are the case that matters: their read URLs go on the
  master-facing offer card, which a broadcast hands to every eligible master
  in range, so the key is `orders/photos/<uuidv7>` with no customer segment —
  a customer id there would be an identifier stable across every order that
  customer ever places, handed to masters who mostly never take the job.
  Verification documents keep a master-scoped prefix because their URLs are
  only ever signed for that master and for an admin reviewer, neither of whom
  learns anything from it.
- **Presigning is rate-limited** (`document-upload`). Each call is permission
  to write bytes into a bucket somebody pays for.

## Rate limiting and abuse

| Surface            | Concern                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| OTP request        | **Cost attack** — an attacker spends real money on SMS                                                                   |
| Sign-in            | Credential stuffing                                                                                                      |
| Admin sign-in      | Credential stuffing against the highest-privilege account — limit per **identifier and per IP**, with lockout (ADR-0014) |
| Order creation     | Spam orders wasting master time                                                                                          |
| Location ingest    | Resource exhaustion                                                                                                      |
| Reviews            | Reputation manipulation                                                                                                  |
| WebSocket messages | Per-connection flooding                                                                                                  |

Rate limit state lives in **Redis**, not in process memory — an in-process counter
is per-instance and therefore N× weaker than intended, and it resets on deploy.

Marketplace-specific abuse to design against: fake orders to waste competitors'
time, review manipulation, masters cancelling after accepting to block rivals,
and location spoofing to appear nearby.

## PII and privacy

TezUsta holds: phone numbers, home addresses, problem photos (interiors of
people's homes), and precise live location.

| Data                   | Rule                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| Live master position   | Visible **only** to the customer on the active order, **only** while active |
| Location history       | Retention-bounded, aged out **on the write path** — see below               |
| Customer address       | Revealed to a master **only after acceptance**; approximate area before     |
| Problem photos         | Private bucket; customer, assigned master, and admins only                  |
| Phone numbers          | Masked in logs and in admin lists; full value only where needed             |
| Admin PII access       | Audited — actor, action, target, reason, timestamp. A **read** is an action |
| Verification documents | Identity documents; an upload nobody ever confirmed is swept — see below    |

**Why the address rule matters:** broadcasting exact addresses to every nearby
master on every order would leak the home addresses of people who never became
customers.

**Location history is aged out on the write path, not on a schedule.** Issue #98
settled this: every position report deletes that master's rows older than
`MASTER_LOCATION_TRAIL_MINUTES` inside the transaction that inserts the new one,
and `master_locations`'s append-only trigger permits a DELETE only for rows
older than the cutoff the prune publishes
([`../architecture/database-architecture.md`](../architecture/database-architecture.md)).
A nightly sweep was the obvious answer and is the wrong one here, because this
repository has no scheduler — a retention rule waiting for one that does not
exist is a rule nobody is keeping.

**What that leaves, named rather than implied:** a master who stops reporting
keeps whatever remains of their last window until they report again, because
nothing runs on their behalf while they are gone. That residue is bounded, not
an unbounded history, and closing it is the sweep in
[#105](https://github.com/ismetcahangirov/tezUsta/issues/105), which wants the
scheduler this Epic does not introduce.

**An identity document nobody confirmed is swept (#128).** A master presigns
an upload, the bytes land in the bucket, and the confirm never arrives —
because the app was closed, the network died, or they changed their mind about
becoming a master at all. Storage has no idea we never accepted them.
`master_documents` clears a stale presign when the same master presigns that
type again, which cleans up after everybody except the master who walked
away — and that master is the whole population this is about. A recurring
`maintenance` job now deletes the row and the object together, after
`MASTER_DOCUMENT_ABANDONED_AFTER_HOURS`.

Two properties of it are worth stating because the wrong version of each is
the plausible one:

- **The window runs from the master's last document activity**, not from each
  row's own age. Somebody part-way through gathering the three documents
  ADR-0023 requires must not lose the first while they are still finding the
  third.
- **A document that reached review is never touched, at any age** — waiting
  for an admin, accepted, or rejected. That is evidence behind a decision,
  which is what `docs/product/admin-flow.md`'s "no destructive deletes" is
  actually about. Only `awaiting_upload` is swept, and the predicate names
  that status rather than inferring it from a null column.

**Every retention window here is bounded, and each is a product judgement
rather than a legal finding.** The document window above is an engineering
bound on an abandoned application. The one with the sharpest privacy edge —
how long a refresh-token **reuse incident** is kept — is decided in
[ADR-0027](../decisions/ADR-0027-refresh-token-incident-retention.md): one
year, the whole session row, then deleted. No Azerbaijani data-protection
obligation has been established by this repository; if counsel establishes one,
it supersedes that ADR rather than silently widening a window.

## Logging

**Never log:** tokens, refresh tokens, OTP codes, passwords, full phone numbers,
precise coordinates, payment details, full addresses.

**Always log:** a `requestId` correlating client, API, and worker; the actor id
for privileged actions; authentication failures and rate-limit triggers.

Structured JSON. Logs are read by more people than their author expects.

**A driver error is user data.** `drizzle-orm` builds a failed query's message
by interpolating every bound parameter, and PostgreSQL quotes the offending row
back in the error's `detail` (`Key (phone_e164)=(+994...) already exists.`), so
logging a caught database error whole publishes both — which is how a phone
number reaches a log without anyone writing a line that logs one (issue #63).
Everything thrown passes through `AllExceptionsFilter`, which redacts it via
`infra/database/database-error.ts`: the SQLSTATE, the constraint, the
parameterised SQL and the stack frames are kept; the message, the parameters
and `detail` are not. Log a database error anywhere else and that redaction is
not applied for you.

**A stack trace is for a fault, not for an answer (issue #56).** The same
filter writes one line per handled exception, and the level and the detail
depend on whether we expected it:

- An **expected client error** — an `AppError`, or any `HttpException`, below
  500 — logs at `warn` with its request id, actor id, status, code and
  message, and **no stack**. A 401 with no token, a 404 for "not yours" and a
  429 from the limiter are the expected answers to ordinary traffic; a stack
  per refusal makes a cheap refusal expensive for us, and the rate limiter
  exists to produce a great many of them cheaply.
- Anything else — a 5xx, a driver error, a bug — keeps the full stack at
  `error`. That includes a deliberate `AppError` carrying a 500: the split is
  "did we expect this", never "what status is it".

Rate-limit triggers stay logged either way, as this section requires. They
lose the trace, not the line.

**`LOG_LEVEL` is the one knob that could take the line too (issue #129).** It
is a threshold — `debug | info | warn | error`, each enabling everything above
it, with `fatal` always written — applied at startup in `main.ts` through
`infra/observability/log-levels.ts`. It was parsed and ignored until then,
which is the worse of the two states a dead knob can be in: an operator
raising it to quiet a flood of expected 401s got no change and no sign that
there was nothing on offer.

Because the two lines this section requires — authentication failures and
rate-limit triggers — are written at `warn`, `LOG_LEVEL=error` would turn a
documented security control off while satisfying every other reading of the
variable. **The schema refuses it under `NODE_ENV=production`**, the way
`STORAGE_PROVIDER=stub` is refused there: a control that can be disabled
silently is one that eventually is. `warn` is the way to quiet a production
log. The default is `info` in production and `debug` everywhere else, so no
environment loses a line it was already getting.

## Dependencies

- Audit on every dependency change (`pnpm audit`). CI runs `pnpm audit
--audit-level high` on every pull request **and nightly** — an advisory
  published after a merge would otherwise go unnoticed until the next change.
- Prefer fewer dependencies — every package is attack surface and shipped bytes.
- Pin exact versions for tooling; review a transitive tree before adding.
- A package that is unmaintained is a vulnerability with a delay
  ([CLAUDE.md §10](../../CLAUDE.md)).

## Before merging anything

- [ ] Is every new input validated server-side?
- [ ] Is authorization checked server-side, including **ownership**?
- [ ] Could this endpoint leak another user's data via an id?
- [ ] Does any error response reveal internals?
- [ ] Is anything sensitive being logged — including inside a caught database
      error, whose message and `detail` carry bound values?
- [ ] Is a new endpoint rate-limited if abusable?
- [ ] Are new secrets in `.env.example` as placeholders only, and in the
      environment schema?
- [ ] Does any new `EXPO_PUBLIC_` value grant server authority or billing power?
      (Platform-restricted client map keys are the only documented exception.)
- [ ] Do the tests cover the **unauthorized** paths, not just the happy one?

## Reporting a vulnerability

Do not open a public issue. The repository is public; an issue is a disclosure.
Contact the repository owner directly.
