# ADR-0049 — Where a master sees their subscription

- **Status:** Accepted (copy is placeholder)
- **Date:** 11 October 2026
- **Decided by:** Project owner, 11 October 2026, choosing option A of three
  offered on issue #325: a card on the master's home and a screen of its own.
- **Context:** issue #325; EPIC 14 (#15); [ADR-0046](ADR-0046-subscription-only-monetisation.md) § 5 and § 7
- **Amends:** [ADR-0036](ADR-0036-master-work-surface.md) — the master's home
  gains a card above the availability card, and the master's stack gains one
  pushed screen. The home is otherwise unchanged.

## Context

A master's subscription decides whether they receive work (ADR-0046 § 5).
When it lapses, the offer feed goes quiet and going online is refused. Without
a place in the app that says so, the master sees an empty feed and no reason
for it. CLAUDE.md § 17 makes where that place is, and how its warnings look,
the owner's decision. Three options were offered:

- **A.** A card on the home, above the availability card, that opens a
  subscription screen.
- **B.** A row in settings, with a banner on the home only when there is a
  warning.
- **C.** A banner on the home when there is a warning, and nothing else.

The owner chose **A**.

## Decision

1. **A subscription card sits on the master's home, above the availability
   card.** It shows the status as a `StatusPill`, until when the period runs,
   and the queued period if one is paid for in advance. A `Banner` inside it
   carries the three warnings:
   - **three days before the end**, with nothing queued after it: neutral tone
   - **in grace**: danger tone
   - **expired**: danger tone

   Tapping the card opens the subscription screen. A master with no
   subscription yet sees that a trial starts when verification approves them.

2. **The subscription screen, `/(master)/subscription`, is pushed over the
   home.** It shows the status, the period (monthly, yearly, the trial or
   granted days), the period end, the grace end, the queued period, and
   whether work is coming. It ends with a neutral line: renewing happens
   outside the app. **It shows no price, no link and no button to buy**
   (ADR-0046 § 7).
3. **A refusal to go online explains itself.** When the server refuses with
   `SUBSCRIPTION_INACTIVE`, the availability card shows why, with a button to
   the subscription screen.
4. **Every subscription push opens the subscription screen** (#326).
5. **Nothing new to look at.** The card and the screen are built from
   `Card`, `ListRow`, `StatusPill`, `Banner`, `Divider` and `Button`, with the
   design system's tokens.

## Consequences

- The card and the screen read `GET /masters/me/subscription` again whenever
  the home or the screen comes back into focus, and after a refusal for the
  subscription. That covers coming back from a push and from another app.
- A response the app cannot read hides the card instead of breaking the home.
- The copy is a placeholder (`master-subscription-copy.ts`), the owner's to
  approve, like the rest of the app's copy.

## Revisit when

- Subscriptions can be bought in the app. ADR-0046 § 7 rules that out today.
- The master's root gains a tab bar (ADR-0036). The subscription may then
  belong in a profile or account tab rather than on the home.
