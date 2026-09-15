# Performance

Performance is a design constraint here, not a later optimisation pass. Two
things make TezUsta different from an ordinary CRUD app: a spatial query on the
critical path of every order, and a continuous location stream from every online
master.

**Measure before optimising, and measure after.** An optimisation with no
measurement is a guess that added complexity.

## Database

### The rule

**A query added to a hot path without an index is an incomplete change.**

Check with `EXPLAIN (ANALYZE, BUFFERS)`. A `Seq Scan` on a table that grows is a
defect, not a style preference.

| Anti-pattern              | Fix                                                        |
| ------------------------- | ---------------------------------------------------------- |
| N+1 queries               | Join, or batch with `IN`                                   |
| `SELECT *`                | Select the columns needed — especially with wide rows      |
| Missing FK index          | Postgres does **not** create one automatically             |
| Offset pagination         | Cursor pagination — offset breaks under concurrent inserts |
| Distance computed in Node | `ST_DWithin` against the GiST index                        |
| Unbounded list query      | Always `LIMIT`                                             |

### Spatial queries

The nearby-masters query is the one that decides whether the product works.

- `ST_DWithin` uses the GiST index. `ST_Distance` in a `WHERE` clause **does
  not** — it computes for every row.
- Cast to `::geography` for true metres.
- Filter on cheap predicates (verified, available, category) before distance
  ordering.
- `LIMIT` the candidate set — a customer never needs 500 masters.

**Forbidden:** loading all masters and sorting by distance in application code.
That is a full table scan plus an in-process sort, and it does not survive growth
([`../architecture/database-architecture.md`](../architecture/database-architecture.md)).

### Transactions

Short. **Never hold a transaction across an HTTP call** to a payment or maps
provider — that ties a database connection to a third party's latency and
exhausts the pool under load.

## API

- Handlers stay non-blocking. Anything slow goes to a BullMQ queue.
- No synchronous CPU-heavy work in a request — it blocks the event loop for
  every concurrent request, not just the one.
- Cache what is stable: the service catalogue changes rarely and is read
  constantly.
- Paginate every list endpoint from the start. Retrofitting pagination is a
  breaking change.
- Compress responses; keep payloads to what the client uses.

## Realtime and location

The highest-volume path in the system.

- **Location updates are a budget, not a stream.** Full policy:
  [`../architecture/realtime-architecture.md`](../architecture/realtime-architecture.md).
- Distance-filter **on-device** first — `expo-location`'s `distanceInterval`
  suppresses updates natively without waking the JS thread.
- Batch points where possible.
- Fan out only to the room that needs the event, never broadcast widely.
- Throttle server→client independently of ingest: the customer's map does not
  need 10-second precision.
- Event payloads carry **ids and changed fields**, not object graphs.

## Mobile

The realistic device is mid-range Android, not a flagship. Everything below is
calibrated to that.

| Concern       | Rule                                                                            |
| ------------- | ------------------------------------------------------------------------------- |
| Long lists    | `FlatList`/`FlashList` with stable `keyExtractor`. Never `.map()` a long list.  |
| Re-renders    | Memoise expensive children; keep fast-changing values out of shared context     |
| Live location | **Interpolate the marker between updates** rather than raising update frequency |
| Images        | Size and cache; never render a full-resolution upload in a list                 |
| Bundle        | Every dependency ships to the device ([CLAUDE.md §10](../../CLAUDE.md))         |
| Maps          | One map instance per screen; release on unmount                                 |
| Animation     | Reanimated on the UI thread, not JS-driven                                      |

The interpolation point is the important one: smoother tracking is a **rendering**
problem. Solving it by sending more GPS updates spends the master's battery and
the customer's data to fix something the client can do for free.

## Data fetching

- TanStack Query deduplicates, caches, and retries. **No `useEffect` + `fetch`** —
  it has none of that and races on unmount.
- **Retry transient failures only.** The shared policy is `shouldRetry` in
  `apps/mobile/src/api/query-client.ts`: two retries with backoff for a failure
  with no readable status (the common mobile-network case), and **never a retry
  on a 4xx**. A 4xx is the server saying this request, as sent, is wrong;
  resending it costs the user's data and changes nothing. `429` is worse than
  useless — retrying it burns the caller's remaining budget three times as fast
  as the server's rate limit assumes, which on OTP verify means locking the user
  out of their own sign-in.
- Set `staleTime` deliberately per resource: the catalogue is stable for minutes;
  an active order is not.
- **No uncontrolled polling.** Realtime events invalidate queries; polling is a
  fallback with a bounded interval, not a default.
- Mutations invalidate rather than hand-patching the cache, except where
  optimistic update is genuinely warranted.

## Scaling

Scale in this order ([`../architecture/system-design.md`](../architecture/system-design.md)):

1. Add API instances — they are stateless.
2. Move reads to a replica, **keeping the nearby query and order writes on the
   primary** (replica lag would offer a taken order).
3. Cache current positions in Redis, with Postgres as the durable record.
4. Scale queue workers independently.
5. Only then consider extracting a service.

**Anything that breaks statelessness is a design error** — in-memory sessions,
in-process rate-limit counters, a local queue.

## Budgets

Starting targets, to be validated with real measurement:

| Metric                   | Target                     |
| ------------------------ | -------------------------- |
| Nearby-masters query     | < 100 ms p95               |
| Order creation           | < 300 ms p95               |
| Standard API read        | < 200 ms p95               |
| WebSocket event delivery | < 1 s p95                  |
| App cold start           | < 3 s on mid-range Android |
| Screen transition        | 60 fps, no dropped frames  |

These are hypotheses until measured. Revise this table with real numbers rather
than leaving aspirational ones in place.

## Monitoring

Track, from the first deploy: request latency percentiles (p95 and p99, not
mean), nearby-query latency specifically, queue depth and job duration,
WebSocket connection count, database connection pool saturation, and slow-query
logs.

**Mean latency hides the problem.** A 50 ms mean with a 4 s p99 is a product
that feels broken to one user in a hundred.

## When optimising

1. Measure — profile, `EXPLAIN ANALYZE`, trace.
2. Find the actual bottleneck, not the suspected one.
3. Fix it.
4. **Measure again** to confirm the fix worked.
5. Record the result if the finding was non-obvious.

Do not optimise on intuition. The bottleneck is regularly not where it looks.
