# Security

Security is a first-class requirement from the first line of code, not EPIC 15.
EPIC 15 hardens and audits; it does not introduce security.

TezUsta sends a stranger to someone's home and moves money. The consequences of
a failure here are physical, not just financial.

## Non-negotiables

| Rule                                                         | Why                                            |
| ------------------------------------------------------------ | ---------------------------------------------- |
| Validate **all** input at the API boundary with Zod          | The client is untrusted, always                |
| Authorize **server-side, per request**                       | A client role check is a UX affordance         |
| Ownership checks on every resource read                      | Authenticated ≠ entitled                       |
| Parameterised queries only (Drizzle builder)                 | Never string-concatenated SQL                  |
| Tokens in `expo-secure-store`                                | `AsyncStorage` is plaintext                    |
| Rate-limit auth, OTP, order creation, reviews                | Abuse and cost control                         |
| Never log tokens, OTP codes, full phone numbers, coordinates | Logs have a wider audience than expected       |
| Errors never leak internals                                  | No stack traces, SQL, or infrastructure detail |
| Nothing secret behind `EXPO_PUBLIC_`                         | That prefix ships in the app bundle            |

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
[ADR-0005](../decisions/ADR-0005-object-storage.md).

- Presigned URLs, short-lived and single-use.
- Content-type **allow-list** (allow-lists fail closed; deny-lists do not).
- Size cap enforced **in the presign policy**, not checked after upload — by then
  the upload has happened.
- **Validate the actual leading bytes**, not the declared `Content-Type`. A
  declared type is a client assertion.
- Server-generated keys; private bucket; reads via short-lived presigned GETs.
- Photo keys bound to the issuing user and order.

## Rate limiting and abuse

| Surface            | Concern                                                |
| ------------------ | ------------------------------------------------------ |
| OTP request        | **Cost attack** — an attacker spends real money on SMS |
| Sign-in            | Credential stuffing                                    |
| Order creation     | Spam orders wasting master time                        |
| Location ingest    | Resource exhaustion                                    |
| Reviews            | Reputation manipulation                                |
| WebSocket messages | Per-connection flooding                                |

Rate limit state lives in **Redis**, not in process memory — an in-process counter
is per-instance and therefore N× weaker than intended, and it resets on deploy.

Marketplace-specific abuse to design against: fake orders to waste competitors'
time, review manipulation, masters cancelling after accepting to block rivals,
and location spoofing to appear nearby.

## PII and privacy

TezUsta holds: phone numbers, home addresses, problem photos (interiors of
people's homes), and precise live location.

| Data                 | Rule                                                                        |
| -------------------- | --------------------------------------------------------------------------- |
| Live master position | Visible **only** to the customer on the active order, **only** while active |
| Location history     | Retention-bounded, aged out on a schedule                                   |
| Customer address     | Revealed to a master **only after acceptance**; approximate area before     |
| Problem photos       | Private bucket; customer, assigned master, and admins only                  |
| Phone numbers        | Masked in logs and in admin lists; full value only where needed             |
| Admin PII access     | Logged as an event                                                          |

**Why the address rule matters:** broadcasting exact addresses to every nearby
master on every order would leak the home addresses of people who never became
customers.

**Data retention periods need a legal answer** — flagged, not decided.

## Logging

**Never log:** tokens, refresh tokens, OTP codes, passwords, full phone numbers,
precise coordinates, payment details, full addresses.

**Always log:** a `requestId` correlating client, API, and worker; the actor id
for privileged actions; authentication failures and rate-limit triggers.

Structured JSON. Logs are read by more people than their author expects.

## Dependencies

- Audit on every dependency change (`pnpm audit`) and on a schedule in CI.
- Prefer fewer dependencies — every package is attack surface and shipped bytes.
- Pin exact versions for tooling; review a transitive tree before adding.
- A package that is unmaintained is a vulnerability with a delay
  ([CLAUDE.md §10](../../CLAUDE.md)).

## Before merging anything

- [ ] Is every new input validated server-side?
- [ ] Is authorization checked server-side, including **ownership**?
- [ ] Could this endpoint leak another user's data via an id?
- [ ] Does any error response reveal internals?
- [ ] Is anything sensitive being logged?
- [ ] Is a new endpoint rate-limited if abusable?
- [ ] Are new secrets in `.env.example` as placeholders only?
- [ ] Does new client code put anything secret behind `EXPO_PUBLIC_`?
- [ ] Do the tests cover the **unauthorized** paths, not just the happy one?

## Reporting a vulnerability

Do not open a public issue. The repository is public; an issue is a disclosure.
Contact the repository owner directly.
