# ADR-0042 — Reviews are optional, blind, windowed, and counted at reveal

- **Status:** Accepted
- **Date:** 24 September 2026
- **Context:** EPIC 11, issue #12
- **Supersedes:** nothing. Closes the "is reviewing mandatory, skippable, or
  promptable later?" line in [`customer-flow.md`](../product/customer-flow.md)
  § Review and in the Epic itself.

## Context

EPIC 11 gives both sides a trust signal: the customer rates the master, the
master rates the customer, and the ratings aggregate. Three things about it are
already settled by the product documents and are not reopened here:

- a review needs a **completed order between exactly those two parties**
  ([`user-roles.md`](../product/user-roles.md) invariant 5);
- reviews run **both ways**;
- **neither side sees the other's review until both have been submitted or the
  review window closes**, so nobody writes in reply to a visible review.

The storage shape is also settled: `masters.rating_sum` and
`masters.rating_count` already exist as an exact integer pair, with a CHECK
that the pair describes a real set of one-to-five ratings
([`database-architecture.md`](../architecture/database-architecture.md)).

What was left open is everything that turns those rules into behaviour: whether
reviewing is required, how long the window is, what a review contains, when it
counts, who can read it, and how an admin removes one. The owner delegated these
decisions. Nothing here depends on the payment provider — a review is not a
payment outcome.

## Decision

### 1. Reviewing is skippable and promptable later — never mandatory

A party is **asked** to review when the order reaches `COMPLETED`, is
**reminded once**, and may ignore both. Nothing is gated on a review: not the
next order, not accepting the next offer, not payment.

| Option               | Why not                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mandatory            | A forced rating is noise: the person who wants to get on with their day taps five stars, or one, to make the screen go away. For a master it would also put an arbitrary obstacle between them and their next job — the thing ADR-0036's work surface exists to remove. Every mainstream marketplace that could force it (ride-hailing, delivery) does not, for this reason. |
| Skippable, no prompt | Reviews would come only from the angry and the delighted, which is the distribution that makes an average meaningless.                                                                                                                                                                                                                                                       |

**The prompt** is a card on the order's own screen — the customer's status card
at `(customer)/order/[id]` and the master's job screen at `(master)/job` —
shown while the order is reviewable by the reader and they have not reviewed it.
The card opens the review screen (§ 8).

**The reminder** is one push, **24 hours** after `COMPLETED`, to each party who
has not reviewed yet, in a new switchable notification category
`review-reminders` (default on). One, not a series: a second reminder for an
optional act is nagging, and it is the push a user turns notifications off over.

### 2. The window is seven days from `COMPLETED`

A review may be submitted from the moment the order enters `COMPLETED` until
**seven days** after that moment. The start is the `COMPLETED` row in
`order_status_history`, not the order's current status timestamp, so a later
move to `PAYMENT_PENDING`, `PAID` or `DISPUTED` neither restarts nor ends the
window.

Seven days because a household repair is judged over days, not minutes — a
leak that returns tomorrow is the review that matters — and because the window
is also how long a submitted review stays hidden when the other party never
writes theirs. Longer than a week and that first review is withheld from the
aggregate for too long; shorter than a few days and the repair has not had
time to fail.

**Reviewable statuses** are `COMPLETED`, `PAYMENT_PENDING`, `PAID`, `DISPUTED`,
`RESOLVED` and `REFUNDED` — everything "`COMPLETED` or later" means in
[`user-roles.md`](../product/user-roles.md). A dispute neither blocks nor
removes a review: the dispute is an order state and its outcome is money
(ADR-0015); a review is an opinion, and a customer in a dispute is exactly the
customer whose opinion other customers want.

The window length is server configuration (`REVIEW_WINDOW_HOURS`, default
`168`), like every other timing in this codebase, so tuning it is not a deploy
of new logic.

### 3. Blind until both have written or the window closes

A review is **sealed** when submitted and **revealed** at the first of:

- the second party's review is submitted — both are revealed in the same
  transaction, together;
- the window closes — whatever exists is revealed then.

While sealed, a review is visible to its **author only**. After reveal it is
visible to the party it is about (§ 6). The reveal is a stored timestamp,
`revealed_at`, not a computed condition, so "is this visible?" is a column read
and the moment of reveal is recorded.

