# ADR-0053 — A party reports the other party on one order

- **Status:** Accepted for the API and the admin queue. The mobile entry point
  and form wait for the owner's design.
- **Date:** 13 October 2026
- **Decided by:** The owner, 13 October 2026, who took the recommendation:
  accept the product rules issue #330 proposes, build the server and the admin
  queue now, and leave the mobile screens to the owner's design (CLAUDE.md
  §17).
- **Context:** issue #330; EPIC 20 (#327); `admin-flow.md` § 5 and open
  question 2
- **Builds on:** [ADR-0043](ADR-0043-admin-panel-policy.md) § 9, which deferred
  reports until an app could file one, and
  [ADR-0042](ADR-0042-review-policy.md) for the window

## Decision

### 1. Who may report whom, and when

- Only the two parties to one order may report, each about the other, from
  that order.
- The customer can report only once a master is on the order. Before that
  there is nobody to report.
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

## Consequences

- The mobile app has its contract (`OwnReport`, `SubmitReportRequest`) but no
  screen yet. The entry point on the order and job screens, and the form,
  wait for the owner's design. Until then no user can file a report, and the
  queue fills only through the API.
- A master who was on an order and was replaced by a re-dispatch is no longer
  its party, and cannot report it.
- A customer whose master gave the job up cannot report that master either:
  the order names no master any more. The typical case is a master who never
  came. Letting the customer choose among the order's past masters is for the
  mobile design to decide; the conversations table already records each one.

## Revisit when

- The owner supplies the mobile design. The screens are then built against this
  contract.
- Reports show a pattern that wants an automatic flag, for example a
  threshold. That would be a new decision; nothing automatic happens today.
