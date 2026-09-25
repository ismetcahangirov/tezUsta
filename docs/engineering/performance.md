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

- Order creation and standard reads: `ORDERS_BENCHMARK=1 pnpm --filter api exec vitest run test/orders.benchmark.test.ts` (issue #291).

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