Window close is driven by a **deferred job scheduled when the order enters
`COMPLETED`**, due at window end (the queue from ADR-0025), backed by a
**recurring sweep** that reveals any sealed review past its window. The job is
the fast path; the sweep is what makes a lost job, a Redis flush or a deploy
during the due time harmless. Both are idempotent: revealing is a guarded
`UPDATE … WHERE revealed_at IS NULL`.

### 4. An author may edit until reveal, never after

A sealed review may be changed by its author — the rating, the comment, or
both. A revealed review is frozen. Editing after reveal would reopen the exact
thing blindness prevents: reading the other side's review and then rewriting
your own in reply.

There is no author-side delete. Skipping is how you decline to review; a
review, once revealed, is part of the record, and the only way it leaves is
moderation (§ 7).

### 5. A review is a 1–5 rating and an optional comment of at most 500 characters

- **Rating:** an integer from 1 to 5. No half stars — nobody can tell a 3.5 from
  a 4 about a plumber, and an integer is what the existing
  `rating_sum <= rating_count * 5` CHECK already assumes.
- **Comment:** optional, plain text, **at most 500 characters** after trimming.
  Control characters other than newline are stripped; empty after trimming is
  stored as `null`. Long enough for "arrived late but fixed it properly and
  cleaned up", short enough that a review is not an essay nobody reads on a
  phone.
- **No tags, no photos, no per-dimension scores** (punctuality, quality,
  price). Each is a product surface in its own right and none is needed for the
  first trust signal.

Review text is **untrusted input displayed to other people**. It is stored as
written and never interpreted: React Native's `Text` renders it as characters,
and the admin panel (EPIC 13) must render it escaped. It is never interpolated
into a push notification.

### 6. Aggregates count revealed, unremoved reviews only — and customers get one too

The customer's rating of a master updates `masters.rating_sum/rating_count`;
the master's rating of a customer updates a new, identical pair on `customers`
with the same CHECK.

**The aggregate changes at reveal, not at submission.** If the master's number
moved the moment the customer submitted, a master with few reviews could read
the sealed rating off the difference — blindness defeated by arithmetic. So
the increment happens in the reveal transaction, and a sealed review
contributes nothing.

It follows that editing a sealed review never touches an aggregate, and that
the aggregate always equals the sum over revealed, unremoved reviews. That
equality is the invariant, and it is checkable: a **recalculation** routine
recomputes both pairs from `reviews` for one profile or all of them, and is the
repair path if the incremental maintenance is ever found to have drifted. It is
not run on reads.

**Who sees what:**

| Reader                            | Sees                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The author                        | Their own review, sealed or revealed                                                                                    |
| The reviewed party                | Revealed, unremoved reviews about them — rating and comment. They know who wrote each one: an order has one counterpart |
| The customer on an accepted order | The assigned master's average and count, on the status card                                                             |
| The master on an accepted job     | The customer's average and count, on the job screen                                                                     |
| An admin                          | Everything, including removed reviews and their removal reason                                                          |
| Anybody else                      | Nothing                                                                                                                 |

Two deliberate absences:

- **No public review feed.** Comments are shown to the person they are about,
  not to every future customer. A public feed of free text needs a moderation
  queue someone actually works, and that is EPIC 13. The aggregate is the
  public trust signal until then.
- **The customer's rating is not on the broadcast offer card.** The offer card
  carries five things and nothing else
  ([`master-flow.md`](../product/master-flow.md) § Receiving an offer, and the
  `MasterOffer` contract), because everything on it goes to every master in
  range, including all those who never take the job. A customer's average and
  count is a stable identifier across broadcasts and an invitation to decline
  customers by score before seeing the job. The master sees it once they have
  accepted — and can still send the job back out if it matters to them.

An average is shown with its count, and a profile with no revealed reviews has
**no** rating, not a zero (the existing `ratingAverage: number | null`
contract).

### 7. Moderation is removal with a recorded reason, by an admin only

