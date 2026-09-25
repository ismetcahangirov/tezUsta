# ADR-0044 — A position report that implies an impossible jump is refused

- **Status:** Accepted
- **Date:** 25 September 2026
- **Context:** EPIC 15 audit (#16), issue #274
- **Supersedes:** nothing. Adds a check to the write path of
  [`realtime-architecture.md`](../architecture/realtime-architecture.md)
  § Location update budget; the budget, the floor
  ([ADR-0026](ADR-0026-position-freshness-and-the-reporting-floor.md)) and the
  rate limit are unchanged.

## Context

Dispatch ranks masters by the distance of their newest reported position
([ADR-0009](ADR-0009-dispatch-model.md)). Until this ADR, `POST
/masters/me/location` checked only that a coordinate was on the planet and
that the app was not reporting too often. A master whose phone ran a
mock-location app could report from anywhere, jump across the city between two
reports, and appear next to every order as it was created.
[`security.md`](../engineering/security.md) already named "location spoofing to
appear nearby" as marketplace abuse to design against; nothing designed
against it.

What the server knows is limited. It stamps `recorded_at` itself, so the time
between two reports is trustworthy; the coordinates are whatever the app says.
It holds each master's recent trail in `master_locations` for
`MASTER_LOCATION_TRAIL_MINUTES`. It has no accuracy, heading or speed from the
device — the body is `.strict()` over latitude and longitude only.

## Decision

1. **Compare each report with the master's previous one.** Inside the write
   transaction, before the insert, read the master's newest row **within the
   trail window** — one probe of `master_locations_master_recent_idx` — and
   measure the great-circle distance to the new fix (`ST_Distance` on
   `geography`) and the seconds since that row's `recorded_at`.
2. **Refuse when both hold:** the distance is greater than
   `MASTER_LOCATION_JUMP_FLOOR_M` (default **1 000 m**, bounded 100–50 000),
   **and** the implied speed is greater than `MASTER_LOCATION_MAX_SPEED_KMH`
   (default **200 km/h**, bounded 50–1 000).
3. **A refusal is `422 LOCATION_IMPLAUSIBLE`**, with no `details`. Nothing is
   written, nothing is pruned, presence is not refreshed, and nothing fans out
   to the customer's map. Availability and presence are otherwise untouched.
4. **No previous fix inside the trail window means no check.** The first
   report a master ever sends, and the first report after a break longer than
   the trail, are always accepted.
5. **Each refusal is logged at `warn` with the master id only** — no
   coordinate, no distance and no speed, since each is derived from a position
   (CLAUDE.md §11).
6. **The master's app drops a refused fix and carries on.** It does not resend
   that fix, tells the master nothing, and does not stop or back off. The next
   real fix is reported as usual.

## Why

**Both conditions, because each alone is wrong.** Speed alone refuses GPS
jitter: a phone indoors or among tall buildings routinely wanders a few hundred
metres between two fixes a second apart, which is hundreds of km/h on paper.
Distance alone refuses real driving the first time a report is late. The floor
keeps jitter in and the ceiling keeps driving in; a spoof has to break both.

**The thresholds.** 200 km/h is well above anything a master does on a Baku
road (the motorway limit is 110) and far below the "across the city in ten
seconds" a spoofing app produces. One kilometre is larger than ordinary urban
GPS error and well inside dispatch's search radius, so a spoof smaller than the
floor cannot move a master into a broadcast they were not already near.

**Refuse, not flag.** A flagged-but-stored fix is still the newest row, so
dispatch would still rank by it and the customer's map would still show it —
the harm happens before anybody reads the flag. Refusing means the spoofed
position never reaches the table dispatch reads. It also costs an honest
master almost nothing: their previous fix stays current, and it is at most one
floor old.

**Measured on the server, in the write transaction.** The elapsed time uses
the server's `now()`, the same instant the new row would be stamped with; a
device clock is settable and would make the check spoofable in the same way as
the coordinates. The distance is `ST_Distance` on `geography`, the same
spheroidal cast the nearby-masters query ranks by. The rule itself is a pure
function (`master-location.plausibility.ts`); the repository only measures.

**The trail window bounds the comparison.** Rows older than
`MASTER_LOCATION_TRAIL_MINUTES` can survive until the sweep (#105) reaches
them. Comparing against one would refuse a master who drove somewhere with the
app closed, which is an honest thing to do.

## Alternatives considered

| Option                                                                   | Why not                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store and flag the fix for review                                        | The flagged row is still the newest row, so dispatch and the customer's map use it anyway. Review after the fact does not undo a won offer.                                                          |
| Speed check only                                                         | Refuses GPS jitter from honest phones.                                                                                                                                                               |
| Distance check only                                                      | Refuses real driving after a late report.                                                                                                                                                            |
| Trust a client-sent `accuracy` or `speed` field                          | Both come from the same device that is lying about the coordinates. Out of scope; the body stays `.strict()` over two fields.                                                                        |
| Device attestation (Play Integrity, App Attest), mock-location detection | Stronger, and the right next step if spoofing is seen in practice — but it is a platform integration with its own availability and privacy trade-offs, not a write-path rule. Out of scope for #274. |
| Compare with a smoothed track rather than the previous fix               | More state, more tuning, and no better answer to the attack: a teleport breaks either comparison.                                                                                                    |

## Trade-offs accepted

- **A refused fix pins the master to their last accepted one until time
  passes.** The distance allowed grows with elapsed time (200 km/h is about
  3.3 km per minute). If a refused jump was in fact real — a GNSS fix that
  arrived very late, say — the master's next fixes are accepted once enough
  time has passed for the trip to have been drivable, or as soon as the phone
  reports a point near the last accepted one. Nobody has to clear anything.
- **A slow, patient spoof is not caught.** An app that "drives" a fake
  position across the city at 150 km/h passes. This check stops teleporting,
  not every lie; attestation is the answer to the rest.
- **One extra indexed read per report.** One probe of an index the
  nearby-masters query already needs, inside a transaction that already
  exists. No new index, no migration.
- **The app's stale warning can show after several refused floors.** A
  refused fix is not a fix that got through, so a phone that produces only
  implausible fixes is shown as not reporting — which is true.

## Consequences

- `MasterLocationRepository.record` measures the step from the previous fix
  and takes a predicate; `MasterLocationService.report` decides with
  `isImplausibleJump` and throws `LocationImplausibleError`.
- `ERROR_CODES.LOCATION_IMPLAUSIBLE` exists; the app reads it through
  `errorCodeOf`, as it does every other stable code.
- `MASTER_LOCATION_MAX_SPEED_KMH` and `MASTER_LOCATION_JUMP_FLOOR_M` are
  bounded integers in `env.schema.ts`, typed in `AppConfig.masterLocation`, and
  documented in `.env.example`.
- The mobile reporter has a fourth send outcome, `implausible`.

## Revisit when

- Spoofing is seen in practice despite this check — then device attestation.
- The field battery measurements (EPIC 9) change the reporting floor so much
  that consecutive fixes are regularly minutes apart, which weakens the check.
- Honest masters are refused often enough to show up in the logs — then the
  thresholds are wrong for real phones and should be measured, not guessed.
