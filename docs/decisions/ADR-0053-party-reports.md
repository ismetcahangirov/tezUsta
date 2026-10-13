# ADR-0053 — A party reports the other party on one order

- **Status:** Accepted. The mobile entry and form are a placeholder design,
  laid out by delegation; the copy is the owner's to approve.
- **Date:** 13 October 2026
- **Decided by:** The owner, 13 October 2026, who took the recommendation to
  accept the product rules issue #330 proposes. The owner then delegated the
  mobile design (CLAUDE.md §17) and took the recommendation for a master who
  gave the job up (§ 1, § 6).
- **Context:** issue #330; EPIC 20 (#327); `admin-flow.md` § 5 and open
  question 2
- **Builds on:** [ADR-0043](ADR-0043-admin-panel-policy.md) § 9, which deferred
  reports until an app could file one, and
  [ADR-0042](ADR-0042-review-policy.md) for the window

## Decision

### 1. Who may report whom, and when

- Only the two parties to one order may report, each about the other, from
  that order.
- The customer can report **every master who accepted the order**: the one on
  it now, and any who gave it up (read from their conversations, one per
  assigned master). With none named, the request means the master on the
  order now, or else the one who left it last. An order no master ever
  accepted has nobody to report.
- **A master who gave the job up** is reportable for the review window from
  the moment they left it. That covers the typical case of a master who never
  came. They are no longer a party themselves, and cannot report the
  customer.
- When one account holds both roles, the assigned master is resolved first, as
  everywhere else (ADR-0042).
- **When:** while the order runs, and for the review window
  (`REVIEW_WINDOW_HOURS`, seven days) after it **last** entered a status that
  ends the work: `COMPLETED`, `PAYMENT_PENDING`, `PAID`, `RESOLVED`,
  `REFUNDED`, `CANCELLED` or `NO_MASTER_FOUND`. A dispute reopens the order,
  and its resolution starts the window again. So does any later move between
  ended statuses (`COMPLETED` → `PAYMENT_PENDING` → `PAID`), unlike reviews,
  whose window runs from completion once; those payment statuses are not used
  since ADR-0046, so in practice the window runs from completion or
  cancellation. An ended order with no history row for its status falls back
  to its last update, so the window still closes.
- **Strangers:** anyone else gets the same 404 a missing order gets, so an
  order id cannot be probed.

### 2. Reasons and words

- **Reasons** come from a closed list: `no_show`, `rude_or_abusive`,
  `unsafe_behaviour`, `asked_off_platform_payment`, `damage`, `other`.
- **Free text** is optional and at most 1000 characters. Blank text is stored
  as none.
- **What the reported party sees:** neither the words nor who filed the
  report. No endpoint lets anyone read a report about themselves, and nothing
  is sent to them.
- **In the panel,** the words are rendered as text and never as markup.

### 3. One report per side and pairing, editable until claimed

- Each side files at most one report per order **and master**. A re-dispatch
  makes a new pairing: the new master never reaches the previous master's
  report and can file their own, and the customer can report the new master
  as well as the previous one.
- A second attempt on the same pairing is refused with
  `REPORT_ALREADY_FILED`; the reporter edits the first instead
  (`PUT /orders/:orderId/reports/mine`).
- A report can be edited until an admin claims it. After that,
  `REPORT_NOT_EDITABLE`.
- Filing and editing are rate-limited per user (`report-submit`).

### 4. The admin queue

- **Permissions:** `reports.read` sees the queue, and `reports.handle` claims
  and closes. Support, moderator and super_admin hold both; finance holds
  neither.
- **The queue** is oldest first, filtered by status and reason. A report moves
  `open` → `in_review` (claimed) → `closed`. A CHECK in the database holds that
  shape.
- **Closing** takes an outcome and a reason: `no_action`, `warning_recorded`,
  `master_suspended` or `customer_suspended`.
  - **A report is an allegation, not a verdict:** closing changes nobody's
    account.
  - A suspension outcome records an action the admin took on the reported
    party's own page. It is refused (`REPORT_OUTCOME_NOT_TAKEN`) when that
    page does not show it, or when it names the wrong side.
- **Audit:** reading a report (`report.read`), claiming it and closing it are
  audited. A claim and a close write their audit row in the same transaction
  as the change. The handler stays the admin who claimed it; if a colleague
  closes it, the audit row says who.
- **The dashboard section** names people, so it is filled only for an admin
  who holds `reports.read`. Everyone else gets `null` there.
- **Dashboard:** it shows the queue as it stands, and anyone reported more than
  once in the last 30 days, linked to their page.

### 5. Storage

The parties are stored as **profiles** (`customer_id`, `master_id`) plus the
reporter's side, not as the user ids the issue sketched. The reasons:

- The queue links to a customer's or a master's page and counts reports per
  subject.
- One account holding both roles is two subjects.
- There is no composite key to the order's parties, as reviews have. A report
  can be filed while the order is live, and a re-dispatch changes the order's
  master under it.

### 6. The mobile entry and form (placeholder, by delegation)

- **The entry:** a small ghost button, "Problem bildir". On the customer's
  order screen it sits under the status card; on the master's job screen it
  sits at the foot of the job. It shows only while the server says someone may
  be reported. Once a report exists it reads "Problem bildirildi" and opens
  it. A report is the exception, so nothing about the entry is loud.
- **The form** is a pushed screen, like the review's:
  `(customer)/order/[id]/report` and `(master)/report/[orderId]`.
  - "Kim haqqında?" appears only when more than one party can be reported
    (or has a report) — in practice, when the order has had more than one
    master.
  - A reason is chosen from the list, as rows with a check.
  - The words are optional, with a counter.
  - A line says the other side never sees it, then comes one button.
- **After sending:** it can be edited until it is claimed, and is read-only
  after that.
- **Built only from** the design system's components (`ListRow`, `Card`,
  `TextField`, `Button`, `Banner`, `EmptyState`) and tokens. The copy is
  placeholder Azerbaijani.

## Consequences

- `GET /orders/:orderId/reports/parties` is what the app reads: who may be
  reported, each one's window, and the caller's own report. The order and job
  screens each make this one request, and an order status change over the
  socket re-reads it. `GET …/reports/mine` takes an optional `masterId` for a
  customer's report about a master who left; without it, the default party.
- A master who was on an order and was replaced by a re-dispatch is no longer
  its party, and cannot report it.
- The owner may replace the placeholder layout or copy at any time; the
  contract does not change with them.

## Revisit when

- The owner supplies the mobile design. The screens are then built against this
  contract.
- Reports show a pattern that wants an automatic flag, for example a
  threshold. That would be a new decision; nothing automatic happens today.
