# ADR-0022 — The shared geocode cache stores coordinates only, for at most 30 days

- **Status:** **Accepted**
- **Date:** 2026-09-17
- **Refines:** [ADR-0004](ADR-0004-location-and-maps.md), which chose Google
  Maps Platform and required "a Postgres cache keyed by normalised address". The
  decision is unchanged; this ADR records what such a cache may legally hold,
  which ADR-0004 did not examine.

## Context

ADR-0004 and [`location-services.md`](../architecture/location-services.md) both
state, correctly, that the geocode cache is **the single largest lever on the
Google Maps bill** — the same Baku addresses recur constantly, so without a
cache the invoice grows with traffic rather than with distinct addresses. Issue
#36 asked for that cache.

What neither document examined is that Google licenses the _content_ of a
geocoding response, not just the API call. Implementing the obvious design — a
shared table keyed by normalised address, holding the whole response so both
forward and reverse lookups could be served from it — would have breached the
terms the platform is used under, silently, and in a way no test would catch.

The Maps Service Specific Terms say (verified by reading
`https://cloud.google.com/maps-platform/terms/maps-service-terms` directly, per
CLAUDE.md §9 — a summary would not have been enough for a licence question):

> **6.3.1** Customer may temporarily cache latitude (lat) and longitude (lng)
> values from the Geocoding API for up to **30 consecutive calendar days**, after
> which Customer must delete the cached latitude and longitude values.

> **6.3.2** Customer may indefinitely cache latitude (lat), longitude (lng),
> `formatted_address`, and the structured address values from the Geocoding API
> solely to support the direct, End User facing functionality of the Customer
> Application that initiated the request …, only where the cache **is not used as
> a replacement for making an additional call** to the Services. Cached data must
> be **logically isolated to the specific End User it is associated with and must
> not be used across multiple End Users**.

And the general terms:

> (b) _No Caching_. Customer will not cache Google Maps Content except as
> expressly permitted under the Maps Service Specific Terms.

A shared server-side cache read by every customer is precisely what 6.3.2
excludes, and a "replacement for making an additional call" is precisely what a
cache is. So 6.3.1 is the only clause a shared cache can live under, and it
covers coordinates and nothing else.

## Decision

**The `geocode_cache` table stores the normalised address key, latitude,
longitude, a place id, and an expiry. It stores no address text.**

- `GEOCODE_CACHE_TTL_DAYS` is capped at **30** in `env.schema.ts`, so an operator
  who sets 90 gets a boot failure naming the variable rather than a cache that
  quietly breaches the licence. The default sits at the ceiling, because a
  geocoded point does not go stale — a building does not move — so the only
  reason to expire it is the licence.
- A `geocode_cache_licence_ttl` CHECK enforces the same rule at the table, for
  rows written by a script, a fixture, or a future code path. It is anchored to
  `updated_at` rather than `created_at`, because 6.3.1 measures thirty days from
  when the value was cached and a refresh caches it again.
- A place id is kept alongside the coordinates: the terms treat it as an
  identifier rather than as content, and Google's own Geocoding policies exempt
  it from the caching restriction.
- **Reverse geocoding is not cached at all.** Its output _is_ the address text.
  The result is returned to the customer who asked and persisted only into that
  customer's own `addresses` row — which is exactly the per-End-User use 6.3.2
  describes, and is not a shared cache.

## Consequences

**Forward geocoding keeps the cost lever.** Forward lookups are the repeated
ones — every neighbour in a block geocodes the same street — and they are fully
cacheable under 6.3.1, so the cache still does the job ADR-0004 asked of it.

**Reverse geocoding pays every time, and that is accepted.** Reverse is driven by
a device's current position, which is different for every caller and rarely
repeats, so a cache would have had a poor hit rate even without the licence
question. The endpoint carries a rate limit instead, and the limit rather than
the cache is what bounds its cost.

**A forward cache hit returns coordinates without an address line.** Anything
that wants the formatted text has to call the provider, which is what 6.3.2
requires anyway ("not used as a replacement for making an additional call"). No
caller needs it today: forward geocoding exists to place a pin.

**The table needs a sweep.** Expired rows are treated as a miss on read and
refreshed in place, so nothing serves stale data — but nothing deletes the rows
that stop being looked up either. `GeocodeCacheRepository.deleteExpired` exists
and nothing schedules it yet; it becomes a BullMQ repeatable job with the Epic
that introduces the queue. Until then the table grows with distinct addresses,
which is slow, bounded by the city, and not a correctness problem — but leaving
the deletion unscheduled is a live loose end, not an oversight.

## Alternatives considered

| Option                                                   | Why not                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache the whole response in the shared table for 30 days | Breaches 6.3.2. It reads as the natural design and is the reason this ADR exists: the failure mode is a licence breach that no test, lint rule or code review would flag, because the code would look correct.                                                                            |
| Cache nothing, rely on rate limits alone                 | Throws away the lever ADR-0004 identified as the largest one available. Forward lookups genuinely repeat.                                                                                                                                                                                 |
| A per-user cache of full responses under 6.3.2           | Permitted, but it is a different thing from what issue #36 asked for, and its hit rate is close to zero — one customer rarely geocodes the same address twice. If a screen ever needs to re-display a formatted address without a call, that is where it belongs; nothing needs it today. |
| Keep the 90-day default already in `.env.example`        | Directly contradicts 6.3.1. It was written before anyone read the terms, and is the specific mistake this ADR corrects.                                                                                                                                                                   |
