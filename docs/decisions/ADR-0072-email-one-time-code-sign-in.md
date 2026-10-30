# ADR-0072 — Sign-in is an email address and a one-time code; the phone number is removed

- **Status:** **Accepted (email provider and account recovery pending)**
- **Date:** 2026-10-30
- **Decided by:** Project owner. On 30 October 2026 the owner decided that customers and masters sign in with an email address and a one-time code sent by email, and nothing else, and that phone numbers leave the product completely: no phone sign-in, no phone number stored on the account, no SMS provider.
- **Context:** EPIC 2 (#3), branch `feat/email-otp-sign-in`.
- **Supersedes:** [ADR-0008](ADR-0008-otp-delivery.md) (phone + SMS OTP) and [ADR-0059](ADR-0059-sms-provider.md) (Plivo primary, Twilio fallback). ADR-0008's security requirements carry over unchanged (§ 2).
- **Amends:** [ADR-0061](ADR-0061-master-web-subscription-page.md) — the web subscription page signs a master in with email + code instead of phone + code. Everything else in ADR-0061 stands: its own audience, the cookie session, the opt-in route set, codes sent only to masters, no sign-in link. Also the phone clauses of [ADR-0043](ADR-0043-admin-panel-policy.md) § 6 and [ADR-0050](ADR-0050-admin-customer-accounts.md) § 5 (§ 5 below).
- **Unchanged:** [ADR-0014](ADR-0014-admin-authentication.md). Admins still sign in with email + password + mandatory TOTP on their own credential path.

## Context

ADR-0008 made phone + SMS OTP the only sign-in path, for two reasons: low
onboarding friction, and "one identity equals one contact channel", because the
customer and the master had to be able to call each other during a job.
ADR-0059 then chose Plivo and Twilio and capped sends to +994 mobiles.

What has changed since:

- **Nobody calls a phone number any more.** Calling became in-app voice over
  LiveKit ([ADR-0034](ADR-0034-in-app-voice-calls.md)), and neither party ever
  sees the other's number. The number on the account reached nobody; it was
  only the sign-in identifier, and a piece of personal data held for no other
  purpose.
- **Real sign-in never opened.** The SMS accounts ADR-0059 depends on were
  never opened, so no customer or master has ever signed in for real. There is
  no user base to migrate.
- **SMS to Azerbaijan is expensive and slow to set up.** ADR-0059 priced it at
  $0.25–0.47 a message, with a sender ID to register with three operators, a
  daily spend to set and a legal review, all still open.

The owner has decided to drop the phone number altogether rather than keep it
beside a new sign-in path.

## Decision

### 1. Sign-in is an email address and a one-time code sent by email

```
Enter email address  →  code by email  →  signed in
                 (one step)
```

There is no password and no other sign-in path for customers or masters. A
code proves control of the address; once it is verified the server issues its
own token pair, exactly as before (`authentication.md` § Token model).

The endpoints keep their paths. Their bodies carry `email` instead of `phone`:

| Surface               | Request                      | Verify                      |
| --------------------- | ---------------------------- | --------------------------- |
| App (`apps/mobile`)   | `POST /auth/otp/request`     | `POST /auth/otp/verify`     |
| Web subscription page | `POST /web/auth/otp/request` | `POST /web/auth/otp/verify` |

The account is still created at verification, never at request, with no role
grant; choosing customer or master is still a separate step.

### 2. ADR-0008's security requirements carry over unchanged

Binding regardless of provider:

| Requirement                                              | Reason                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **6 digits, generated with a CSPRNG**                    | `Math.random()` is predictable                                                                                |
| **TTL ≤ 5 minutes**                                      | Limits the brute-force and interception window                                                                |
| **Codes stored HMAC-hashed** (`OTP_CODE_PEPPER`)         | A database read must not yield a usable credential                                                            |
| **Max 5 attempts per code, then invalidate**             | Caps online brute force                                                                                       |
| **Rate limit per address and per IP, with backoff**      | Still a cost and reputation control: an unthrottled endpoint makes the platform mail anyone, as fast as asked |
| **A new code invalidates the previous one**              | Prevents a pool of valid codes                                                                                |
| **Successful verification consumes the code atomically** | Prevents a race redeeming one code twice                                                                      |
| **Identical responses for known and unknown addresses**  | Otherwise the endpoint is a user-enumeration oracle                                                           |
| **Codes never appear in logs, traces, or errors**        | Logs are read by more people than expect to see them                                                          |
| **Rate-limit state lives in Redis**                      | An in-process counter is per-instance, so N instances mean an N× weaker limit, and it resets on deploy        |

The per-address budget is `OTP_RATE_LIMIT_PER_EMAIL_HOUR`, replacing
`OTP_RATE_LIMIT_PER_PHONE_HOUR`. Rate-limit keys still hold an HMAC of the
subject under `RATE_LIMIT_KEY_SECRET`, never the address itself. A full email
address is never logged, as a full phone number never was.

### 3. How an address is normalised, and what is unique

- **Trimmed and lower-cased, as a whole.** At most 254 characters, and it must
  have a valid shape (one `@`, a non-empty local part, a domain with a dot).
  The lower-cased value is what is stored, compared, rate-limited and mailed.
- **No provider-specific rewriting.** `a.b+x@gmail.com` and `ab@gmail.com` are
  two addresses. Gmail's dot and plus folding is not applied, and neither is
  any other provider's.
- **Unique among live accounts.** `users.email` has a partial unique index
  `WHERE deleted_at IS NULL`, the shape `users.phone_e164` had: a soft-deleted
  account does not block a new one at the same address.

Not folding is deliberate. The rules are the provider's, they change, and a
rewrite that is wrong for one provider merges two different people into one
account. The cost is that one person can open several accounts with
plus-addresses. The mitigations are the ones that already exist: the cap on a
customer's open orders (`MAX_OPEN_ORDERS_PER_CUSTOMER`), master verification
(ADR-0023), and admin suspension (ADR-0050, ADR-0043). If that abuse shows up,
revisit.

### 4. Fraud controls: the aggregate caps stay; the number-shaped ones go

**Kept**, unchanged in mechanism:

- the platform-wide daily cap, `OTP_GLOBAL_DAILY_CAP`;
- the hourly ceiling below it, `OTP_GLOBAL_HOURLY_CAP`;
- the circuit breaker on the share of codes entered correctly
  (`OTP_BREAKER_MIN_SENDS`, `OTP_BREAKER_MIN_SUCCESS_PERCENT`).

**Removed:** the per-operator-prefix and per-number-range hourly caps
(`OTP_PREFIX_HOURLY_CAP`, `OTP_RANGE_HOURLY_CAP`). They were SMS-pumping
controls keyed on the structure of a phone number, an operator prefix and a
block of ten thousand numbers, and an email address has no such structure.

An email costs a fraction of an SMS, so the caps are no longer mainly about
money. They stay because sending to addresses nobody asked to be mailed at
damages the sending domain's reputation. Mail from a domain with a poor
reputation goes to spam, and then no real user can sign in.

### 5. The phone number is removed from the account

- `users` no longer has a phone number, and nothing else in the product holds
  one. The email address is the identity and the only contact channel, which
  is ADR-0008's "one identity equals one contact channel" carried over to
  email. Calls never needed a number (ADR-0034).
- **The admin panel's audited phone reveal becomes an audited email reveal**
  (`POST /admin/orders/:orderId/parties/:party/email`), still behind
  `pii.read`, still requiring a reason, still audited as its own action
  (ADR-0043 § 6). Lists and order parties show a masked address
  (`a•••@gmail.com`) where they showed a masked number.
- **Admin customer search accepts a whole email address** where it accepted a
  whole E.164 number (ADR-0050 § 5). Part of an address is read as a name
  prefix and finds nobody, for the reason a part number did: a partial match
  would let an admin walk the address space. A whole-address search that finds
  someone is audited against the customer found.

### 6. The email provider is not chosen

- Delivery sits behind an `EmailSender` interface in
  `apps/api/src/infra/email/`, the shape `SmsSender` had. No vendor type
  crosses it.
- The only implementation is a **stub**, selected by `EMAIL_PROVIDER=stub`. As
  the SMS stub did, it prints the message to the local log under
  `NODE_ENV=development`, with the recipient masked, so the flow can be run
  with no mailbox; prints nothing under `test`; and refuses to construct under
  `NODE_ENV=production`. It is the one place a code may come near a log, and
  only because it cannot exist outside development.
- **Choosing a provider is a new open decision**, together with the sending
  domain and its SPF, DKIM and DMARC records. It blocks real sign-in. A
  provider is one adapter in `infra/email/` and one value of `EMAIL_PROVIDER`.
- **Deleted:** the Plivo and Twilio adapters, `apps/api/src/infra/sms/`,
  `apps/api/src/infra/phone/`, and their settings (`SMS_PROVIDER`,
  `SMS_FALLBACK_PROVIDER`, `SMS_SENDER_ID`, `SMS_TIMEOUT_MS`, `PLIVO_*`,
  `TWILIO_*`).

### 7. Existing data

This is pre-launch: nobody has signed in for real, because the SMS accounts
were never opened. The rows that exist are development and test data. One
migration:

- **drops `users.phone_e164`** and its unique index, and **adds `users.email`**
  with the partial unique index of § 3;
- **backfills every existing row** with `<user id>@legacy.invalid`. `.invalid`
  is reserved by RFC 2606 and never resolves, so nothing can be delivered
  there. Foreign keys to those users survive, and the accounts can no longer
  be signed into;
- **deletes every `otp_challenges` row** and replaces its `phone_e164` column
  with `email`. A challenge is a credential that lives five minutes, so
  nothing of value is lost.

### 8. Still open

- **The email provider and the sending domain** (§ 6). Blocks real sign-in.
- **Account recovery when the user loses access to their email address.** It
  replaces "when the phone number is lost" (ADR-0008 question 4) and is needed
  before launch: the order history, reviews and master rating are attached to
  the account.

## Why

- **The reason for the phone is gone.** ADR-0008 needed a working number
  because the parties had to call each other. ADR-0034 moved calling into the
  app, so the number had become a sign-in identifier and nothing more, and
  holding personal data that serves no purpose is a liability.
- **One identity, one contact channel, still.** The address that signs in is
  the address the platform writes to. There is still no state where an account
  exists but cannot be reached.
- **Same onboarding shape.** One field, one code, signed in. Nobody creates or
  remembers a password.
- **Much cheaper per sign-in, and no operator registration.** No sender ID with
  three operators and no per-message price of $0.25–0.47.
- **Every control already built carries over.** The code generation, hashing,
  attempt cap, atomic consumption, per-subject and per-IP limits and the
  aggregate caps do not care what kind of address the code goes to.

## Alternatives considered

| Option                                          | Why not                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Email + password**                            | A password needs a reset flow, which is an email code anyway; it opens a credential-stuffing surface with reused passwords; and it adds friction at sign-up, on the side of the market (masters) that is hardest to acquire.          |
| **Keep the phone as an optional profile field** | Rejected by the owner: the phone number is removed completely. It would also be personal data held with no use, since calls are in-app.                                                                                               |
| **A magic link instead of a code**              | A link is often opened on a different device from the app, usually a laptop's mail client, which is a worse mobile flow, and it needs deep-link handling. A link that is a credential is also forwarded and previewed (ADR-0061 § 5). |
| **Keep phone + SMS (ADR-0008, ADR-0059)**       | Superseded by the owner's decision. Its accounts, spend and legal review were all still open.                                                                                                                                         |

## Trade-offs accepted

| Cost                                                                   | Mitigation                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Email can be slow or land in spam**, so a code may arrive late       | A correctly set-up sending domain (SPF, DKIM, DMARC); a five-minute TTL; a new code can be requested |
| **One person can open several accounts with plus-addresses**           | The open-orders cap, master verification and admin suspension; revisit if abuse appears (§ 3)        |
| **Losing access to the email address means losing the account**        | A recovery path is required before launch (§ 8)                                                      |
| **The email provider becomes the launch blocker** the SMS provider was | Everything is built against the stub; only the provider adapter and the domain set-up remain         |
| **Mailing arbitrary addresses can damage the sending domain**          | The per-address, per-IP, hourly and daily caps and the circuit breaker stay (§ 4)                    |
| **Development accounts lose their sign-in**                            | They were never reachable for real; placeholders keep their foreign keys (§ 7)                       |

## Consequences

- **API:** `users.email` replaces `users.phone_e164`, `otp_challenges.email`
  replaces `otp_challenges.phone_e164`; the request and verify bodies carry
  `email`; `infra/email/` with `EmailSender` and the stub replaces
  `infra/sms/` and `infra/phone/`; the prefix and range caps are removed; the
  admin reveal and search read the email address.
- **`packages/types`:** `phoneMasked` becomes `emailMasked`, and
  `AdminPhoneReveal` becomes `AdminEmailReveal`.
- **`apps/mobile` and `apps/web`:** the sign-in screens ask for an email
  address, with an email keyboard and no country prefix.
- **`apps/admin`:** reveal and search by email address.
- **Configuration:** `EMAIL_PROVIDER=stub` and `OTP_RATE_LIMIT_PER_EMAIL_HOUR`;
  the SMS, Plivo and Twilio settings and the prefix and range caps are gone.
- **The web sign-in still mails only masters** (ADR-0061 § 4). Any other address
  gets the identical answer and no email. The known timing gap remains: a
  master's request waits for the provider and a stranger's does not.
- **CLAUDE.md § 1** and the documents that described phone sign-in are
  updated in the same change. ADR-0008, ADR-0059 and the security audits stay
  as they were written.

## Revisit when

- Plus-address or throwaway-domain abuse is seen in practice (§ 3).
- Delivery delays or spam filtering measurably lose users at the code step.
- An email provider is chosen: that is its own ADR, with the sending domain.
