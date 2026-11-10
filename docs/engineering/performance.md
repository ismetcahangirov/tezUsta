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

| Anti-pattern                             | Fix                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| N+1 queries                              | Join, or batch with `IN`                                                                                                      |
| `SELECT *`                               | Select the columns needed — especially with wide rows                                                                         |
| Missing FK index                         | Postgres does **not** create one automatically — enforced by `apps/api/test/foreign-key-indexes.schema.test.ts` (issue #288)  |
| Offset pagination                        | Cursor pagination — offset breaks under concurrent inserts                                                                    |
| Distance computed in Node                | `ST_DWithin` against the GiST index                                                                                           |
| Unbounded list query                     | Always `LIMIT`                                                                                                                |
| Batched `delete … in (select … limit n)` | `id = any(array(select … limit n))` — the `in` form plans as a semi-join that reads the whole table to find the batch (#289)  |
| Non-sargable-only filter                 | Add a plain range beside it (`col <= greatest($a, $b)` next to a `case`) so an index can narrow before the expression decides |

### Hot-path inventory

Every query that runs per request on a frequently called endpoint, per
dispatch round, per socket event or per sweep tick, with the index that serves
it and the test that proves it (issue #289). A new hot-path query gets a row
here **and** a probe in
[`hot-path-plans.schema.test.ts`](../../apps/api/test/hot-path-plans.schema.test.ts).

That file runs each query **through its repository** — a Drizzle logger
captures the exact statement and parameters — against a production-shaped seed
(tens of thousands of orders, a live minority, a sweep backlog that is a
sliver of its table), `ANALYZE`d, and walks `EXPLAIN (FORMAT JSON)`: no
`Seq Scan` and no full index scan on a growing table. Each probe states its
claim. **Planner** means `enable_seqscan` was left on — this is the plan the
planner chooses. **Can serve** means it was turned off, because at the seeded
size a hash over the whole table is honestly cheaper; the claim is then that
the keyed path exists for when it is not.

| Query                                           | Where                                                                                         | Index                                                                                                | Claim                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Customer's order list (both pages)              | `OrdersRepository.listForCustomer`                                                            | `orders_customer_created_idx` / `orders_customer_status_idx`                                         | Planner                                                                                        |
| Unread badges on the order list                 | `OrdersRepository.countUnreadMessagesForCustomer`                                             | `conversations_one_open_per_order`, `messages_unread_idx`                                            | Planner                                                                                        |
| One order, for its customer                     | `OrdersRepository.findByIdForCustomer`                                                        | `orders_pkey` (or `orders_id_parties_unique`), `masters_pkey`                                        | Planner                                                                                        |
| One order, unscoped (photo path)                | `OrdersRepository.findById`                                                                   | `orders_pkey` (or `orders_id_parties_unique`)                                                        | Planner                                                                                        |
| Open-order count at creation (#273)             | `OrdersRepository.createSearching`                                                            | `orders_customer_status_idx`                                                                         | Planner                                                                                        |
| Idempotency lookup at creation                  | `OrdersRepository.createSearching`                                                            | `orders_customer_idempotency_key_unique`                                                             | Planner                                                                                        |
| Master's live offer feed                        | `MasterOffersRepository.listLiveForMaster`                                                    | `order_offers_master_status_created_idx`                                                             | Planner                                                                                        |
| Master's current job                            | `MasterOffersRepository.findEngagedJob`                                                       | `orders_one_active_per_master`, `order_offers_order_master_unique`                                   | Planner                                                                                        |
| Conversation messages (both pages)              | `ConversationsRepository.listMessages`                                                        | `messages_conversation_created_idx`                                                                  | Planner                                                                                        |
| Conversation unread count                       | `ConversationsRepository.countUnreadFor`                                                      | `messages_unread_idx`                                                                                | Planner                                                                                        |
| An order's open conversation                    | `ConversationsRepository.findOpenByOrderId`                                                   | `conversations_one_open_per_order`                                                                   | Planner                                                                                        |
| Which order a reporting master is on            | `OrdersRepository.findEngagedOrderIdForMaster`, `MasterLocationRepository.findEngagedOrderId` | `orders_one_active_per_master`                                                                       | Planner                                                                                        |
| Master's latest position (#274) and trail prune | `MasterLocationRepository.record`                                                             | `master_locations_master_recent_idx`                                                                 | Planner                                                                                        |
| A user's devices for push fan-out               | `DevicesRepository.listAddressableByUser`                                                     | `devices_user_id_live_idx`                                                                           | Planner                                                                                        |
| Nearby masters for a dispatch round             | `nearbyMastersQuery`                                                                          | `master_locations_position_idx` (GiST)                                                               | [`nearby-masters.integration.test.ts`](../../apps/api/test/nearby-masters.integration.test.ts) |
| Dispatch state and search start                 | `OrdersRepository.findDispatchState`                                                          | `orders_pkey`, `order_status_history_order_idx`                                                      | Planner                                                                                        |
| Closing an order's live offers                  | `OrderOffersRepository.expireLiveOffers`                                                      | `order_offers_order_master_unique`                                                                   | Planner                                                                                        |
| Dispatch reconciler                             | `OrdersRepository.listStaleSearching`                                                         | `orders_status_created_idx`                                                                          | Planner                                                                                        |
| Auth retention: refresh tokens                  | `SessionsRepository.deleteExpiredRefreshTokens`                                               | `refresh_tokens_expires_at_idx`, `sessions_pkey`                                                     | Can serve                                                                                      |
| Auth retention: sessions                        | `SessionsRepository.deleteRetiredSessions`                                                    | `sessions_expires_at_idx`, `sessions_revoked_at_idx`, `refresh_tokens_session_id_idx`                | Planner                                                                                        |
| Admin retention: refresh tokens                 | `AdminRepository.deleteExpiredRefreshTokens`                                                  | `admin_sessions_expires_at_idx`, `admin_sessions_revoked_at_idx`, `admin_refresh_tokens_session_idx` | Can serve                                                                                      |
| Admin retention: sessions                       | `AdminRepository.deleteRetiredSessions`                                                       | the same three                                                                                       | Planner                                                                                        |
| OTP retention                                   | `OtpRepository.deleteExpired`                                                                 | `otp_challenges_expires_at_idx`                                                                      | Planner                                                                                        |
| Geocode cache expiry                            | `GeocodeCacheRepository.deleteExpired`                                                        | `geocode_cache_expires_at_idx`                                                                       | Planner                                                                                        |
| Abandoned order photos                          | `OrderPhotosRepository.listAbandoned`                                                         | `order_photos_abandoned_idx`                                                                         | Planner                                                                                        |
| Unsent message photos                           | `MessageAttachmentsRepository.listUnsent`                                                     | `message_attachments_unsent_created_idx`                                                             | Planner                                                                                        |
| Abandoned verification uploads                  | `MasterVerificationRepository.listAbandonedUploads`                                           | `master_documents_abandoned_idx`, `master_documents_master_activity_idx`                             | Planner                                                                                        |
| Expired position trails                         | `MasterLocationRepository.sweepExpiredTrails`                                                 | `master_locations_retention_idx`                                                                     | Planner                                                                                        |
| Overdue ringing calls                           | `CallsRepository.listRingingBefore`                                                           | `calls_ringing_started_idx`                                                                          | Planner                                                                                        |
| Answered calls whose room is gone               | `CallsRepository.listAnsweredBefore`                                                          | `calls_accepted_answered_idx`                                                                        | Planner                                                                                        |
| Push receipts due / past retention              | `PushTicketsRepository.findDue`, `deleteOlderThan`                                            | `push_tickets_created_at_idx`                                                                        | Planner                                                                                        |
| Sealed reviews past their window                | `ReviewsRepository.listOrdersPastWindow`                                                      | `reviews_sealed_order_idx`, `order_status_history_order_idx`                                         | Planner                                                                                        |
| A master's own posts, newest first (#308)       | `PortfolioRepository.listOwnPosts`                                                            | `portfolio_posts_master_created_idx`                                                                 | Planner                                                                                        |
| A page's photos in one query (#308)             | `PortfolioRepository.listMediaForPosts`                                                       | `portfolio_media_post_position_unique`                                                               | Planner                                                                                        |
| One of the master's posts (#308)                | `PortfolioRepository.findOwnPost`                                                             | `portfolio_posts_pkey`                                                                               | Planner                                                                                        |
| A master's profile feed (#310)                  | `PublicProfileRepository.listFeed`                                                            | `portfolio_posts_feed_idx`, and no sort                                                              | Planner                                                                                        |
| Who may see a master's profile (#310)           | `PublicProfileRepository.isCustomerOfMaster`                                                  | `customers_user_id_unique`, then the customer's orders                                               | Planner                                                                                        |
| Portfolio post sweep (#311)                     | `PortfolioRepository.listDeletedPosts`, `markAbandonedPostsDeleted`                           | `portfolio_posts_sweep_idx`                                                                          | Planner                                                                                        |
| Abandoned portfolio uploads (#311)              | `PortfolioRepository.listAbandonedUploads`                                                    | `portfolio_media_awaiting_upload_idx`                                                                | Planner                                                                                        |
| Removed posts: evidence move and purge (#312)   | `PortfolioModerationRepository.listEvidenceToMove`, `listEvidenceToPurge`                     | `portfolio_posts_removed_idx`; the move sorts its few rows by last attempt (#362)                    | Planner                                                                                        |
| Admin portfolio list (#312)                     | `PortfolioModerationRepository.list`                                                          | `portfolio_posts_created_idx` with no sort; `portfolio_posts_master_created_idx` for one master      | Planner                                                                                        |

The older, narrower assertions stay where they are and answer a different
question — whether an index serves an **ordering** without a sort
([`ordered-indexes.schema.test.ts`](../../apps/api/test/ordered-indexes.schema.test.ts)),
and the per-table checks in `order-offers.schema.test.ts`,
`master-services.schema.test.ts` and `service-catalogue.schema.test.ts`.

What #289 found and fixed: the abandoned-order-photo sweep read and sorted the
whole of `order_photos` (no index; `order_photos_abandoned_idx` added); both
session sweeps' `expires_at … or revoked_at …` could not use an index with only
one side indexed (`sessions_revoked_at_idx`, and both columns on
`admin_sessions`, added); the consumer refresh-token sweep compared
`expires_at` only against a per-row `case`, which no index can serve (a
`greatest(…)` bound added beside it); and every batched sweep delete read its
whole table to find the batch (rewritten to `= any(array(…))`).

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
- **How to measure ingest.** `POST /masters/me/location` under realistic
  concurrent master load — p50/p95/p99, achieved rps, errors by status, and
  database pool saturation — is `apps/api/test/master-location.benchmark.test.ts`
  (issue #290). Opt-in, like the nearby-masters query benchmark:
  `docker compose up -d && MASTER_LOCATION_BENCHMARK=1 pnpm --filter api exec vitest run test/master-location.benchmark.test.ts`.
  See the file's header comment for what it does and does not claim.

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

- RTK Query deduplicates, caches, and retries. **No `useEffect` + `fetch`** —
  it has none of that and races on unmount.
- **Retry transient failures only.** The shared policy lives in the base query
  in `apps/mobile/src/api/api-slice.ts`: RTK Query's `retry` wrapper gives two
  retries with backoff for a failure with no readable status (the common
  mobile-network case), and `retry.fail()` stops it dead on any 4xx, because
  `retry` would otherwise retry every failure up to the limit. **Never a retry
  on a 4xx.** A 4xx is the server saying this request, as sent, is wrong;
  resending it costs the user's data and changes nothing. `429` is worse than
  useless — retrying it burns the caller's remaining budget three times as fast
  as the server's rate limit assumes, which on OTP verify means locking the user
  out of their own sign-in.
- Mutations are never retried at all. RTK Query does not retry them, and that
  default is deliberate ([ADR-0017](../decisions/ADR-0017-state-management.md)).
- Set freshness deliberately per resource. The api slice defaults to
  `refetchOnMountOrArgChange: 30` and `keepUnusedDataFor: 300`; override per
  endpoint where the resource says otherwise — the catalogue is stable for
  minutes, an active order is not.
- **No uncontrolled polling.** `pollingInterval` is off by default and stays
  off: realtime events invalidate tags instead. Polling is a fallback with a
  bounded interval, never a default — for the same reason `setupListeners` is
  never called, which is that a background refetch the user did not ask for is
  spent on a mobile plan they are paying for.
- Mutations invalidate tags rather than hand-patching the cache, except where an
  optimistic `api.util.updateQueryData` is genuinely warranted.

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

Measured on 25 September 2026 (#292). Each figure is the median of three runs
or more, on an otherwise idle machine, one benchmark at a time.

| Metric                   | Budget                          | Measured p50 / p95 / p99                           | Load                                                           | Status                                        |
| ------------------------ | ------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| Nearby-masters query     | < 100 ms p95                    | 11.6 / 13.6 / 15.4 ms                              | 10 000 live masters, serial                                    | Within budget                                 |
| Location ingest          | < 200 ms p95                    | 28.7 / 51.8 / 79.1 ms                              | 2 000 masters at the reporting floor (~32 rps)                 | Within budget                                 |
| Order creation           | < 300 ms p95                    | 87.9 / 134.2 / 197.3 ms                            | 10 in flight (five runs)                                       | Within budget                                 |
| Standard API read        | < 200 ms p95                    | 27.3 / 46.8 / 59.5 ms                              | 10 in flight, 50 000-order history                             | Within budget                                 |
| WebSocket event delivery | < 1 s p95                       | 3.5 / 6.7 / 9.0 ms                                 | 500 clients on two instances, cross-instance                   | Within budget                                 |
| Portfolio feed read      | < 200 ms p95                    | 29.4 / 36.9 / 40.7 ms                              | 60 posts × 10 photos, serial (#317)                            | Within budget                                 |
| Photo renditions         | < 1.5 s p95                     | 795.8 / 882.7 ms / —                               | One 2560 px textured JPEG at a time (#317)                     | Within budget                                 |
| App cold start           | < 3 s on mid-range Android      | 856 ms median / 1 038 ms worst                     | Galaxy A36, release build, 10 runs (#293)                      | Within budget                                 |
| Screen transition        | < 5 % janky, p95 ≤ 20 ms (#503) | 2.3–3.3 % janky frames; p95 17–19 ms, p99 21–32 ms | Galaxy A36 at 120 Hz, three transitions × 10 (#293)            | Within budget; see § Screen-transition budget |
| Portfolio grid scroll    | < 5 % janky, p95 ≤ 20 ms (#503) | 0.31–0.47 % janky frames; p95 8 ms, p99 11 ms      | Galaxy A36 at 120 Hz, 60 tiles, three runs of 20 flings (#317) | Within budget; holds 120 Hz                   |

**Machine.** Intel Core i7-10870H (8 cores, 16 threads), 16 GB RAM, Windows 11
with Docker Desktop 28.5 (WSL 2). Node 24.19, PostgreSQL 17.5 with PostGIS
3.5.2, and Redis 7.4.11, all in the repository's `docker compose` stack. The
portfolio and media pipeline figures (#317) come from a different and slower
machine: an Intel Core i7-10510U laptop (4 cores, 8 threads, 1.8 GHz base),
16 GB RAM, Windows 11, Node 24.19, on the same service stack, measured on 18
October 2026. They are one run of the final harness, not a median; § Portfolio
and media pipeline gives the spread across runs. The load generator runs **in
the same Node process as the API**, so its share of the event loop is included
in every number. These are development-machine
figures, not production capacity. Re-run them on the hosting EPIC 17 chooses
before treating any of them as a capacity claim.

### What the numbers say

- **Per request, every server-side path is well inside its budget.** Order
  creation takes 37 ms at p95 with one request in flight, and a standard read
  takes 20 ms.
- **One instance saturates at about 150 order creations a second, or 350–410
  mixed reads a second.** Beyond that point, latency grows with the number in
  flight and not with the work each request does (Little's law: in flight ÷
  throughput). Measured order creation at p95:

  | In flight | p95    |
  | --------- | ------ |
  | 1         | 37 ms  |
  | 10        | 112 ms |
  | 25        | 222 ms |
  | 50        | 346 ms |
  | 200       | 1.34 s |

  A burst that size is answered by another instance (§ Scaling step 1), not by
  a faster handler. That is why the order benchmarks hold the budget at 10 in
  flight, the default `DATABASE_POOL_MAX`.

- **Crossing instances costs almost nothing.** An event published on one
  instance reaches a client on the other through the Redis streams adapter in
  6.7 ms at p95, compared with 6.0 ms on the same instance. None of about 3 000
  events per run was lost (#298).
- **Launch traffic is far below those ceilings.** A city's order rate is a
  handful a second at peak, and 2 000 online masters produce about 32 location
  reports a second.
- **Nothing here justified an optimisation.** In particular, it gave no reason
  for Redis position caching (§ Scaling step 3), which stays unbuilt until a
  measurement asks for it.

### Portfolio and media pipeline

Issue #317, on the laptop named under § Budgets. The harness is
`apps/api/test/portfolio.benchmark.test.ts`.

**Two fixtures bracket a real photo.** Neither one is a photo: the repository
holds no camera photos, and committing one would need the consent of whoever
took it. The _flat_ fixture is one colour. It decodes and encodes faster
than any photo and compresses to almost nothing, so it is a lower bound. The
_textured_ fixture sums noise at four scales. At 12 MP it is a 4.1 MB JPEG,
about what a phone camera writes, so its decode cost is realistic. It
compresses worse than a real scene, so its output sizes are an upper bound.

**Renditions.** Each figure covers both WebP renditions of one photo
(`thumb` 480 px q75, `display` 1440 px q80), with metadata stripped, ten
iterations after a warm-up:

| Input                                           | Wall p50 / p95     | CPU p50 / p95      | Output per photo |
| ----------------------------------------------- | ------------------ | ------------------ | ---------------- |
| 2560×1920 textured, 1.7 MB — what the app sends | 795.8 / 882.7 ms   | 781.0 / 859.0 ms   | 411.9 KB         |
| 12 MP textured, 4.1 MB — worst case             | 1063.8 / 1253.7 ms | 1063.0 / 1265.0 ms | 512.5 KB         |
| 12 MP flat, 70 KB                               | 551.2 / 857.4 ms   | 579.0 / 906.0 ms   | 3.2 KB           |

- **The budget is set on what the app sends**, a JPEG whose long edge is at
  most 2560 px (ADR-0045 § 4, #319). Across two runs its p95 was 0.88–1.14 s,
  so the budget is < 1.5 s p95. A 12 MP upload only comes from a client that
  skips the app's resize. It is recorded here, not budgeted: its p95 was
  1.15–1.28 s across three runs. No master waits on this time; a published
  photo shows as processing until its renditions exist.
- **CPU time matches wall time.** With `sharp.concurrency(1)`
  (`image-renditions.ts`), one photo holds one core for its whole render.
- **Peak RSS is not isolated.** The figure the harness reads is the process's
  high-water mark, which includes the Nest app and the fixtures. It was 417 MB
  before the renders and the same after them, so rendering did not raise it.
  How much a render itself allocates was not measured.

**Queue burst.** Twenty 12 MP textured photos are enqueued at once, through
BullMQ and the in-process worker:

| `MEDIA_WORKER_CONCURRENCY` | Drained in | Throughput   | Wait p50 / p95  |
| -------------------------- | ---------- | ------------ | --------------- |
| 1                          | 19.98 s    | 1.00 photo/s | 10.4 s / 19.0 s |
| 2                          | 12.50 s    | 1.60 photo/s | 6.0 s / 12.4 s  |

**Recommendation: keep the `media` worker in-process, at
`MEDIA_WORKER_CONCURRENCY=1`, until EPIC 17.**

- At concurrency 1, the worker takes one core, and the API keeps the rest.
  The measurement below bears this out.
- Concurrency 2 buys 1.6× the throughput for a second core, which a burst of
  20 does not justify. A master publishing ten photos waits about ten seconds
  for the last one.
- This holds for photos only. Video is deferred (ADR-0045 § 7), so no transcode
  was measured. The issue names the transcode as the number that decides where
  the worker runs, so this recommendation must be revisited with #306.

**The API while the worker is busy** (#387). The feed read above was
measured during three phases: idle, and while the worker drained a burst of
twenty 12 MP textured photos at concurrency 1 and at concurrency 2. One request
started every 100 ms, never two at once. Across three runs:

| Phase                  | Reads   | Feed p50     | Feed p95     | Loop delay p99 / max     |
| ---------------------- | ------- | ------------ | ------------ | ------------------------ |
| Idle                   | 50      | 38.7–40.4 ms | 44.8–47.8 ms | 24.4–24.8 / 25.4–26.3 ms |
| Burst at concurrency 1 | 199–204 | 37.7–39.4 ms | 49.0–49.3 ms | 24.6–24.9 / 25.8–27.3 ms |
| Burst at concurrency 2 | 107–121 | 38.3–43.0 ms | 48.3–58.1 ms | 24.5–24.9 / 27.8–40.0 ms |

- **The recommendation stands.** At concurrency 1, a busy worker moves the feed
  read's p95 up by 1–5 ms, to about 49 ms, which is a quarter of the
  < 200 ms read budget. The harness asserts that budget for this phase.
- **The event loop does not stall.** libvips renders off the loop, so the
  loop's delay is the same idle as under either burst. Its p50 of about 15.5 ms
  in every phase is Windows' timer granularity, not load; a Linux host is
  expected to read lower, which was not measured.
- **One or two reads a run took about 350 ms under load,** in two runs out of
  three, out of some 300 under load, and none while idle. The loop showed no matching stall, so that time
  was spent outside it. Likely places are Postgres, which runs in Docker's VM
  on the same four cores, or libuv's thread pool, which the render shares.
  Which of them it was is not isolated. It does not reach the p95.
- The client runs in the API's own process, so its work and the server's
  share one loop. A separate client should see the same or better.

**Storage per master.** The textured app-sized photo gives these upper bounds:

- 500 photos (50 posts, the issue's figure): 201 MB.
- 600 photos (ADR-0045's ceiling of 60 posts × 10): 241 MB.

The flat fixture gives 1.5 MB for 500 photos. The issue's estimate of ≈135 MB
for 50 posts is about 276 KB a photo, which lies between the two bounds. These
fixtures can neither confirm nor refute it. That needs a sample of real
consented photos.

**Feed read.** `GET /masters/:id/portfolio?limit=30` was measured for a master
with 60 published posts of ten photos each, over 50 serial requests:
29.4 ms p50, 36.9 ms p95 and 40.7 ms p99. Across four runs, p95 was
36.9–47.6 ms.

The harness then runs `EXPLAIN (ANALYZE, BUFFERS)` on the first page of
`PublicProfileRepository.listFeed`, with the planner free to choose:

- The table also holds 60 posts each for 500 other masters, and has been
  analysed.
- The plan is an index scan on `portfolio_posts_feed_idx` with no sort node.
  It executes in under 0.1 ms, with 5 shared buffer hits.
- The query is written by hand, to match `listFeed` with no cursor. It is not
  captured from the endpoint.

### Mobile on a real device

Issue #293, measured on 4 November 2026.

- **Device:** Samsung Galaxy A36 5G (SM-A366E), a 2025 mid-range A-series phone. Android 16, display at 120 Hz.
- **Build:** a local release build of `main` at `0f6338e`, made with `expo prebuild` and `gradlew assembleRelease`. It runs Hermes bytecode with no Metro, arm64 only.
  - It was installed as `az.tezusta.app.perf`, so the development client on the same phone was left alone.
  - The release manifest allowed cleartext HTTP to the LAN API.
  - The Google Maps key came from the local `.env`.
- **API:** a local API on the same Wi-Fi network, against its own seeded database.

| Measurement                             | Runs | Median | Worst    | Notes                                                                                                                 |
| --------------------------------------- | ---- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| Cold start (`am start -W`, `TotalTime`) | 10   | 856 ms | 1 038 ms | After `force-stop`. Signed out, so the sign-in screen draws. An earlier build without the Maps key gave 857 / 892 ms. |

| Transition (gfxinfo over the cycles)                             | Cycles | Frames | Janky  | p50 / p90 / p95 / p99 frame |
| ---------------------------------------------------------------- | ------ | ------ | ------ | --------------------------- |
| Catalogue → order creation (service list → order form, and back) | 10     | 1 152  | 2.34 % | 10 / 16 / 17 / 21 ms        |
| Order list → order (an accepted order, and back)                 | 10     | 1 098  | 2.73 % | 10 / 16 / 18 / 22 ms        |
| Master home → job screen (with its map, and back)                | 9      | 1 280  | 3.28 % | 9 / 15 / 19 / 32 ms         |

**Notes on the transition figures:**

- **"Janky"** is Android's modern count: frames that missed their deadline. The legacy count is 11–13 %, but at 120 Hz it flags any frame over 8.3 ms, so it is not used here.
- **Each cycle includes the Back transition**, so every figure covers both directions.
- **Master home → job screen ran 9 cycles.** The tenth was skipped because the phone's notification shade was open.

**What the numbers say:**

- **Cold start is comfortably inside the 3 s budget**, with room for growth.
- **The transitions are within the screen-transition budget** (§ Screen-transition budget, set by #503 after this measurement).
  - About one frame in 30–40 misses its deadline at this phone's native 120 Hz: 2.3–3.3 % janky, under the 5 % ceiling.
  - The p95 frame is 17–19 ms. That is just over the 16.7 ms a 60 Hz frame allows, and under the 20 ms ceiling.
  - The job screen is the heaviest: its p95 is 19 ms, its p99 is 32 ms, and it missed 10 vsyncs, from mounting the Google map. It is the transition closest to the bar.
  - The budget these figures were first measured against, "60 fps, no dropped frames", could not pass on a 120 Hz phone and was replaced (#503).
- **Not measured:**
  - a phone below the A-series class;
  - a long order list;
  - the customer's order screen while it shows a live master position on its map. In these runs no position had been reported yet.

**Procedure, so it can be repeated:**

1. Build a release APK. Prebuild, then `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`, with `EXPO_PUBLIC_API_URL` and both `EXPO_PUBLIC_GOOGLE_MAPS_*` keys set. Install it with `adb install -r`.
2. Cold start: run this ten times and take the median and the worst `TotalTime`:
   ```bash
   adb shell am force-stop <pkg> && adb shell am start -W -n <pkg>/.MainActivity
   ```
3. For each transition:
   1. Run `adb shell dumpsys gfxinfo <pkg> reset`.
   2. Do ten cycles of: tap into the screen, wait about 2.5 s, press Back, wait about 2.5 s.
   3. Run `adb shell dumpsys gfxinfo <pkg>`, and record the total frames, the janky frames and the percentiles.
4. Keep the phone untouched while it runs, with notifications quiet. A heads-up banner or an open shade both disturb the frame counts.

### Screen-transition budget

Set by the owner on 10 November 2026 (#503). It replaces "60 fps, no dropped frames", which no React Native app on a 120 Hz phone meets, so it could neither pass nor catch a regression.

**A screen transition, or a list scroll, passes when both hold:**

- **fewer than 5 % janky frames**, and
- **a p95 frame time of 20 ms or less**,

on the reference mid-range Android (the Galaxy A36 above, or its successor in the same class), with a release build, measured by the procedure in § Mobile on a real device. The p99 is recorded but is not pass/fail.

**Why these two figures:**

- **Janky frames are the main bar.** Android counts a frame as janky when it misses its own deadline, so the count already accounts for the refresh rate. The same 5 % ceiling works at 60 Hz and at 120 Hz.
- **The p95 catches a broad slowdown** that spreads across many frames without missing many deadlines. 20 ms is about one 60 Hz frame plus a little.
- **The p99 is not a bar**, because a single heavy mount dominates it. On the job screen that is the Google map.

**Alternatives that were set aside:**

- **p95 < 16.7 ms**, which `performance.md` first suggested. It sounds like "60 fps", but all three #293 transitions miss it, by 0.3–2.3 ms, so it would fail today's app with nothing to fix it against.
- **p95 < 8.3 ms, a 120 Hz bar.** All three transitions miss it by double. Only the portfolio grid meets it.
- **Keeping "no dropped frames" as an aspiration.** It has no pass/fail, so it cannot catch a regression.

**Trade-off:** the margin is thin. The job screen's p95 is 19 ms, 1 ms under the ceiling, so ordinary run-to-run noise could push it over. If that happens, make the map mount cheaper first, and do not raise the ceiling to fit.

### Portfolio grid on a real device

Issue #317, measured on the night of 6–7 November 2026 on the Galaxy A36 named above, with a release build of `main` at `affe264`, arm64 only and without a Maps key. The path is the one a customer takes: an accepted order, then **Profilə bax**, then the grid.

The master has 60 published posts of ten photos each, so the grid has 60 tiles, each with the mark for a multi-photo post. Tiles are 480×360 WebP at quality 75, about 27 KB each, made from the textured noise of § Portfolio and media pipeline. They are not photos.

Each run is ten flings down and ten back up, driven by `adb shell input swipe` (1 200 px in 120 ms, a pause of about a second between flings). Ten flings do reach the last tile.

| Run | Frames | Janky  | p50 / p90 / p95 / p99 frame | Missed vsync | Slow UI thread | Slow bitmap upload |
| --- | ------ | ------ | --------------------------- | ------------ | -------------- | ------------------ |
| 1   | 1 922  | 0.31 % | 6 / 7 / 8 / 11 ms           | 0            | 0              | 0                  |
| 2   | 1 935  | 0.47 % | 6 / 7 / 8 / 11 ms           | 0            | 0              | 0                  |
| 3   | 1 959  | 0.41 % | 6 / 7 / 8 / 11 ms           | 0            | 0              | 0                  |

**What the numbers say:**

- **The grid keeps up with the phone's 120 Hz display.** The p95 frame fits the 8.3 ms a 120 Hz frame allows, and about one frame in 200–300 misses its deadline. That is far lighter than the transitions above, which do not meet that 120 Hz bar (#503).
- **No frames-per-second figure is recorded.** gfxinfo counts only frames that were drawn, and the list comes to rest between flings, so frames over elapsed time would measure the pauses. The frame times are the honest figure.
- **Memory:** total PSS went from 276 to 282 MB over the three runs, and graphics memory stayed at 25.6 MB. That is too short a run to say whether memory levels off.

**Limits of this measurement:**

- **It does not cover waiting on the network.** All 60 tiles had been requested before the first fling, because the list renders ahead of the screen. They came through an adb tunnel on the same Wi-Fi, so a first load on 4G is not measured.
- **The runs are not fully quiet.** The phone was charging, and Do Not Disturb was off. The count of posted notifications stayed at 15 throughout.
- **Noise is not a photo.** It decodes differently from a real scene, and the tiles are smaller on disk than a real photo's thumb may be. A sample of real, consented photos would settle that, as it would the storage estimate above.
- **Video figures are not here.** Memory after ten videos and time to first frame moved to #504 with the rest of video.

**Three things that cost time, for whoever repeats this:**

- On a Wi-Fi network Windows treats as Public, the firewall can refuse the phone. Use `adb reverse tcp:<port> tcp:<port>` for the API and the media server, and build with `EXPO_PUBLIC_API_URL=http://localhost:<port>`.
- Changing an `EXPO_PUBLIC_*` value does not invalidate Gradle's bundle task. Run `./gradlew :app:createBundleReleaseJsAndAssets --rerun` first, then check the URL is in `assets/index.android.bundle`.
- With a changed `applicationId`, the activity keeps its old name: `adb shell am start -n <pkg>/az.tezusta.app.MainActivity`.

### How to re-run

```bash
docker compose up -d
NEARBY_MASTERS_BENCHMARK=1   pnpm --filter api exec vitest run test/nearby-masters.benchmark.test.ts
MASTER_LOCATION_BENCHMARK=1  pnpm --filter api exec vitest run test/master-location.benchmark.test.ts
ORDERS_BENCHMARK=1           pnpm --filter api exec vitest run test/orders.benchmark.test.ts
REALTIME_DELIVERY_BENCHMARK=1 pnpm --filter api exec vitest run test/realtime.delivery.benchmark.test.ts
PORTFOLIO_BENCHMARK=1        pnpm --filter api exec vitest run test/portfolio.benchmark.test.ts
```

Run them one at a time, never alongside `pnpm test` or each other. Shared
cores make every figure wrong. Each benchmark's header comment lists its knobs
and what it does and does not claim.

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
