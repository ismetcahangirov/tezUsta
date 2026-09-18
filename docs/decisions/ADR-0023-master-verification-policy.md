# ADR-0023 — Master verification policy: evidence, scope, and review

- **Status:** **Accepted** (appeal path, re-verification cadence and automatic
  suspension triggers pending)
- **Date:** 2026-09-18
- **Decided by:** Project owner
- **Unblocks:** EPIC 5 —
  [#38](https://github.com/ismetcahangirov/tezUsta/issues/38) (`master_documents`,
  the verification audit trail) and
  [#39](https://github.com/ismetcahangirov/tezUsta/issues/39) (admin review)

## Context

TezUsta sends a stranger into someone's home. EPIC 5 exists to establish that
the person who rings the doorbell is who the platform says they are.

The **states** review moves a master through were already settled in
[`docs/product/user-roles.md`](../product/user-roles.md) —
`pending_verification`, `changes_requested`, `rejected`, `active`, `suspended` —
and this ADR does not touch them. The schema was never blocked either: it
carries a status and an audit trail regardless of how the policy lands.

What _was_ open, and what this ADR closes, is the **policy those states run on**:

1. **What evidence** must a master submit?
2. **What scope** does an approval carry — the whole catalogue, or one category
   at a time?
3. **Who reviews it**, and what is the path out of each negative outcome?

Inventing answers would have been a product decision taken by engineering
([CLAUDE.md §17](../../CLAUDE.md)). They were put to the owner and answered on
2026-09-18.

## Decision

### 1. Evidence: an identity document, plus a selfie holding it

A master submits exactly three files:

| `document_type`  | Meaning                                               |
| ---------------- | ----------------------------------------------------- |
| `id_card_front`  | Front of the Azerbaijani ID card (şəxsiyyət vəsiqəsi) |
| `id_card_back`   | Back of the same card                                 |
| `selfie_with_id` | The master holding that card, face visible            |

**The selfie is not ceremony — it is the whole point.** A photograph of an ID
card proves that someone possesses an image of a document, which is exactly what
a stolen or purchased document also proves. The selfie is what binds the
document to the person standing in the customer's hallway. Identity evidence
with no link to a living person is not identity evidence.

Professional certificates and diplomas are **not required**. In this market most
competent plumbers, locksmiths and electricians hold none, so demanding one
would reject the supply the platform exists to aggregate — while doing nothing
about the risk the platform actually carries, which is _who the person is_, not
what they were taught.

`document_type` is a Postgres enum, so an unrecognised value is refused by the
database and not only by Zod. It is extensible: adding `trade_certificate` later
is a migration that appends an enum value, and no row already written becomes
wrong.

### 2. Scope: verification is blanket, not per-category

**One approval. The master may then offer any active service in the catalogue.**

Per-category verification was rejected for launch. It multiplies the admin
review queue by the number of categories a master offers; it puts a status on
every `master_services` row, so "am I verified?" stops having a single answer;
and it buys a precision nothing yet supports — a reviewer holding an ID card has
no basis for deciding that this person may do electrical work but not plumbing.

The schema consequence: **verification status lives on `masters`, and
`master_services` carries no status of its own.** If the policy later tightens,
the migration adds a status to `master_services`. The reverse — retiring a
per-row status that dispatch already reads — is the expensive direction, which
is why the cheap direction is the one left open.

### 3. Review: a human admin, and the two negative outcomes are not the same

Review is manual, by an admin, through the endpoints in
[#39](https://github.com/ismetcahangirov/tezUsta/issues/39). No automated
document analysis at launch: there is no volume that justifies it, no labelled
data to tune it against, and a false reject silently removes a master with no
recourse.

| Admin action | Resulting status    | Reason required | What the master can do next           |
| ------------ | ------------------- | --------------- | ------------------------------------- |
| Approve      | `active`            | no              | Set up services, go online            |
| Request more | `changes_requested` | **yes**         | Replace or add the named documents    |
| Reject       | `rejected`          | **yes**         | **Not resubmit** — appeal is the path |
| Suspend      | `suspended`         | **yes**         | Nothing; all sessions revoked         |
| Reinstate    | `active`            | no              | Go online again                       |

This preserves the distinction already drawn in
[`docs/product/master-flow.md`](../product/master-flow.md):
`changes_requested` asks for an action the master can take; `rejected` must not
pretend there is one. A `changes_requested` reason therefore **names what is
missing** — it is an instruction, not a verdict — while a `rejected` reason is
the decision itself. Both are shown to the master, so neither may carry an
internal note.

**The appeal path out of `rejected` is still open** and is out of scope here: it
is an operational channel (who hears it, on what basis), not a schema question.
The audit trail records every attempt either way.

## Consequences

- `masters.verification_status` is the single authority on whether a master may
  accept work, re-read from the database on every accept — never from a token
  claim, which is stale the instant an admin suspends someone
  ([`docs/architecture/authentication.md`](../architecture/authentication.md)).
- Suspension revokes all of that master's sessions. Access tokens already issued
  stay valid for up to fifteen minutes, which is precisely why the eligibility
  check re-reads status rather than trusting the claim.
- `master_verification_history` is append-only — from-status, to-status, actor,
  reason, timestamp. A trust decision with no record of who made it is
  indistinguishable from an attacker's.
- **`deleted` is not a value of `verification_status`.** The state table in
  user-roles.md lists it as an account state, but `masters` already carries
  `deleted_at`, which is the convention in
  [`docs/architecture/database-architecture.md`](../architecture/database-architecture.md).
  Encoding deletion in both places creates two sources of truth that can
  disagree, and the first symptom would be a soft-deleted master who is still
  dispatchable. Deletion is `deleted_at IS NOT NULL`; the enum carries the five
  review states only.
- The three document types are the **required set for approval**, and the
  database does not enforce "all three present". A master uploads them one at a
  time, and a half-finished submission is a legitimate intermediate state.
  Completeness is checked when the master submits for review, not on insert.
- Verification documents are identity documents — the most sensitive data
  TezUsta holds. Private bucket, server-generated keys, short-lived presigned
  GETs, readable by the owning master and admins only
  ([ADR-0005](ADR-0005-object-storage.md), CLAUDE.md §11). An admin _reading_
  them is itself an audited action: a read is an action.

## Alternatives considered

| Alternative                         | Why not                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ID card only, no selfie             | Proves possession of an image, not identity. The single failure this gate exists to prevent is the one it would not catch.                                         |
| Mandatory trade certificate         | Rejects most of the real supply in this market, for a signal unrelated to the risk being managed.                                                                  |
| Optional certificate with a badge   | Defensible, but a trust badge is a **product feature** — its meaning, its UI, its effect on dispatch — not part of the identity gate. The enum can take it later.  |
| Per-category verification           | Admin cost scales with categories, a reviewer has no basis for the distinction, and it is expensive to reverse once dispatch reads a per-row status.               |
| Automated document checks at launch | No volume, no labelled data, and a false reject silently removes a master with no recourse.                                                                        |
| `rejected` as a resubmission state  | Would collapse `rejected` into `changes_requested`, which user-roles.md separated deliberately: the app could no longer tell the master which of the two happened. |

## Still open, deliberately

| Question                                                                               | Why it is not answered here                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| The appeal path out of `rejected`                                                      | An operational channel, not a schema or policy shape                                |
| Re-verification cadence — whether an approval expires                                  | No column is added speculatively                                                    |
| What **automatically** suspends a master (rating floor, cancellation rate, complaints) | Needs data that does not exist before launch; admin suspension is manual until then |
