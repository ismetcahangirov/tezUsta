# ADR-0027 — A refresh-token reuse incident is kept whole for one year, then deleted

- **Status:** **Accepted** (a legal finding may supersede it; nothing is built on the number)
- **Date:** 2026-09-20
- **Amends:** the retention policy in
  [`authentication.md`](../architecture/authentication.md) § Retention —
  `AUTH_INCIDENT_RETENTION_DAYS` stops being "a placeholder pending a decision"
  and becomes the decision.

## Context

Refresh-token **reuse detection** revokes the whole family and records why:
`sessions.revoked_reason = 'reuse_detected'`. That row, and the
`refresh_tokens` rows under it, are the only evidence this platform holds that
a credential was replayed — there is no separate incident table.

The retention sweep (#57) already treats it as special. `AUTH_RETENTION_DAYS`
(45) retires ordinary expired families; a `reuse_detected` family is held to
`AUTH_INCIDENT_RETENTION_DAYS` instead, validated to be at or above the
ordinary window, and both halves are asserted in
[`maintenance-sweeps.e2e.test.ts`](../../apps/api/test/maintenance-sweeps.e2e.test.ts).

**The mechanism was finished; the number was not decided.** 365 shipped as an
explicitly labelled placeholder so that nothing plausible would be lost while
the question stayed open (#126), and three separate comments in the source said
so. A placeholder that survives long enough stops being read as one, which is
how an unbounded table gets justified in the first place.

Three sub-questions were open, not one:

1. How long is a `reuse_detected` family kept?
2. Is the whole session row the right thing to keep for that period, or should
   an incident record be **reduced** — `device_id` and `user_agent` dropped —
   once the ordinary window passes?
3. Is it one window or two? The tokens and the session row need not share one.

## Decision

1. **365 days**, measured the way the sweep already measures it (`expires_at`
   past the cutoff). `AUTH_INCIDENT_RETENTION_DAYS=365` is now the decision,
   not a placeholder, and the "pending #126" wording is removed everywhere it
   appears.
2. **One window.** The `refresh_tokens` rows and the `sessions` row of a
   `reuse_detected` family are retired together.
3. **The whole row is kept, then deleted.** No reduction, anonymisation, or
   separate incident table. `user_id`, `device_id`, `user_agent` and the
   timestamps are retained for the full window and then go with it.
4. **The floor stays.** The schema still refuses a value below
   `AUTH_RETENTION_DAYS`; a theft record retired before an ordinary sign-out
   makes the longer window pointless.

This is a product and engineering judgement made by the repository owner. It is
**not** a legal finding — see _Trade-offs accepted_.

## Why

**Start from what the record is for.** It answers one question: _was this
account's credential replayed, when, and from which device?_ The question
arrives from outside — a user reporting a sign-in they do not recognise, a
disputed order, an admin looking at an account that behaved oddly. It is never
asked by the request path; nothing in the product reads these rows.

**A year is the outer edge of when that question still arrives.** Such reports
land weeks to months after the event, not years — the user notices at their
next sign-in, at the next order, at the next statement. A year covers a full
cycle of that, including a report from someone who used TezUsta in one season
and came back in the next. Past a year there is no question this product can
still answer with the row, and it is then session metadata about a person held
for no reason. CLAUDE.md §11 treats that as a defect, and every other personal
record here is bounded for the same reason: `master_locations` (#98),
`geocode_cache` ([ADR-0022](ADR-0022-geocode-cache-stores-coordinates-only.md)),
abandoned verification documents (#128), and ordinary sessions themselves.

**Why not shorter — 90 or 180.** The usual argument for cutting retention hard
is volume, and it does not apply: a `reuse_detected` family is one row per
detected replay, not traffic. Shortening buys a negligible reduction in rows
held and costs the only thing the record exists for — a late report finding
anything at all. 45 days is already the ordinary window; an incident window
close to it would not be worth having.

**Why one window and not two.** The two halves answer different parts of the
same question and neither is useful alone: the session row carries the identity
(which user, which device, which client), the token rows carry the timeline
(which token was replayed, when it was issued, when the family died). Note the
asymmetry the schema imposes — `refresh_tokens.session_id` is
`ON DELETE RESTRICT`, so tokens always go first; "two windows" can only ever
mean _tokens shorter than the session row_, which is precisely the half that
leaves an incident record with no timeline. There is no version of two windows
worth having.

**Why the whole row rather than a reduced one.** `device_id` and `user_agent`
are not incidental columns attached to the incident — they are its content. An
incident record with those dropped says that something happened to somebody at
some point, which no investigation can use. Reduction also costs more than it
saves: it means either an incident table or nullable columns plus a second,
anonymising sweep, i.e. real schema and code, paid so that a **less** useful
row can be held **longer**. Delete-at-the-boundary is both the smaller
mechanism and the stronger privacy position.

## Alternatives considered

| Option                                                                 | Why not                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 90 or 180 days                                                         | The volume argument for shorter retention does not apply to one row per detected theft, and the cost is the late report — the main case the record exists for — finding nothing.                                                                      |
| Keep indefinitely and remove `AUTH_INCIDENT_RETENTION_DAYS`            | A legitimate outcome if argued, but nothing argues it: no obligation established here reaches past a year, and no reader of these rows exists past one. "Keep forever" is what every unbounded table began as.                                        |
| Two windows — tokens retired earlier than the session row              | The FK direction means this is the only shape two windows can take, and it destroys the timeline while keeping the identity. Half an incident record is not a cheaper incident record.                                                                |
| Reduce rather than delete — drop `device_id`/`user_agent`, keep a stub | Pays schema complexity and a second sweep to retain a row that can no longer answer the question. Worse on both axes: longer retention, less usefulness.                                                                                              |
| Leave it open until legal advice exists                                | It has been open since #57 with a placeholder in three source comments, and a labelled placeholder that nobody removes eventually reads as an answer. A decided number that a legal finding can supersede is safer than an undecided one that drifts. |

## Trade-offs accepted

- **A report arriving more than a year later finds nothing.** Accepted
  deliberately: that is the boundary being drawn, not an oversight.
- **A year of `device_id` and `user_agent` for affected users.** This is PII
  held longer than an ordinary session's, justified by the row being the
  security record itself, bounded so it does not become permanent, and
  invisible to any client — no endpoint returns it.
- **This is not a legal finding.** No Azerbaijani data-protection obligation
  has been established by this repository, and this ADR does not claim one. If
  counsel later establishes a floor or a ceiling that differs, that supersedes
  this ADR with a new one — the mechanism (a bounded, configurable window with
  a validated floor) already accommodates any number in range.

## Consequences

- `AUTH_INCIDENT_RETENTION_DAYS=365` stands, now as a decision. The
  "placeholder pending #126" wording is gone from `env.schema.ts`,
  `app-config.types.ts`, `sessions.repository.ts`, `maintenance.service.ts`,
  `.env.example`, `authentication.md` and `security.md`; each now points here.
- No schema change, no migration, no new sweep. The alternatives that would
  have required them were rejected above.
- `parse-env.test.ts` now asserts the shipped default **is** 365, so the
  decided number cannot drift silently the way an unasserted default can. The
  e2e sweep test keeps its own short window — it verifies the mechanism, and a
  test that waited on production numbers would only be slower.
- `security.md` § PII and privacy no longer carries an outstanding
  retention question; the remaining legal-dimension items in CLAUDE.md §1 are
  unaffected.

## Revisit when

- Legal counsel establishes an Azerbaijani obligation that names a different
  floor or ceiling for security-incident records.
- A real incident shows an investigation needing rows that this window had
  already deleted — the first evidence that the year is the wrong edge.
- Incidents become a first-class entity with their own table and an admin
  surface (EPIC 13), at which point "what is retained" is a schema question
  again and not just a window.
