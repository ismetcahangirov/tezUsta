# Architecture Decision Records

An ADR records **why** a decision was made, what else was considered, and what
was traded away. Code shows what we did; an ADR shows why the alternative was
rejected — which is the part that is expensive to reconstruct later.

## Rules

- **ADRs are immutable once accepted.** To change a decision, write a new ADR
  that supersedes the old one and update both `Status` lines. Never edit an
  accepted ADR's decision.
- Write an ADR when a choice is **hard to reverse** or **would otherwise be
  re-litigated**: a framework, a datastore, a protocol, a versioning constraint,
  a security model, a boundary.
- Do not write one for a choice that a reader can see from the code in a minute.
- A **Pending** ADR is legitimate and useful — it records that a decision is
  open and names what blocks it, so nobody quietly invents an answer.

### Status vocabulary

Exactly five forms. The index below and the `Status` line inside each ADR use
the same words; if they differ, the ADR file is right and the index is stale.

| Status                      | Meaning                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `Proposed`                  | Written, not yet decided. Nothing may be built on it.                                            |
| `Accepted`                  | Decided in full. Build on it; do not re-open it.                                                 |
| `Accepted (<what> pending)` | The decision is made and buildable. A named sub-question is still open and is listed in the ADR. |
| `Pending`                   | The question is recorded, the answer is not. Names what blocks it.                               |
| `Superseded by ADR-MMMM`    | Replaced. Read the successor.                                                                    |

"Accepted with something pending" is the common case here and is **not** a
half-decision: the accepted part is settled and must not be re-litigated. Only
the named sub-question is open.

Under the status an ADR may also carry `Supersedes:`, `Superseded in part by:`,
`Amends:` or `Amended by:`, naming what it replaces or narrows and in which
direction. A clause superseded in part does **not** reopen the rest of the
record: ADR-0004's geocoding decision stands even though ADR-0016 moved where
its provider interface lives.

## Index

