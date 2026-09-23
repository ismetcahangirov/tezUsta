# ADR-0037 — The conversation screen: bubbles, receipts in words, and the count on the order

- **Status:** **Accepted** (copy is placeholder and listed below for the owner)
- **Date:** 2026-09-23
- **Amends:** [`CLAUDE.md`](../../CLAUDE.md) § 17, for the conversation screen
  and its entry points only. Illustration, motion and the rest of § 17's list
  stay the owner's.
- **Builds on:** [ADR-0033](ADR-0033-in-order-messaging.md) § 6 (where the
  conversation lives), [ADR-0029](ADR-0029-customer-order-screen.md) (the
  order screen is a status card with actions pushed over it),
  [ADR-0030](ADR-0030-customer-root-navigation-and-order-list.md) (order-scoped
  surfaces stay off the tab bar), [ADR-0036](ADR-0036-master-work-surface.md)
  (the master's job is one pushed screen) and
  [ADR-0011](ADR-0011-design-system.md) (the closed palette).
- **Decided by:** the project owner delegated the design decisions for issue
  #182 on 2026-09-23: where the design system does not settle something,
  decide professionally with existing tokens only and record it here.
- **Issue:** [#182]

[#182]: https://github.com/ismetcahangirov/tezUsta/issues/182

## Context

ADR-0033 decided what a conversation is and where the screen is reached from.
It did not decide what the screen looks like, and the design system
(`docs/design/design-system.md`) has no message bubble, no composer, no typing
indicator and no unread count. Every one of those is a visual decision
CLAUDE.md § 17 reserves for the owner. The owner delegated them for this
issue, on the condition that no new colour, spacing or radius value is
invented.

## Decision

### 1. Routes

- Customer: `/(customer)/order/[id]/chat`. `order/[id].tsx` became
  `order/[id]/index.tsx`; the router still resolves it as
  `/(customer)/order/[id]`, so no existing link changed.
- Master: `/(master)/chat/[orderId]`, pushed from the job screen. It takes the
  order id, unlike `job.tsx`, because push notifications (#180) deep-link to a
  conversation by order. A stale link lands on "there is no conversation" (the
  server answers 404), never on somebody else's.

Both are fixed; #180 links to them.

### 2. Bubbles

| Whose           | Side  | Surface           | Type         |
| --------------- | ----- | ----------------- | ------------ |
| The user's own  | Right | `inverse-surface` | `on-inverse` |
| The other party | Left  | `surface`         | `text`       |

- `rounded-md`, `px-4 py-3`. The radius is the card's; the bubble is a small
  card.
- The far edge is held by a `pl-12` / `pr-12` gutter on the row, a spacing
  token, rather than a percentage width no token defines.
- **Not lime.** Accent is a fill for the call to action (design system § 3).
  Filling every bubble with it would make the loudest colour in the system
  into background. The black pill is already "my action" (the primary button),
  so the user's own words take the same ink, and it inverts with the theme
  through its token.

### 3. Time and delivery state

- Under the text, inside the bubble, in `footnote`: the time of day only
  (`Intl` `timeStyle: 'short'`). A conversation lasts one job, so a date on
  every bubble would repeat one day down the screen. Day separators are left
  until a real transcript shows they are needed.
- The user's own messages add the state **in words**: `Göndərilir…`,
  `Göndərildi`, `Oxundu`. No tick icons. The set has none, and two grey ticks
  are a convention a user has to learn, while a word is read and spoken as it
  is. This follows the "label carries the meaning" rule of design system § 4.
- A failed send shows `Göndərilmədi` in the `danger` tone **outside** the
  bubble, on the page, with a ghost `Yenidən göndər` button beside it. It sits
  outside because `danger` on `inverse-surface` fails contrast in the light
  theme. Retry is not offered once the conversation stops being writable.

### 4. Typing indicator

A caption, `Usta yazır…` / `Müştəri yazır…`, in `text-muted` on the other
party's bubble surface. It stands where their next message will appear. It is
not three animated dots, because motion is not settled (§ 17) and a caption
says who is typing. It is a polite live region. It lapses 4 s after the last
frame, two of the server's 2 s relay intervals. A client sends at most one
typing frame per 2 s.

### 5. Composer

A multi-line field and one round button:

- The field uses the input's own `surface` fill and hairline `border`, rounded
  `lg` rather than `full`, so a message of several lines still reads as one
  field. `min-h-control-md`, and it grows to five lines of `body` (height from
  the type scale's line height and the `space.3` padding) before scrolling.
- Send is the `accent` `IconButton` with a new `SendIcon` (Lucide `Send`,
  monoline, token stroke). It is the one call to action on the screen, which
  is what lime is for.
- Send is disabled while the text is blank. The field clears when send is
  pressed, because the bubble already holds the text, and so does a failed one
  for retry.
- Once the conversation is no longer writable, the composer is **absent**, not
  disabled (ADR-0033 § 2). A neutral `Banner` takes its place and says the
  transcript can be read but not added to.

### 6. The unread count, and where the entry sits

- `UnreadBadge`: the existing accent `Badge` with the count, `99+` above 99,
  nothing at zero, and a spoken label (`3 oxunmamış mesaj`). It is a new
  component with no new shape.
- **Order screen:** a `Card` holding a `ListRow` (`Mesajlar`, a subtitle
  naming the other party, the badge and a chevron). It goes under the status
  card and the tracking map and above the order's details. What the master is
  saying is closer to "where is my order" than to "what did I ask for". It is
  shown from accept onward (`acceptedAt` set), so a finished order keeps its
  transcript with a "read only" subtitle, and an order no master ever took has
  no entry.
- **Master's job screen:** the same row, directly under the job summary and
  above the forward button.
- **Order list:** the badge on the order's row, under its status pill. Never on
  a tab bar (ADR-0033 § 6).
- The row's spoken label includes the count (`ListRow` gained an optional
  `accessibilityLabel`).

### 7. Empty and error states

`EmptyState` components with placeholder copy: "Hələ mesaj yoxdur" plus a
role-specific hint, "Yazışma yoxdur" for an order without one, and "Mesajlar
yüklənmədi" with a retry button. The **content** of these, words and any
illustration, is still the owner's (§ 17). The copy is in
`apps/mobile/src/conversation/conversation-copy.ts` and is placeholder like
every other copy file.

## Why the behaviour is shaped this way

These points are engineering rather than design, but they explain what the
screen does:

- **The optimistic bubble lives in a client slice (`outbox`), not in the
  history cache.** The server has never seen an unsent message, and the
  history is refetched after every reconnection. A failed message kept in the
  cache would be wiped by the next refetch, and the issue says a failed send is
  never silently dropped. On success the server's message goes into the
  history and the outbox entry is removed in one tick.
- **`sendMessage` does not retry at the transport** (`maxRetries: 0`). A
  message has no idempotency key, and a retried `POST` whose first response was
  lost would post the same words twice into a write-once transcript.
- **Read receipts follow viewability**, coalesced over 500 ms into one `POST`
  for the newest visible unread message. They are never sent on mount.
- **The sequence guard does not apply to message frames.** A message stamped a
  millisecond before a transition would otherwise be dropped.
- **Room joins are reference-counted**, so the conversation closing does not
  take the order's room away from the order screen underneath it.
- **The list's unread count is read in one grouped query per page**
  (`OrdersRepository.countUnreadMessagesForCustomer`), never one per row.

## Alternatives considered

| Option                                              | Why not                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lime bubbles for the user's own messages            | Spends the call-to-action colour on content and makes the one real action, send, stop standing out    |
| Check-mark icons for sent and read                  | Not in the icon set, must be learned, and needs a label for a screen reader anyway                    |
| Three animated dots for typing                      | Motion is unsettled, and dots do not say who                                                          |
| A disabled composer on a finished order             | ADR-0033 § 2 and the issue ask for it absent; a disabled field invites taps that can never work       |
| The badge on a tab                                  | ADR-0033 § 6: the conversation is not a destination apart from its order                              |
| A "Messages" button in the order screen's title row | A second control in the title competes with Back; the card row matches the screen's existing sections |

## Trade-offs accepted

- There are no date separators. A conversation that spans midnight shows times
  without dates.
- The keyboard handling is `KeyboardAvoidingView behavior="padding"` on both
  platforms, which suits Android's edge-to-edge default. It has **not** been
  checked on a physical device (the issue asks for one).
- Every copy string is placeholder.

## Revisit when

- The owner supplies motion (the typing indicator could animate), illustration
  (the empty states), or final copy.
- Conversations are seen to regularly span days (add date separators).
- Attachments land (#181). A photo bubble will need its own layout inside the
  same side and surface rules.
