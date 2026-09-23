# ADR-0036 — The master's work lives on their home, and the job is one pushed screen

- **Status:** **Accepted**
- **Date:** 2026-09-23
- **Amends:** [`CLAUDE.md`](../../CLAUDE.md) § 17, where the master's
  navigation pattern and "what lives at the root of their tree" were still
  listed as outstanding. This ADR settles both for the job flow. The master's
  job history is still open, and so is whether the master ever gets a tab bar.
- **Builds on:** [ADR-0030](ADR-0030-customer-root-navigation-and-order-list.md) § 2,
  which kept the master on a single stack "until they have a second
  destination worth returning to", and
  [ADR-0031](ADR-0031-where-settings-is-reached-from.md), which put settings in
  a control on the master's home.
- **Decided by:** the project owner delegated this decision for EPIC 9's
  remaining work on 2026-09-23 ("the parts that are my decision, decide
  professionally"). CLAUDE.md § 17's "stop and ask" rule is answered for the
  surfaces below and nothing more.
- **Issues:** [#199] (the surface), [#198] (the read it stands on), [#171]
  (the reporter it drives).

[#171]: https://github.com/ismetcahangirov/tezUsta/issues/171
[#198]: https://github.com/ismetcahangirov/tezUsta/issues/198
[#199]: https://github.com/ismetcahangirov/tezUsta/issues/199

## Context

The server has had the whole master side since EPIC 8: the offer feed, accept
and decline (#101), advancing the job (#134) and handing it back (#136). The
socket pushes `order:offer` and `order:transition` (#168). The master's app
showed one thing, the availability toggle. A master could not see an offer,
take a job or finish one. That also blocked #171: the reporter's `travelling`
and `working` rows, and background location at accept, need a surface that
knows a job exists.

Two facts shape the answer:

- **A master has at most one job.** `orders_one_active_per_master` is a partial
  unique index, and accept refuses a second with `MASTER_HAS_ACTIVE_ORDER`.
- **Offers are only actionable with no job and while online.** A master on a
  job who taps accept can only get a 409.

## Decision

1. **The master's root stays one stack.** Home is still the root. The
   availability card stays first, and **under it the home shows exactly one of
   three things:**
   - the **current job**, as a row that opens the job screen, when there is
     one;
   - otherwise, while online, the **offer feed**;
   - otherwise nothing, because the availability card already says the
     master is offline.

   The feed and the job are never on screen together, since the feed's buttons
   could only fail beside a job.

2. **The job is one pushed screen, `(master)/job`, with no id in the route.**
   It reads `GET /masters/me/jobs/current`. A route parameter would be a way to
   open an order the server no longer says is the master's. When the read
   answers `null` (cancelled, completed, handed back), the screen says so and
   offers the way home.
3. **One forward action at a time.** The job screen shows the next status the
   transition table allows ("Yola çıxdım", "Çatdım", "İşə başladım", "İşi
   bitirdim") as the primary button, and "Gələ bilmirəm" (re-dispatch) as a
   ghost button where ADR-0015 permits it. The re-dispatch asks for a reason in
   a sheet, because the server requires one.
4. **Accepting an offer opens the job screen.** The hand-off to navigation is a
   "Xəritədə aç" button that opens Google's directions URL (ADR-0004). No
   in-app navigation, which is out of EPIC 9's scope.
5. **The reporter, the socket rooms and background location live above the
   stack**, in `MasterWorkProvider` at `app/(master)/_layout.tsx`, not in a
   screen. The job screen is where a travelling master looks. A reporter owned
   by home would depend on the navigator keeping home mounted underneath it.
6. **No tab bar yet.** A tab bar would have "home" and "settings", which is
   the bar about settings that ADR-0030 § 2 declined. The job is not a tab,
   because it exists only while a job does. When a job **history** arrives,
   that is the second destination. Then the master gets the customer's
   pattern, and settings moves to a tab as ADR-0031 already provides.

## Alternatives considered

| Option                                  | Why not                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A tab bar now: Offers / Job / Settings  | Two of three tabs are empty most of the day, and "Job" would be a tab that is sometimes not a place.                  |
| The job as a modal over home            | The master spends the whole job on this screen. A modal says "come back soon", and it would hide the way to settings. |
| `(master)/job/[id]`                     | The server already knows the one job, so an id is only a way to be wrong. The reporter still needs the read.          |
| Keep the reporter in `AvailabilityCard` | Its life would depend on home staying mounted under the job screen, which is exactly the `travelling` stretch.        |
| Feed and job both on home               | The feed's buttons can only 409 while a job exists.                                                                   |

## Owner-owned items shipped as interim

- **All copy** in `apps/mobile/src/master-jobs/master-jobs-copy.ts` is
  placeholder, as `orders-copy.ts` is, and is listed in #199's PR.
- **No offer photos on the card.** The card shows service, distance band,
  price, description and time left. Photos are on the contract and belong on
  the card, but a thumbnail strip is a visual layout nobody has drawn. Adding
  it later is one component.
- **The empty feed** uses `EmptyState` with text only. No illustration, since
  that is owner art.

## Trade-offs accepted

- A master cannot browse offers while on a job. That is deliberate: they
  cannot take one.
- The home scrolls rather than fitting on one screen once several offers
  arrive. The feed is bounded server-side (`MAX_FEED_OFFERS`).
- The "time left" line ticks on a 15-second clock. It is a local timer, not a
  request, and it is the cost of an expired card leaving on its own.

## Consequences

- `apps/mobile/src/master-jobs/` owns the feed, the job screen and
  `MasterWorkProvider`. `AvailabilityCard` reads the reporter's status from
  context and no longer runs it.
- The `MasterJob` cache tag is invalidated by the master's own writes and by
  `order:transition`, so a customer's cancellation reaches the job screen live.
- #171's `travelling` and `working` rows are now selected from the job's
  status (`reportingStateFor`).

## Revisit when

- A job history, earnings or a schedule gives the master a second destination.
  At that point, adopt ADR-0030's tab pattern.
- The owner supplies the offer card's visual design or illustration.