| ADR                                                                | Decision                                                                                 | Status                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [0001](ADR-0001-project-foundation.md)                             | Monorepo, pnpm workspaces, Turborepo                                                     | Accepted                                                                 |
| [0002](ADR-0002-toolchain-version-pinning.md)                      | TypeScript 6, Expo SDK 57, Tailwind 3 pins                                               | Accepted                                                                 |
| [0003](ADR-0003-database-and-geo.md)                               | PostgreSQL + PostGIS + Drizzle ORM                                                       | Accepted                                                                 |
| [0004](ADR-0004-location-and-maps.md)                              | `react-native-maps` + Google Maps Platform                                               | Accepted (map library and geocoding provider both decided)               |
| [0005](ADR-0005-object-storage.md)                                 | Presigned S3-compatible uploads; provider                                                | Accepted (provider pending); amended by 0045                             |
| [0006](ADR-0006-project-graph-tooling.md)                          | dependency-cruiser for graph + boundaries                                                | Accepted                                                                 |
| [0007](ADR-0007-payments.md)                                       | Cash **and** card; provider + fund-holding (in part by 0046)                             | Accepted (provider and fund-holding pending)                             |
| [0008](ADR-0008-otp-delivery.md)                                   | Sign-in by phone + OTP; SMS provider                                                     | Accepted (provider settled by 0059)                                      |
| [0009](ADR-0009-dispatch-model.md)                                 | Parallel broadcast, first accept wins                                                    | Accepted (parameters pending tuning)                                     |
| [0010](ADR-0010-pricing-and-commission.md)                         | Master sets price; commission superseded by 0046                                         | Accepted (commission rate and guardrails pending)                        |
| [0011](ADR-0011-design-system.md)                                  | Design system: palette, type, token contract                                             | Accepted (owner art pending); amended by 0048                            |
| [0012](ADR-0012-component-workshop.md)                             | Storybook on React Native Web + Vite                                                     | Accepted                                                                 |
| [0013](ADR-0013-price-freeze-point.md)                             | Price is frozen at accept, not at creation                                               | Accepted                                                                 |
| [0014](ADR-0014-admin-authentication.md)                           | Admin uses a separate credential path                                                    | Accepted (second-factor provider pending)                                |
| [0015](ADR-0015-order-lifecycle-states.md)                         | Complete order status set and transitions                                                | Accepted                                                                 |
| [0016](ADR-0016-shared-package-timing.md)                          | Shared packages created on the second consumer                                           | Accepted                                                                 |
| [0017](ADR-0017-state-management.md)                               | Redux Toolkit for client state, RTK Query for server state                               | Accepted                                                                 |
| [0018](ADR-0018-spatial-index-on-the-geography-cast.md)            | Spatial GiST index is built on the `geography` cast                                      | Accepted                                                                 |
| [0019](ADR-0019-localized-catalogue-names.md)                      | Catalogue display names are a per-row locale map                                         | Accepted                                                                 |
| [0020](ADR-0020-public-cached-service-catalogue.md)                | Service catalogue reads are public and Redis-cached                                      | Accepted                                                                 |
| [0021](ADR-0021-type-only-packages-ship-source.md)                 | A type-only shared package ships source, no build step                                   | Accepted                                                                 |
| [0022](ADR-0022-geocode-cache-stores-coordinates-only.md)          | The geocode cache stores coordinates only, 30 days max                                   | Accepted                                                                 |
| [0023](ADR-0023-master-verification-policy.md)                     | Master verification: evidence, scope, and review                                         | Accepted (appeal path and re-verification cadence pending)               |
| [0024](ADR-0024-presigned-upload-mechanism.md)                     | Cloudflare R2; the size cap is enforced at confirm                                       | Accepted (data-residency check outstanding)                              |
| [0025](ADR-0025-deferred-work-on-bullmq.md)                        | Time-driven work runs on BullMQ delayed jobs, in-process                                 | Accepted (worker topology revisited)                                     |
| [0026](ADR-0026-position-freshness-and-the-reporting-floor.md)     | Position freshness is its own bound; the budget has a floor                              | Accepted (floor's battery cost measured in EPIC 9)                       |
| [0027](ADR-0027-refresh-token-incident-retention.md)               | A reuse incident is kept whole for a year, then deleted                                  | Accepted (a legal finding may supersede it)                              |
| [0028](ADR-0028-customer-profile-at-first-run.md)                  | A customer profile comes from a first-run question                                       | Accepted (the wider first-run experience pending)                        |
| [0029](ADR-0029-customer-order-screen.md)                          | The customer's order screen is a status card, not a stepper                              | Accepted (the order list and its actions still open)                     |
| [0030](ADR-0030-customer-root-navigation-and-order-list.md)        | The customer's root is a tab bar, and one tab is the orders                              | Accepted (the master's root still a stack, deliberately)                 |
| [0031](ADR-0031-where-settings-is-reached-from.md)                 | Settings is a tab for the customer, a control for the master                             | Accepted (the master's wider root still open)                            |
| [0032](ADR-0032-realtime-transport.md)                             | socket.io on the API's own port, fanned out over Redis streams                           | Accepted (sticky sessions deferred to the hosting choice)                |
| [0035](ADR-0035-customer-tracking-map.md)                          | The customer watches the master on a map card                                            | Accepted (owner art, copy and frame rate still pending); amended by 0055 |
| [0036](ADR-0036-master-work-surface.md)                            | The master's work lives on home; the job is one pushed screen                            | Accepted (job history, tab bar open); amended by 0054                    |
| [0037](ADR-0037-conversation-screen.md)                            | Conversation screen: bubbles, receipts in words, order badge                             | Accepted (copy placeholder, keyboard unchecked on device)                |
| [0038](ADR-0038-server-calling-ahead-of-the-mobile-spike.md)       | Server half of calling proceeds ahead of the mobile spike                                | Accepted (mobile LiveKit still gated on #183)                            |
| [0039](ADR-0039-call-surfaces-and-ring-push-ahead-of-the-spike.md) | Call screens and the ring push proceed ahead of the spike                                | Accepted (calling ships dark until the room bridge)                      |
| [0040](ADR-0040-call-screens.md)                                   | The call screens: one inverse full-screen modal, four phases                             | Accepted (copy is placeholder; § 2 and § 4 by 0041)                      |
| [0041](ADR-0041-call-surface-fixed-appearance.md)                  | The call surface: one fixed appearance, toggles by glyph                                 | Accepted                                                                 |
| [0042](ADR-0042-review-policy.md)                                  | Reviews: optional, blind, windowed, counted at reveal                                    | Accepted (copy is placeholder); amended by 0045                          |
| [0043](ADR-0043-admin-panel-policy.md)                             | Admin panel: roles, password + TOTP, invitations, disputes                               | Accepted; amended by 0045, 0047, 0050 and 0051                           |
| [0044](ADR-0044-location-plausibility.md)                          | A position report implying an impossible jump is refused                                 | Accepted                                                                 |
| [0045](ADR-0045-master-portfolio.md)                               | A master's photo portfolio, seen only from an order                                      | Accepted (video, media domain, content rules pending)                    |
| [0046](ADR-0046-subscription-only-monetisation.md)                 | Revenue is master subscriptions only; no commission                                      | Accepted (launch prices, trial, grace, provider pending)                 |
| [0047](ADR-0047-subscription-administration.md)                    | Subscription roles; notice once a period has been paid for                               | Accepted                                                                 |
| [0048](ADR-0048-blue-brand-and-wordmark.md)                        | Blue `#1877F2` brand, tezUsta wordmark; amends 0011 palette                              | Accepted                                                                 |
| [0049](ADR-0049-master-subscription-surface.md)                    | A master sees their subscription on a home card and its screen                           | Accepted (copy is placeholder)                                           |
| [0050](ADR-0050-admin-customer-accounts.md)                        | Customer accounts in the panel; a suspension is the account's                            | Accepted                                                                 |
| [0051](ADR-0051-admin-password-change-and-reset.md)                | An admin changes their password; a super_admin resets one                                | Accepted                                                                 |
| [0052](ADR-0052-serving-the-admin-panel.md)                        | The admin panel is served by nginx in front of the API                                   | Accepted (edge allow-list is the owner's)                                |
| [0053](ADR-0053-party-reports.md)                                  | A party reports the other party; the admin queue closes it                               | Accepted (mobile layout and copy are a placeholder)                      |
| [0054](ADR-0054-master-profile-and-portfolio-screens.md)           | Master profile, photo grid, viewer and post editor screens                               | Accepted (copy and empty-state art pending)                              |
| [0055](ADR-0055-search-radar-and-arrival-promise.md)               | Search radar of coarse cells; arrival promise from Routes +30 s                          | Accepted (motion, colours and copy are interim)                          |
| [0056](ADR-0056-api-container-image.md)                            | The API ships as one image; migrations run as a one-off job                              | Accepted                                                                 |
| [0057](ADR-0057-subscription-billing-port.md)                      | Subscription billing port; append-only records; webhook writes                           | Accepted (provider still open; auto-renewal is #323's second half)       |
| [0058](ADR-0058-subscription-auto-renewal.md)                      | Auto-renewal: consent at checkout; one charge per period; webhook decides                | Accepted (provider still open)                                           |
| [0059](ADR-0059-sms-provider.md)                                   | SMS provider: Plivo primary, Twilio fallback, `TezUsta` to +994 mobiles                  | Accepted (accounts, budget and counsel are the owner's)                  |
| [0060](ADR-0060-inspection-price-approval.md)                      | Inspection price quoted on arrival, approved by the customer before work                 | Accepted (decline penalties wait for the cancellation rules)             |
| [0061](ADR-0061-master-web-subscription-page.md)                   | The master's web subscription page: `apps/web`, phone + OTP into a narrow cookie session | Accepted (layout, copy and the public domain are the owner's)            |
| [0062](ADR-0062-master-job-map.md)                                 | A map on the master's job screen while they are on the way                               | Accepted (marker art and copy are the owner's)                           |
| [0063](ADR-0063-master-services-screen.md)                         | The master's services screen: what they offer and what they charge                       | Accepted (copy is the owner's)                                           |
| [0064](ADR-0064-services-before-approval.md)                       | A master awaiting review can set their services                                          | Accepted                                                                 |
| [0065](ADR-0065-cahan-serif-typeface.md)                           | The mobile app's typeface is Cahan Serif, the wordmark excepted                          | Accepted                                                                 |

## Template

```markdown
# ADR-NNNN — <short title>

- **Status:** Proposed | Accepted | Pending | Superseded by ADR-MMMM
- **Date:** YYYY-MM-DD

## Context

What forced a decision. The constraints that were real at the time.

## Decision

What we chose. Specific and unambiguous.

## Why

The reasoning. Include the evidence — version metadata, benchmarks, quoted
documentation — not just the conclusion.

## Alternatives considered

| Option | Why not |

## Trade-offs accepted

What this costs us. An ADR with no trade-offs section is usually incomplete.

## Consequences

What follows for the codebase.

## Revisit when

The condition under which this should be reopened.
```
