# ADR-0069 — The offer card counts down in seconds, on a one-second clock

- **Status:** **Accepted**
- **Date:** 2026-10-28
- **Decided by:** Project owner, on 28 October 2026, by delegation. Asked how
  the offer card should show the time left once the device run had shown it
  never counting down, the owner answered "hansi meslehetdise ve suretli
  olacaqsa": whatever is advisable and fastest.
- **Context:** EPIC 7 (dispatch), issue [#470]; found in the #464 device run
- **Amends:** [ADR-0036](ADR-0036-master-work-surface.md), replacing
  "Trade-offs accepted": "The 'time left' line ticks on a 15-second clock."

## Context

A dispatch offer lives 30 seconds. The card's "time left" line counted whole
minutes, so every offer read "Vaxtı bitir" from the moment it arrived and the
master never saw a countdown. The feed's clock ticked every 15 seconds, so an
expired card could stay on screen, tappable, for half of an offer's life, and
tapping it could only fail.

## Decision

1. **Under a minute left, the line reads `Qalıb: N san`**: the whole seconds
   left, rounded up. A minute or more still reads `Qalıb: N dəq`.
2. **The feed's clock ticks every second while at least one offer is on
   screen, and not at all otherwise.** An expired card leaves within a second.
3. **No new visual element.** The line keeps its place and its `caption` /
   `muted` style. A progress bar or a coloured urgency state would be a visual
   design nobody has drawn, and remains the owner's to add.

## Consequences

- The feed re-renders once a second while offers are shown. The list is
  bounded server-side (`MAX_FEED_OFFERS`), so this is cheap on a mid-range
  Android. An empty feed, which is the home most of the day, runs no timer.
- The copy is a placeholder, like all of `master-jobs-copy.ts`.

## Alternatives considered

| Alternative                     | Why not                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| A shrinking progress bar        | New visual language; not "fastest", and the owner's to design |
| Keep minutes, tick every second | Still "Vaxtı bitir" for the whole life of a 30-second offer   |
| Hide the line under a minute    | The master would have no idea how long they have              |

[#470]: https://github.com/ismetcahangirov/tezUsta/issues/470
