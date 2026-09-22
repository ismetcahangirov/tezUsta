# ADR-0033 — A conversation is a property of an order, not of a pair of people

- **Status:** Accepted
- **Date:** 22 September 2026
- **Context:** EPIC 18, issue #175
- **Supersedes:** nothing. Closes the "In-app chat at launch" line in
  [`CLAUDE.md`](../../CLAUDE.md) § Decisions still open.

## Context

A customer and the master who accepted their order currently have no way to
reach each other. Everything two people need to settle between "accepted" and
"the master is at the door" — which entrance, which floor, whether the water
is already off, how far away they are — has nowhere to go.

There is a workaround, and it is the reason this decision could not be left
open much longer: the two parties exchange phone numbers. A number handed over
that way is permanent, leaves the platform entirely, and outlives the order it
was given for. [`security.md`](../engineering/security.md) § PII and privacy
already refuses to let a master's live position behave that way. A personal
phone number is not a weaker thing to protect.

The realtime transport is already decided and built:
[ADR-0032](ADR-0032-realtime-transport.md) put socket.io on the API's own port
with a Redis Streams adapter, #166 landed the authenticated gateway, and #167
adds authorized room joins. This ADR therefore decides _what a conversation
is_, not _how bytes move_.

## Decision

### 1. A conversation belongs to exactly one order

`conversations` has a `order_id` and nothing else identifying it. It is not a
thread between a customer and a master that accumulates across jobs.

This is the decision everything else follows from, and it is the one place this
design deliberately departs from the reference implementation it was modelled
on, where a conversation is a durable channel between two user accounts.

It follows from the order lifecycle rather than from taste:

- **Authorization has one question to answer.** "May this actor read this
  conversation?" becomes "is this actor the customer or the assigned master of
  order N?" — a question the API already answers for the order itself, in
  `orders`, against current state. A pair-scoped thread would need its own
  membership table and its own reason to exist, and would be readable by a
  master who once did a job for this customer and has no business today.
- **It has an end.** A pair-scoped thread never terminates, so "the master can
  no longer message the customer" has no moment to happen at. An order-scoped
  one closes when the order does.
- **A dispute has a transcript.** `DISPUTED` is one of the fourteen statuses in
  [ADR-0015](ADR-0015-order-lifecycle-states.md), and what the two parties
  agreed before the argument is evidence about _that job_. Scoped to a pair,
  the evidence is mixed in with unrelated conversations.

The cost is real and accepted: two people who work together repeatedly get a
new conversation each time. For a marketplace that dispatches the nearest
available master rather than a chosen one ([ADR-0009](ADR-0009-dispatch-model.md)),
a repeat pairing is not the common case, and the privacy property is worth more
than the continuity.

### 2. It opens at `ACCEPTED` and becomes read-only at a terminal status

A conversation is created when a master accepts, because that is the first
moment there is a second party — before it, dispatch is broadcasting to many
masters and none of them is _the_ master
([ADR-0013](ADR-0013-price-freeze-point.md) freezes the price at the same
instant for the same reason).

At `COMPLETED`, `PAID`, `CANCELLED`, `RESOLVED`, `REFUNDED` or `NO_MASTER_FOUND`
the conversation stops accepting messages. It is **not deleted**: both parties
and an admin can still read it, because a dispute raised after completion needs
it. `DISPUTED` and `RESOLVED` do not reopen writing — by then the argument
belongs in the dispute, with an admin present.

Re-dispatch is the edge worth naming: an order sent back out to search gets a
**new** conversation when the next master accepts. The previous master does not
inherit a channel to a customer whose job they gave up.

### 3. Messages ride the existing gateway; HTTP is the source of truth

The socket carries `message:new`, `message:read` and `typing` for an
`order:{id}`-derived room. It carries them as notifications of a change, not as
the change itself:

- Sending is an **HTTP POST**. It is the write that assigns the id and the
  timestamp, and its response is what the sender's optimistic bubble is
  reconciled against. A send that only existed as a socket frame would be lost
  by exactly the reconnection ADR-0032 already refuses to make durable.
- A reconnecting client **refetches history** over HTTP. Nothing is replayed.
  This is ADR-0032's rule, and a chat is the surface where breaking it shows up
  as missing messages rather than as a stale marker.

Read receipts and typing indicators are socket-only in the outbound direction
and socket-only inbound for typing; a read receipt is an HTTP write, because
unread counts are state.

### 4. Attachments go through the presigned-upload path, unchanged

A photo in a conversation uses the mechanism
[ADR-0024](ADR-0024-presigned-upload-mechanism.md) already specifies for order
photos: a presigned PUT to R2, a content-type allow-list, and the size cap
enforced at the **confirm** step because R2 does not implement the S3 POST form
policy. A message row references the confirmed object; an unconfirmed object is
swept the same way `order_photos` are (#92).

Nothing new is invented here, and that is the point: a second upload path would
be a second place for the cap to be wrong.

### 5. An undelivered message raises a push

If the recipient has no live socket, the message raises a notification through
the transport EPIC 10 already built (#141, #142). The notification names the
order and the sender's display name. **It does not carry the message body** —
a lock screen is not a place this system gets to put someone's words.

### 6. Where it lives in the app

The customer reaches the conversation from the order screen, pushed over it:
`(customer)/order/[id]/chat`. That follows
[ADR-0029](ADR-0029-customer-order-screen.md), which made the order screen one
status card with actions pushed over it, and
[ADR-0030](ADR-0030-customer-root-navigation-and-order-list.md), which keeps
order-scoped surfaces off the tab bar. The master reaches it from the
equivalent place in their single stack.

An unread count belongs on the order, not on a tab bar: the conversation is not
a destination the user returns to independently of the job it is about.

## Alternatives considered

**A pair-scoped conversation, as the reference implementation does it.**
Rejected for the reasons in § 1 — no termination point, a membership question
that duplicates the order's, and dispute evidence that spans unrelated jobs.

**Masked phone numbers instead of chat** (a proxy number through a telephony
provider). It is a real answer to the same problem and is considered properly in
[ADR-0034](ADR-0034-in-app-voice-calls.md), which covers calling. It does not
address the written channel at all: a repair appointment is full of things
easier to send than to say, a photo among them.

**A third-party chat SDK.** Rejected on CLAUDE.md §10: the socket, its
authentication, its Redis fan-out and its reconnection are already built and
paid for, and a vendor SDK would add a second connection, a second identity
model and a second place the conversation's authorization is decided.

**Deleting conversations when an order ends.** Rejected: a dispute can be
raised after completion, and destroying the transcript at exactly the moment it
becomes evidence is the wrong default. Retention beyond that is a policy
question for EPIC 15, not a schema one.

## Consequences

- Two strangers get a private written channel neither can reach after the job.
- `messages` grows without bound until a retention policy exists. It is indexed
  for keyset pagination by `(conversation_id, created_at, id)` and is never
  queried across conversations on a hot path.
- Repeat customers and masters do not get conversation history. Accepted.
- Message send is rate-limited per actor per order (CLAUDE.md §11). A channel
  between two strangers is an abuse surface, and EPIC 15 will want more than a
  rate limit.
- Message bodies are never logged, and never leave the server except to the two
  parties and an admin.
