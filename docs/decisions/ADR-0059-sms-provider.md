# ADR-0059 — SMS provider: Plivo first, Twilio as fallback, `TezUsta` to +994 mobiles only

- **Status:** **Accepted**
- **Date:** 2026-10-21
- **Decided by:** Project owner. On 21 October 2026 the owner accepted the recommendation in [#389]'s research report.
- **Context:** EPIC 2 (#3), issues [#389] (the decision) and [#390] (the integration)
- **Settles:** [ADR-0008](ADR-0008-otp-delivery.md) § "SMS provider — PENDING", open questions 1 and 2. Question 3, the acceptable cost, and question 4, account recovery, stay open (§ 5).

[#389]: https://github.com/ismetcahangirov/tezUsta/issues/389
[#390]: https://github.com/ismetcahangirov/tezUsta/issues/390

## Context

ADR-0008 makes phone + SMS OTP the only sign-in path and left the provider open. Until a provider is chosen, nobody can sign in for real.

The research on #389 compared the options for Azerbaijan. Its sources were accessed on 2026-10-19, and the full report is the first comment on that issue. What it found:

- Published prices to +994 run **$0.25–0.47** per message.
- **Plivo** is the only provider that publishes prices per operator: Azercell $0.2483, Bakcell $0.339, Nar $0.4717.
- Verify-style products clash with TezUsta's own code generation and checking.
- A brand alphanumeric sender works. Numeric senders fail on Azercell, and generic ones are refused.
- No local aggregator publishes a price or documents any fraud tooling.

## Decision

### 1. Plivo is the primary, Twilio the fallback

Both are used through their **plain SMS APIs**, not Plivo Verify or Twilio Verify. TezUsta already generates, hashes, rate-limits and checks its own six-digit codes (ADR-0008).

- **Plivo:**
  - it publishes per-operator rates;
  - its SMS-pumping protection for non-US traffic is reported as free and on by default;
  - blocked traffic is not billed.
- **Twilio:**
  - an independent second route, because a single provider has failed to reach Nar and Bakcell before (Twilio, 2022);
  - $0.411 per segment, so it is used only when Plivo errors or times out.

Each adapter is one REST call with `fetch`. No SDK, so no new dependency (CLAUDE.md § 10). Both sit behind `SmsSender` in `apps/api/src/infra/sms/`.

### 2. The sender is `TezUsta`

The sender is an alphanumeric brand sender, as both providers' Azerbaijan guidelines advise. It must be tested on real Azercell, Bakcell and Nar SIM cards before launch.

### 3. Only +994 mobile numbers

Nothing is sent to a number outside Azerbaijan or to a landline. This is enforced in code before any provider is called (`AzerbaijanOnlySmsSender`). Both consoles are also restricted to Azerbaijan. Most SMS-pumping ranges are outside the market TezUsta serves, so this is the cheapest fraud control there is.

### 4. Fallback on failure only

Failover happens on an API error or a timeout (`SMS_TIMEOUT_MS`, 5 s by default). It never happens on a missing delivery receipt: no provider documents receipts for Azerbaijan, so a missing receipt is not a signal.

A send that fell back is still **one** attempt against the per-phone, per-IP and daily limits.

### 5. Still the owner's, before launch

These are not decided here:

- **Opening the two accounts**, and the legal entity and VÖEN behind the contracts.
- **The acceptable spend per day** (ADR-0008 question 3). `OTP_GLOBAL_DAILY_CAP` stays at 2000 until the owner sets it. At Plivo's Nar rate, 2000 a day is a worst case of about **$943 a day**.
- **Written quotes from local aggregators** (LSIM, ATL SMS, Figensoft). A local route that beats about $0.25 on all three operators, with the report's 13 conditions met, would replace Plivo as primary. That would be a new ADR.
- **Local counsel** on the report's nine legal points (consent, cross-border transfer, registering the information system) before public launch.
- **Account recovery** when the phone number is lost (ADR-0008 question 4).
- **Telegram Gateway or WhatsApp as a cheaper channel** later. That needs an amendment to ADR-0008.

## Consequences

- `SMS_PROVIDER` gains `plivo` and `twilio`. New settings: `SMS_FALLBACK_PROVIDER`, `SMS_SENDER_ID` (must be alphanumeric), `SMS_TIMEOUT_MS`, and `PLIVO_*` / `TWILIO_*` credentials.
  - A chosen provider with a missing setting fails at boot, naming every missing variable.
  - `SMS_API_KEY`, which nothing read, is removed.
- The stub stays the default for development and tests. It still refuses production.
- Logs carry the provider's message id, a masked number and the status, never the body. A provider failure is described by the provider's name and the HTTP status alone.
- The fraud controls beyond the existing limits are the second half of #390:
  - per-prefix and per-range counters;
  - an hourly cap below the daily one;
  - a circuit breaker on the rate of codes entered correctly.

## Alternatives considered

- **A local aggregator as primary now.** Not yet: no price is published, there is no documented fraud tooling, and a local contract needs a VÖEN. Quotes are requested in parallel (§ 5).
- **Twilio or Vonage Verify.** Rejected: they want to own the code, charge per attempt or per success on top of messaging, and send from generic senders by default.
- **Telegram or WhatsApp first.** Cheaper by 10–40×, but VoIP blocking and app dependence make SMS the guaranteed path. These could be a second channel later (§ 5).

## Revisit when

- A local quote clears the bar in § 5.
- Delivery to one operator degrades on Plivo.
- Messenger channels are planned.
