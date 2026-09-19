# ADR-0026 — Position freshness is its own bound, and the location budget guarantees a reporting floor

- **Status:** **Accepted** (the floor's battery cost is measured in EPIC 9)
- **Date:** 2026-09-19
- **Amends:** the location update budget in
  [`realtime-architecture.md`](../architecture/realtime-architecture.md)
  § Location update budget — "a stationary phone sends nothing" becomes "a
  stationary phone sends the floor and nothing more".

## Context

The nearby-eligible-masters query (issue #100) has two terms that both look
like "is this master still there", and issue #100 required the second of them
to be derived from configuration rather than invented:

| Term                                     | Where it lives                    | The question it answers      |
| ---------------------------------------- | --------------------------------- | ---------------------------- |
| Live in Redis                            | `presence:master:<id>`, a TTL key | Can we reach this app?       |
| Newest `master_locations` row is not old | Postgres, in the SQL predicate    | Is this position still true? |

The first implementation bounded the position age by `PRESENCE_TTL_SECONDS`
and wrote into [`database-architecture.md`](../architecture/database-architecture.md)
that "a position report refreshes presence in the same request … so the two
are one window described twice".

**The equivalence holds in one direction only.** A position report does
refresh presence ([`MasterLocationService.report`](../../apps/api/src/modules/masters/master-location.service.ts)),
but the converse is false: `POST /masters/me/availability/heartbeat` refreshes
presence and writes no position row at all. And the idle half of the location
budget said, in this repository's own words:

> | Online, no order | 60–120 s | 100 m |
>
> **Distance filter first.** A stationary phone sends nothing.

Put those together and the most ordinary supply state in the product
disappears. A master who is `active`, `is_available`, live in Redis,
heartbeating every 60 seconds and **parked 800 m from the customer** has no
new position row after `PRESENCE_TTL_SECONDS`. The query then drops them from
**every** broadcast until they physically move 100 m. Presence says live, the
availability screen says live, and dispatch answers `NO_MASTER_FOUND` over a
master who was four minutes away.

Widening the number does not fix it. Any fixed bound against a client that is
entitled to stay silent for as long as it is stationary deletes a parked
master eventually; a larger number only changes how long the customer waits
before the supply vanishes.

## Decision

**Two halves, and neither works alone.**

### 1. The position-age bound is its own configuration value

`DISPATCH_MAX_POSITION_AGE_SECONDS`, default **300**, range 120–3600,
surfaced as `config.dispatch.maxPositionAgeSeconds`. It is no longer
`PRESENCE_TTL_SECONDS` borrowed under another name.

The default is **derived from the reporting floor below, not chosen**: the
idle floor is at most one report per 120 s, one missed report is another
120 s, and 60 s covers a position fix taken late plus clock skew between the
phone and the database. 120 + 120 + 60 = 300.

The range's floor is the 120 s idle interval itself — below it a
budget-compliant app is dropped between two of its own reports. Its ceiling is
one hour, past which a "recent" position is a previous session's and
`MASTER_LOCATION_TRAIL_MINUTES` (default 60 minutes) has usually removed the
row anyway.

### 2. While a master is online, the app reports at least once per interval, regardless of movement

The distance filter suppresses only the **extra** reports above that floor. It
never suppresses the floor itself. This is now stated in
[`realtime-architecture.md`](../architecture/realtime-architecture.md)
§ Location update budget as a rule of the budget rather than as an
implementation detail of the app.

## Why

**Liveness is already a separate term in the same query.** The Redis presence
key answers "can we reach this app", and `NearbyMastersService` intersects on
it. The position-age bound is therefore not doing the reachability job — that
job is done, by the mechanism built for it, which expires on its own when an
app dies.

**What freshness actually protects against is a position from a previous
session.** The app was killed at location A, the master drove across town to
B, reopened the app, presence refreshed on the first heartbeat, and the first
position report has not landed yet. For that window — seconds to a minute —
Postgres holds a position that is confidently wrong, and dispatch would offer
an order sorted by a distance from where the master used to be. That is a real
failure and it is the one the bound exists for.

**A stationary master's last position is still correct.** This is the point
the first implementation missed: suppressing a redundant report is not the
same as the position going stale. A phone that has not moved 100 m in four
minutes is not a phone whose last known position is wrong — it is a phone with
nothing new to say. Once the client guarantees a floor, "no report for longer
than the floor plus tolerance" stops meaning "stationary" and starts meaning
"this app is not reporting", which is exactly what the bound should exclude.

**The floor rides on a wake-up the app already makes.** `PRESENCE_HEARTBEAT_SECONDS`
is 60 s and is deliberately aligned with the 60–120 s idle reporting interval
(issue #40) so the beat travels with a report rather than adding a wake-up of
its own. A floor report is that same wake-up carrying a payload, and
`POST /masters/me/location` refreshes presence, so for an online master with no
order the floor report **replaces** the heartbeat rather than adding to it.

**Battery, honestly.** On a mid-range Android the expensive part of a location
report is the GNSS fix, not the HTTP request; a report every 120 s with a
fresh high-accuracy fix is materially worse than one every 120 s from the
last known position. The floor therefore asks for the cheapest fix that is
still true for an idle master — `expo-location`'s last known position, falling
back to a balanced-accuracy fix — and the 10–15 s travelling cadence, where
accuracy is what the customer is watching, is unchanged. This is a hypothesis
with a reason, not a measurement: EPIC 9 must measure drain on real hardware
and revise the numbers here, which is what
[`realtime-architecture.md`](../architecture/realtime-architecture.md) already
demands of the whole table.

**Nothing deployed depends on the old wording.** EPIC 9 has not shipped and
`apps/mobile` does not call `POST /masters/me/location` at all, so this
corrects a documented hypothesis before anything is built on it rather than
breaking a budget in the field.

## Alternatives considered

| Option                                                               | Why not                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Widen the bound** (e.g. 15 minutes) and keep the budget as it is   | Changes how long it takes to delete a parked master, not whether it happens. A silent client plus any finite bound is the same defect with a slower fuse, and a 15-minute-old position is genuinely worth doubting.                                                                                              |
| **Drop the freshness term; trust Redis presence alone**              | Presence says the app is reachable, not that the position is current. The reopened-app-across-town case then broadcasts an order to a master whose distance is computed from where they used to be — and distance is the only ordering we have.                                                                  |
| **Make the heartbeat carry a position**                              | Collapses two endpoints and writes a row into `master_locations` on the 60 s heartbeat cadence whether or not anything moved. That is more PII, more often, for an idle master — the opposite of what the retention rule is for.                                                                                 |
| **Keep the latest position in Redis next to presence**               | The "likely optimisation later" in [`database-architecture.md`](../architecture/database-architecture.md), and it would make the freshness term disappear into a TTL. It also makes Redis a store of location PII with a different blast radius than Postgres. Do it on measurement, not to dodge this decision. |
| **Server-side inference: treat a heartbeat as "position unchanged"** | The server cannot know that. A heartbeat is sent by an app that may have had location permission revoked, GPS switched off, or a background-kill of the reporter — the exact states `master-flow.md` requires be surfaced rather than assumed.                                                                   |

## Trade-offs accepted

- **An idle master writes rows that say nothing new.** Around 30 reports an
  hour while parked, each one a row in the most sensitive table in the schema.
  `MASTER_LOCATION_TRAIL_MINUTES` prunes them on the write path, and the rate
  limit (600/hour) already tolerates the volume — but a master sitting at home
  now leaves a trail of their home, at 2-minute resolution, for the retention
  window. Lowering `MASTER_LOCATION_TRAIL_MINUTES` is the lever, and it cannot
  break dispatch: the latest row is never pruned.
- **Battery cost is asserted, not measured.** See above; EPIC 9 owns the
  measurement.
- **A master whose reporting is broken but whose app is alive is excluded from
  dispatch.** Permission revoked, GPS off, Android battery optimisation killed
  the reporter. That is the correct outcome — we do not know where they are —
  but it is a supply loss the master must be _told_ about
  ([`master-flow.md`](../product/master-flow.md) already requires the warning),
  not one to discover through an empty day.
- **Two windows must now be kept in a sensible relation by an operator.**
  `DISPATCH_MAX_POSITION_AGE_SECONDS` below the app's floor silently removes
  supply again; the range check and the comments are the guard, and the value
  carries its derivation rather than a bare number.

## Consequences

- `DISPATCH_MAX_POSITION_AGE_SECONDS` exists in `env.schema.ts`,
  `app-config.types.ts` and `.env.example`, and
  `NearbyMastersRepository.findCandidates` reads it instead of
  `PRESENCE_TTL_SECONDS`.
- [`realtime-architecture.md`](../architecture/realtime-architecture.md)
  § Location update budget states the floor as a rule; "a stationary phone
  sends nothing" is gone.
- [`database-architecture.md`](../architecture/database-architecture.md)
  § The nearby-masters query no longer claims the two windows are one, and
  names what each one is for.
- **EPIC 9 is bound by the floor.** A reporter that only fires on movement is
  not a compliant implementation of the budget, however much battery it saves.

## Revisit when

- EPIC 9 measures battery drain on mid-range Android and the idle interval
  moves. The default here is derived from that interval, so it moves with it.
- Current positions move into Redis, which would replace this bound with a TTL.
- Dispatch starts reporting how often a candidate was dropped for staleness —
  a number that is never zero in a healthy fleet means the floor and the bound
  have drifted apart.
