# ADR-0008 — Sign-in method and OTP delivery

- **Status:** **Sign-in method ACCEPTED.** SMS provider **PENDING**.
- **Date:** 2026-09-14
- **Decided by:** Project owner

## Context

TezUsta needs a sign-in method for customers and masters. It also needs a phone
number for every user, because the customer and the master must be able to call
each other during a job — that is a product requirement, not merely an
authentication concern.

Three options were considered with the owner. Google Sign-In was briefly
selected and then reversed; this ADR records the final decision and why.

## Decision

**Sign-in is phone number + SMS OTP. There is no other sign-in path.**

```
Enter phone number  →  SMS code  →  signed in
                (one step)
```

The phone number is simultaneously the identity and the contact channel.

## Why

- **Lowest onboarding friction.** A two-step flow (social sign-in, then a
  separate phone capture) loses users at the second step. Master supply is the
  harder side of this marketplace to acquire, so friction there is expensive.
- **One identity equals one contact channel.** There is no reconciliation
  problem between "the account" and "the number we call", and no state where a
  user exists but cannot be contacted.
- **Consistent with the chosen dispatch model.** Bolt — the reference the owner
  selected for dispatch ([ADR-0009](ADR-0009-dispatch-model.md)) — uses exactly
  this sign-in method.
- **No dependency on a Google account** being present and actively used.

## Alternatives considered

| Option                                                   | Why not                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Sign-In + phone verified by OTP**               | Briefly chosen, then reversed. SMS cost would be once per user instead of per device login, and Google's 2FA and suspicious-sign-in protections would carry over — but onboarding becomes two steps, both systems must be built, and the native module forces a development build. The friction cost outweighed the savings. |
| **Google Sign-In + phone captured without verification** | Cheapest and fastest — no SMS provider at all. Rejected: an unverified number can be mistyped or fake, and a master who cannot reach the customer is a stalled job. In this product the phone number must actually work.                                                                                                     |
| **Email + password**                                     | Higher friction, weaker for this market, and still leaves the phone number unverified.                                                                                                                                                                                                                                       |

## Trade-offs accepted

| Cost                                                 | Mitigation                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **SMS is charged on every new-device sign-in**       | 30-day rotating refresh tokens mean re-authentication is rare                                                       |
| **No Google 2FA or suspicious-sign-in detection**    | Rate limiting, attempt caps, and device session management ([authentication.md](../architecture/authentication.md)) |
| **Losing the phone number means losing the account** | A recovery path is required — see open questions                                                                    |
| **The SMS provider becomes a launch blocker**        | Nothing can be signed into without it; it is now on the critical path                                               |

## Consequences

- **EPIC 2 cannot ship without an SMS provider.** This is the single highest
  priority unblocking decision.
- No Google Sign-In dependency. `@react-native-google-signin/google-signin`,
  `google-auth-library`, and the `astrocalc` reference implementation are **not
  used in this project**.
- The development-build requirement does **not** come from authentication. It
  may still come from `react-native-maps` — to be measured in EPIC 1, not
  assumed.
- Phone numbers are normalised to E.164 and are **unique among verified users**.
  Without that, one person can create several master profiles and escape a poor
  rating or cancellation record.

---

## SMS provider — PENDING

| Option                           | For                                                           | Against                                                                    |
| -------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Local Azerbaijani aggregator** | Usually the best delivery rates and pricing for local numbers | Typically requires a local contract                                        |
| **Twilio / Vonage**              | Excellent APIs, fast integration, global reach                | Higher per-message cost; sender-ID rules vary by country                   |
| **WhatsApp / Telegram OTP**      | High regional penetration, low cost                           | Platform dependency and a business account; excludes users without the app |

### Open questions for the owner

1. **Which SMS provider**, and is an account in place?
2. **Is a sender ID registered** with Azerbaijani operators? This is usually
   required and takes time.
3. **What per-message cost is acceptable?** It sets the rate-limit budget.
4. **How does a user recover an account when the phone number is gone** (the
   operator reassigned it, the line was closed)? This is the principal weakness
   of phone-only sign-in, and it needs an answer before launch — the user's
   order history, reviews, and master rating are attached to that account.

---

## Security requirements — binding regardless of provider

| Requirement                                              | Reason                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **6 digits, generated with a CSPRNG**                    | `Math.random()` is predictable                                                                           |
| **TTL ≤ 5 minutes**                                      | Limits the brute-force and interception window                                                           |
| **Codes stored hashed**                                  | A database read must not yield a usable credential                                                       |
| **Max 5 attempts per code, then invalidate**             | Caps online brute force                                                                                  |
| **Rate limit per phone number and per IP, with backoff** | **This is a financial control.** An unthrottled OTP endpoint lets an attacker spend TezUsta's SMS budget |
| **A new code invalidates the previous one**              | Prevents a pool of valid codes                                                                           |
| **Successful verification consumes the code atomically** | Prevents a race redeeming one code twice                                                                 |
| **Identical responses for known and unknown numbers**    | Otherwise the endpoint is a user-enumeration oracle                                                      |
| **Codes never appear in logs, traces, or errors**        | Logs are read by more people than expect to see them                                                     |
| **Rate-limit state lives in Redis**                      | An in-process counter is per-instance, so N instances mean an N× weaker limit, and it resets on deploy   |

**SMS cost abuse is the realistic attack here**, ahead of code guessing.

## Do not

- Do not build a second sign-in path. One authentication vector, not two.
- Do not hardcode a provider — the sender sits behind an interface in
  `packages/config`, like the maps provider in [ADR-0004](ADR-0004-location-and-maps.md).
- Do not ship an OTP endpoint without rate limiting, **not even in staging** —
  a staging endpoint with real SMS credentials spends real money.

## Revisit when

- Account-recovery complaints show phone-only is losing users, or
- SMS cost at volume outgrows the friction saving, at which point social
  sign-in as an _additional_ option (never a replacement for the verified
  number) can be reconsidered.
