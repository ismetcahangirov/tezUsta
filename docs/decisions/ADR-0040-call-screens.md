# ADR-0040 — The call screens

- **Status:** Accepted
- **Date:** 2026-09-24
- **Decided by:** the project owner delegated the design decisions in EPIC 18
  on 2026-09-24 ("decide professionally, do not ask"). This records a decision
  CLAUDE.md §17 otherwise reserves for the owner.
- **Issues:** [#188]

[#188]: https://github.com/ismetcahangirov/tezUsta/issues/188

## Context

#188 asks for four surfaces — outgoing, incoming, in-call and ended — built
from the design system's components and tokens and driven by the reducers from
#187. The design system ([`design-system.md`](../design/design-system.md))
settles colour, type, spacing and the component inventory. It does not say how
a call looks, where it is presented, or what it says. Those are decided here.

## Decision

### 1. One screen, four phases, presented over everything

A call is a **full-screen modal** at the root of the router, not a screen inside
the order stack: `app/call/outgoing/[orderId]` and `app/call/incoming/[callId]`,
both `presentation: 'fullScreenModal'`, gestures disabled so a swipe cannot
dismiss a live call. One `CallScreen` component renders whichever phase the
reducer is in; the two routes differ only in which hook drives it. A screen
that decided anything about the call would be a second state machine (#188).

The ringing call itself lives in a small Redux slice (`ringingCall`), written
by the root when a `call:incoming` frame arrives or a push is confirmed with
the server (#189). The slice holds the `Call` contract and never a credential.

### 2. The inverse surface

The call surface is **inverse in both themes** — `inverse-surface` behind,
`on-inverse` for type — the treatment design-system § 7 already gives surfaces
that are "a mode apart from the product". A call is exactly that, and the
inverse surface is the one place § 3 allows lime as type, which the running
duration uses.

### 3. Layout, top to bottom

1. The other party's `Avatar` (initials; the existing component), large.
2. Their display name — the name the server already sends on every call frame.
   Never a phone number; there is none to show.
3. The service name of the order, muted.
4. A status line, in words: calling, incoming, connecting, the duration
   (`m:ss`, from `connectedAt`), reconnecting, or the end reason.
5. The control row, pinned to the bottom safe area.

While **reconnecting**, the status line reads reconnecting and the duration
keeps its place but is muted, so the screen looks recovering rather than
frozen.

### 4. Controls

Round `IconButton`s with Lucide icons, labelled for screen readers, in one row:

| Phase                 | Controls, left to right                                 |
| --------------------- | ------------------------------------------------------- |
| outgoing              | cancel (`danger`)                                       |
| incoming              | decline (`danger`), accept (`accent`, `on-accent` icon) |
| connecting            | hang up (`danger`)                                      |
| active / reconnecting | mute (toggle), speaker (toggle), hang up (`danger`)     |
| ended                 | a single close button (the standard `Button`)           |

A toggle shows its state by fill — `on-inverse` when on, `surface-alt` when
off — and by its accessibility state, never by colour alone.

### 5. The ended screen stays until closed

It names the end reason in words, one message per reason, and never the word
"error". It does not dismiss itself: motion and timing are the owner's
(design-system § 9), and a screen that vanishes on a timer is a timing
decision. Closing returns to wherever the call was presented over.

### 6. The entry point

A phone `IconButton` in the order screen's status card and in the conversation
screen's header, for both roles, rendered only while the order is in a status
a call is allowed in (the server's rule, mirrored) **and** `CALLING_ENABLED` is
on ([ADR-0039](ADR-0039-call-surfaces-and-ring-push-ahead-of-the-spike.md)).

### 7. Copy

Every string is **placeholder copy**, in Azerbaijani because `az` is the
required locale, collected in one `call-copy.ts` and labelled as placeholder —
the same arrangement as `notification-copy.ts` and `conversation-copy.ts`.

## Alternatives considered

| Option                                       | Why not                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A call screen inside the order stack         | A call has to be reachable from anywhere the app is, including a ring over an unrelated screen.         |
| The ordinary `bg` surface                    | Indistinguishable from the rest of the product at a glance, and forbids lime type on the light theme.   |
| Accept as a slide gesture, as on a system UI | A gesture is motion, which is the owner's, and a slider is a component the design system does not have. |
| Auto-dismissing the ended screen             | A timing decision, and it hides the one sentence that says why the call ended.                          |

## Trade-offs accepted

- Four phases on one component make it the largest component in the app. It is
  split by phase internally; the route stays thin.
- The inverse surface ignores the user's theme setting for the length of a call.

## Revisit when

The owner supplies motion, a ringtone, or illustration; or a system call UI
(`CallKit` / `ConnectionService`) is adopted, which replaces the incoming
surface on a locked phone.