An admin removes a review with a mandatory reason. Removal sets
`removed_at`, `removed_by_admin_id` and `removal_reason` on the row — it is a
soft removal, because the record of what was said and why it was taken down is
exactly what a later complaint needs — and writes an `admin_audit_log` entry
(user-roles invariant 6). If the review had been revealed, the aggregate is
decremented in the same transaction.

A removed review is invisible to its subject and no longer counts; its author
still sees their own words, marked as removed, so the removal is not a silent
disappearance to the one person who knows it existed. There is no restore in
this Epic: undoing a moderation decision is a moderation-UI feature (EPIC 13),
and a wrongly removed review can be re-counted by the recalculation once a
restore exists.

The API ships now; the screen an admin uses it from is EPIC 13.

### 8. The review screen is one pushed screen per role

Reviewing is a pushed screen, mirroring the conversation screen (ADR-0037): at
`(customer)/order/[id]/review` and `(master)/review/[orderId]`. It holds five
star toggles, a multi-line `TextField` with a live character count, and one
primary `Button`. Existing design-system components only; the star is a new
glyph in `icons.tsx` drawn to the existing icon grid, outlined when off and
filled in `accent` when on. The reminder push deep-links here.

A pushed screen rather than a `Sheet`, because the comment field is a keyboard
surface and a sheet that has to rise over the keyboard on a mid-range Android
device is the layout bug this app has avoided so far. The master's route sits
outside `(master)/job` because the job screen stops being the master's current
job the moment it completes, and a reminder tapped a day later must still land
somewhere.

**Copy is a placeholder**, like every other screen's, and is listed for the
owner's acceptance.

### 9. Submission is rate limited per user

`POST` and `PUT` on reviews go through the existing `RateLimitGuard` at
**10 requests per user per hour**. The uniqueness constraint already makes a
second review of the same order impossible; the limit is about the edit path
and about scripted probing of order ids, and ten is several times what an honest
user produces in an hour.

## Integrity: constraint and service, not one or the other

The Epic asks for both. The database carries what it can express:

- `reviews.order_id` references `orders`, and a **composite foreign key**
  `(order_id, customer_id, master_id) → orders (id, customer_id, master_id)`
  makes a review about any other pair of people unrepresentable. (`orders`
  gains the unique index this needs; `master_id` is non-null on the review.)
- `UNIQUE (order_id, author_role)` — one review per side per order.
- `CHECK (rating BETWEEN 1 AND 5)`, `CHECK (char_length(comment) <= 500)`, and
  a CHECK tying the three removal columns together (all set or none).
- `customers.rating_*` gets the same aggregate CHECK as `masters`.

The service carries what a CHECK cannot see across tables: the caller is that
side of that order, the order is in a reviewable status, and the window is
open — read under `FOR SHARE` on the order row inside the insert's
transaction, so a concurrent status change cannot slip between the check and
the write.

## Trade-offs accepted

- **A first review can stay hidden for a week.** If the other side never
  writes, the diligent reviewer's rating reaches the aggregate only at window
  close. That is the price of blindness, and seven days bounds it.
- **Masters cannot screen customers by rating before accepting.** They can
  after, and can re-dispatch. Protecting the broadcast card is worth more than
  a pre-accept filter.
- **No public comments.** Customers choosing between masters get an average and
  a count, not stories. This is the part most likely to be revisited, and it is
  revisited together with the moderation UI.
- **One reminder.** Some reviews that a second nudge would have produced are
  lost.

## Consequences

- EPIC 11 is decomposed into sub-issues for the schema, submission and reveal,
  window close and recalculation, moderation, rating exposure, the reminder,
  and the two mobile surfaces.
- `NotificationCategory` gains `review-reminders`.
- `customers` gains `rating_sum` and `rating_count`; `orders` gains a unique
  index on `(id, customer_id, master_id)`.
- [`customer-flow.md`](../product/customer-flow.md),
  [`master-flow.md`](../product/master-flow.md) and
  [`CLAUDE.md`](../../CLAUDE.md) record the decision.

## Revisit when

- EPIC 13 ships a moderation queue — then reconsider a public comment feed.
- Real data shows a review rate low enough that a second reminder, or an
  in-app prompt at next launch, is worth its annoyance.
- Matching starts weighting rating (deliberately deferred, EPIC 7) — then the
  minimum count before an average is trusted needs deciding.
