# ADR-0008 — Phone verification and OTP delivery

- **Status:** **PENDING — blocked on a provider decision.**
- **Date:** 2026-09-14
- **Scheduled for:** EPIC 2

## Context

Both customers and masters are expected to sign in with a phone number, which is
the norm for this product category in this market. That requires delivering a
one-time code by SMS.

Sending SMS to Azerbaijani numbers requires a provider with local termination and,
in practice, a registered alphanumeric sender ID. This is an account and
paperwork decision, not a technical one.

## Blocking questions for the user

1. **Is phone-number authentication actually the intended sign-in method?**
   (CLAUDE.md §17 — this is a product decision.) Email/password and social
   sign-in are alternatives with different cost and friction.
2. **Which SMS provider**, and is an account already in place?
3. **Is a sender ID registered** with Azerbaijani operators?
4. **What is the acceptable per-message cost?** It sets the rate-limit budget.

## Candidates (research only)

| Option                             | Notes                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| A local Azerbaijani SMS aggregator | Usually the best delivery rates and pricing for local numbers; typically requires a local contract |
| Twilio / Vonage                    | Excellent APIs and global reach; higher per-message cost; sender-ID rules vary by country          |
| WhatsApp / Telegram OTP            | High regional penetration and low cost, but adds a platform dependency and a business account      |

## Security requirements that hold regardless of provider

These are not negotiable and must be implemented whenever EPIC 2 starts:

| Requirement                                                 | Reason                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Codes are **6 digits**, generated with a CSPRNG             | `Math.random()` is predictable                                                            |
| **TTL ≤ 5 minutes**                                         | Limits the brute-force and interception window                                            |
| Codes are stored **hashed**, never in plaintext             | A database read must not yield a usable code                                              |
| **Max 5 verification attempts** per code, then invalidate   | Caps online brute force                                                                   |
| **Rate limit per phone number and per IP**, with backoff    | An unthrottled OTP endpoint is an SMS-cost attack — an attacker spends the victim's money |
| Requesting a new code **invalidates the previous one**      | Prevents a pool of valid codes                                                            |
| The response is **identical** for known and unknown numbers | Otherwise the endpoint is a user-enumeration oracle                                       |
| Codes **never** appear in logs, traces, or error messages   | Logs are read by more people than expect to see them                                      |
| A successful verification **consumes** the code atomically  | Prevents a race that redeems one code twice                                               |

**SMS cost abuse is the realistic attack here**, ahead of code guessing. Rate
limiting is a financial control as much as a security one.

## Do not

- Do not implement OTP before the sign-in method is confirmed by the user.
- Do not hardcode a provider — the sender goes behind an interface in
  `packages/config`, like the maps provider in [ADR-0004](ADR-0004-location-and-maps.md).
- Do not ship an OTP endpoint without rate limiting. Not even in staging: a
  staging endpoint with real SMS credentials spends real money.
