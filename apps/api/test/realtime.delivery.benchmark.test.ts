import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { OrderStatus } from '@tezusta/types';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { AppConfig } from '../src/infra/config/app-config.types';
import { APP_CONFIG } from '../src/infra/config/config.tokens';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { MasterLocationRegistry } from '../src/modules/masters/master-location.registry';
import { OrderNotificationsRegistry } from '../src/modules/orders/order-notifications.registry';
import { positionFanoutKey } from '../src/modules/realtime/master-position.publisher';
import {
  ORDER_TRANSITION_EVENT,
  MASTER_POSITION_EVENT,
} from '../src/modules/realtime/realtime.events';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Publish → receipt latency for `order:transition` and `order:master-position`
 * across two API instances on one Redis (issue #298).
 *
 * ```bash
 * docker compose up -d
 * REALTIME_DELIVERY_BENCHMARK=1 pnpm --filter api exec vitest run test/realtime.delivery.benchmark.test.ts
 * ```
 *
 * Overridable: `REALTIME_DELIVERY_BENCHMARK_CLIENTS` (default
 * {@link DEFAULT_CLIENT_COUNT}), `REALTIME_DELIVERY_BENCHMARK_WARMUP_SECONDS`
 * (default {@link DEFAULT_WARMUP_SECONDS}),
 * `REALTIME_DELIVERY_BENCHMARK_DURATION_SECONDS` (default
 * {@link DEFAULT_DURATION_SECONDS}), `REALTIME_DELIVERY_P95_BUDGET_MS`
 * (default {@link DEFAULT_P95_BUDGET_MS}).
 *
 * **Opt-in, for the reason every other file under this name is**: this is a
 * latency measurement, not a correctness claim. Correctness of cross-instance
 * delivery is already asserted unconditionally in
 * `realtime.multi-instance.e2e.test.ts`, and of room authorization and payload
 * shape in `realtime.order-events.e2e.test.ts` and
 * `master-position-fanout.e2e.test.ts`. Seeding hundreds of clients and
 * driving a real window is minutes nobody should pay on every `pnpm test`
 * (CLAUDE.md §13).
 *
 * ## What is being measured, and through what path
 *
 * **Two real Nest applications, on two ports, against one Redis** — exactly
 * `realtime.multi-instance.e2e.test.ts`'s shape, because a mocked adapter
 * would prove nothing about the thing issue #166 exists to guard. `N`
 * customer clients (default {@link DEFAULT_CLIENT_COUNT}) are split evenly
 * across the two instances' sockets, each authorized for and joined to its
 * own order's room (`order:{orderId}`) — the same authorization path
 * `realtime.order-events.e2e.test.ts` exercises, a real database read against
 * a real, non-terminal, seeded order.
 *
 * **The generator publishes only through instance A, and only through the
 * service the product calls after its own commit** —
 * `OrderNotificationsRegistry.transitioned()` for an order event and
 * `MasterLocationRegistry.reported()` for a position, never
 * `gateway.server.to().emit()` directly. Those two registries are exactly the
 * seam `OrdersService` and `MasterLocationService` raise through in
 * production (`order-notifications.registry.ts`, `master-location.registry.ts`);
 * `OrderEventsPublisher` and `MasterPositionPublisher` are the real
 * subscribers that turn a registry call into the room emit this file times.
 * What is deliberately **not** exercised is the HTTP request and the database
 * write that precede that raise in production — `orders.benchmark.test.ts`
 * and `master-location.benchmark.test.ts` already measure those halves of the
 * pipeline, and mixing them in here would make it impossible to say which
 * half a slow number belonged to. This file isolates the delivery half: one
 * committed fact, fanned out to a socket, over the real Redis-backed
 * cross-instance transport.
 *
 * Because every client is on instance A or instance B and the generator only
 * ever publishes from instance A, every sample is naturally split into
 * **same-instance** (client on A — delivered without crossing the adapter)
 * and **cross-instance** (client on B — delivered through the
 * `@socket.io/redis-streams-adapter` hop the realtime architecture doc calls
 * out as the reason the adapter is not optional).
 *
 * ## Why the clock is not the event's own `at`
 *
 * The issue's acceptance criterion says to time delivery "using the event's
 * own `at` timestamp". This file does not, and says why rather than silently
 * diverging: `at` is epoch **milliseconds** (`realtime-event.ts`), and for an
 * order transition it is `Date.now()` taken on the *publishing* instance
 * inside `OrderEventsPublisher`, not a clock this file controls. A latency
 * distribution whose p50 is expected to be single-digit milliseconds cannot
 * be read off a millisecond-quantised, cross-process clock — half the samples
 * would round to `0`. Instead this file keeps its own map, `masterId`- and
 * `orderId`-keyed, from `performance.now()` **immediately before** the
 * registry call that publishes, to `performance.now()` **the instant the
 * client's handler runs** on receipt. `performance.now()` is a single
 * monotonic clock because — see below — the generator and every client share
 * one process; there is no clock-skew question to beg. `at` remains exactly
 * what production uses it for (staleness / out-of-order discard on the
 * client) and is asserted nowhere in this file, because that is
 * `master-position-fanout.e2e.test.ts`'s subject, not this one's.
 *
 * ## How one publish is matched to one receipt
 *
 * Neither event payload carries an id (`OrderTransitionRealtimeEvent`,
 * `MasterPositionRealtimeEvent` — `realtime-event.ts`, deliberately: CLAUDE.md
 * §11, ids and changed fields only). Matching therefore runs on the invariant
 * this file's own topology guarantees: **each client is the only listener on
 * its order's room, and each order's driver publishes one event at a time,
 * awaiting the registry call before starting its next sleep** — so, for one
 * order and one event kind, publishes and receipts arrive in the same order
 * they were sent in. A FIFO queue of `{ publishedAtPerf, measured }` per
 * `(orderId, eventKind)` is therefore a sound correlation, with no id needed
 * on the wire. A receipt with an empty queue (a frame this file did not
 * expect) is counted as `unexpectedReceipts` and fails the run — it would mean
 * either a leak between orders or a duplicate delivery, and either is worth
 * seeing rather than silently averaging away.
 *
 * ## The load shape
 *
 * Each seeded order gets its own **independent** transition driver and
 * position driver, in the shape `master-location.benchmark.test.ts` uses for
 * the same reason: a real fleet is not one throughput generator, it is many
 * independent actors.
 *
 * - **Position**: `realtime-architecture.md`'s "assigned, travelling" floor,
 *   10–15 s, jittered — the cadence a compliant app reports at while a
 *   customer is watching the marker (ADR-0026). **The fan-out throttle
 *   window is force-reopened immediately before every publish**
 *   (`redis.del(positionFanoutKey(...))`, the same helper
 *   `master-position-fanout.e2e.test.ts` uses to re-open it) so every
 *   generated report is the leading edge of its own window and is
 *   deterministically the one the room hears. This still runs the real
 *   `SET key 1 PX window NX` on every call — what is fixed is only which side
 *   of that race wins, not whether it runs.
 * - **Order transition**: order-lifecycle transitions are not a fixed-rate
 *   stream in production — `realtime-architecture.md` § Event payloads calls
 *   the gaps between one order's transitions "human-scale" — so this file
 *   uses a slower, jittered 30–60 s interval, cycling through
 *   `MASTER_ON_THE_WAY → MASTER_ARRIVED → IN_PROGRESS` and back. Calling the
 *   registry directly, as above, never touches `orders` in Postgres, so the
 *   seeded row's status stays `ACCEPTED` for the run — which is deliberately
 *   fine: `findEngagedOrderIdForMaster` (the position path's lookup) only
 *   needs the row's committed `master_id` and status to stay inside
 *   `MASTER_ENGAGED_ORDER_STATUSES`, and `ACCEPTED` already is one.
 *
 * ## The dataset
 *
 * `DEFAULT_CLIENT_COUNT` orders are seeded set-based — bulk `INSERT … SELECT
 * … FROM unnest(...)`, not one row per client — each an `ACCEPTED` order with
 * its own customer, master and address, the shape
 * `master-location.benchmark.test.ts#seedActiveOrders` already established.
 * Every customer gets a real access token, minted in-process
 * (`SessionsService.startSession`, bounded concurrency) exactly as that file
 * mints one per master. Masters never open a socket in this file — nothing
 * here needs a master's own connection, only the `orders.master_id` a
 * position report's lookup resolves against.
 *
 * ## What is reported, and what it does not claim
 *
 * p50/p95/p99/max **per path** (same-instance, cross-instance), events
 * published, events received and events lost in the measured window, plus
 * hardware and software versions, exactly as the other benchmarks print them.
 * **This is one process's view of one machine.** The generator, both Nest
 * applications and every simulated client run in that one process on that
 * one event loop — stated here because it is the reason a number here is a
 * ceiling on what this machine's contention allowed, not a claim about a
 * production topology where the publishing instance, the receiving instance
 * and the client are three different computers. Re-run on the hosting EPIC 17
 * chooses before treating any of this as a capacity claim
 * (`docs/engineering/performance.md`).
 */

const DEFAULT_CLIENT_COUNT = 500;
const DEFAULT_WARMUP_SECONDS = 15;
const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_P95_BUDGET_MS = 1_000;
const SETUP_TIMEOUT_MS = 180_000;
/**
 * How long, after the driver loops stop, this file waits for the last
 * in-flight frames to land before deciding anything unmatched is lost.
 * Generous relative to an in-process, same-machine delivery: real production
 * loss looks like nothing arriving ever, not something arriving a few hundred
 * milliseconds late.
 */
const DRAIN_MS = 5_000;

const CLIENT_COUNT = Number(
  process.env.REALTIME_DELIVERY_BENCHMARK_CLIENTS ?? DEFAULT_CLIENT_COUNT,
);
const WARMUP_SECONDS = Number(
  process.env.REALTIME_DELIVERY_BENCHMARK_WARMUP_SECONDS ?? DEFAULT_WARMUP_SECONDS,
);
const DURATION_SECONDS = Number(
  process.env.REALTIME_DELIVERY_BENCHMARK_DURATION_SECONDS ?? DEFAULT_DURATION_SECONDS,
);
const P95_BUDGET_MS = Number(process.env.REALTIME_DELIVERY_P95_BUDGET_MS ?? DEFAULT_P95_BUDGET_MS);

/** `docs/architecture/realtime-architecture.md` § Location update budget — assigned/travelling floor. */
const POSITION_INTERVAL_RANGE_SECONDS: readonly [number, number] = [10, 15];
/** A plausible, "human-scale" gap between one order's transitions (see header comment). */
const TRANSITION_INTERVAL_RANGE_SECONDS: readonly [number, number] = [30, 60];
const TRANSITION_CYCLE: readonly OrderStatus[] = [
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
];

const TOKEN_MINT_CONCURRENCY = 100;
const CONNECT_CONCURRENCY = 100;

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const EARTH_RADIUS_M = 6_378_137;
/** Metres — a small, always-plausible step, well under the jump floor. */
const POSITION_STEP_M = 20;

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? Number.NaN;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInRange([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min);
}

function moveBy(
  latitude: number,
  longitude: number,
  distanceM: number,
  bearingRad: number,
): { latitude: number; longitude: number } {
  const dLat = (distanceM * Math.cos(bearingRad)) / EARTH_RADIUS_M;
  const dLng =
    (distanceM * Math.sin(bearingRad)) / (EARTH_RADIUS_M * Math.cos((latitude * Math.PI) / 180));
  return {
    latitude: latitude + (dLat * 180) / Math.PI,
    longitude: longitude + (dLng * 180) / Math.PI,
  };
}

/** A plain counting semaphore — bounded concurrency with no new dependency (borrowed from `master-location.benchmark.test.ts`). */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next !== undefined) {
        next();
      }
    };
  }
}

interface SeededClient {
  readonly orderId: string;
  readonly masterId: string;
  readonly customerId: string;
  readonly customerUserId: string;
}

/** One outstanding publish this file has not yet matched to a receipt. */
interface PendingPublish {
  readonly publishedAtPerf: number;
  /** Whether this publish happened after warm-up and counts toward the report. */
  readonly measured: boolean;
}

type EventKind = 'transition' | 'position';
type Path = 'same-instance' | 'cross-instance';

/** A FIFO queue of pending publishes per `(orderId, eventKind)` — see header comment. */
class PublishLedger {
  private readonly queues = new Map<string, PendingPublish[]>();

  private key(orderId: string, kind: EventKind): string {
    return `${kind}:${orderId}`;
  }

  push(orderId: string, kind: EventKind, entry: PendingPublish): void {
    const key = this.key(orderId, kind);
    const queue = this.queues.get(key);
    if (queue === undefined) {
      this.queues.set(key, [entry]);
    } else {
      queue.push(entry);
    }
  }

  /** Pops the oldest pending publish for this order and kind, or `undefined` if none is outstanding. */
  shift(orderId: string, kind: EventKind): PendingPublish | undefined {
    return this.queues.get(this.key(orderId, kind))?.shift();
  }

  /** Every publish still outstanding — what the drain period could not match to a receipt. */
  outstanding(): readonly PendingPublish[] {
    return [...this.queues.values()].flat();
  }
}

describe.runIf(process.env.REALTIME_DELIVERY_BENCHMARK === '1')(
  'WebSocket event delivery across two API instances (issue #298)',
  () => {
    let instanceA: NestFastifyApplication;
    let instanceB: NestFastifyApplication;
    let database: ThrowawayDatabase;
    let pool: Pool;
    let redis: Redis;
    let config: AppConfig;
    let serviceId: string;
    let urlA: string;
    let urlB: string;
    const saved = new Map<string, string | undefined>();
    const opened: Socket[] = [];

    function set(name: string, value: string): void {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }

    async function bootInstance(): Promise<NestFastifyApplication> {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .setLogger(new ConsoleLogger())
        .compile();

      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      app.useWebSocketAdapter(new RealtimeIoAdapter(app));
      await app.listen(0, '127.0.0.1');
      return app;
    }

    /** Bulk-seeds `count` `ACCEPTED` orders, each with its own master, customer and address. */
    async function seedClients(count: number): Promise<SeededClient[]> {
      const masterUserIds = Array.from({ length: count }, () => randomUUID());
      const masterIds = Array.from({ length: count }, () => randomUUID());
      const customerUserIds = Array.from({ length: count }, () => randomUUID());
      const customerIds = Array.from({ length: count }, () => randomUUID());
      const addressIds = Array.from({ length: count }, () => randomUUID());
      const orderIds = Array.from({ length: count }, () => randomUUID());
      const idempotencyKeys = Array.from({ length: count }, () => randomUUID());

      const masterPhones = masterUserIds.map((_, i) => `+99450${String(i + 1).padStart(7, '0')}`);
      const customerPhones = customerUserIds.map(
        (_, i) => `+99451${String(i + 1).padStart(7, '0')}`,
      );

      await pool.query(
        `insert into users (id, phone_e164) select * from unnest($1::uuid[], $2::text[])`,
        [
          [...masterUserIds, ...customerUserIds],
          [...masterPhones, ...customerPhones],
        ],
      );
      await pool.query(
        `insert into masters (id, user_id, display_name, verification_status, is_available)
         select m, u, 'Bench Master', 'active', true
           from unnest($1::uuid[], $2::uuid[]) as t(m, u)`,
        [masterIds, masterUserIds],
      );
      await pool.query(
        `insert into customers (id, user_id, display_name)
         select c, u, 'Bench Customer' from unnest($1::uuid[], $2::uuid[]) as t(c, u)`,
        [customerIds, customerUserIds],
      );
      await pool.query(
        `insert into addresses (id, customer_id, formatted_address, position)
         select a, c, 'Bench address',
                ST_SetSRID(ST_MakePoint($3 + (random() - 0.5) * 0.01, $4 + (random() - 0.5) * 0.01), 4326)
           from unnest($1::uuid[], $2::uuid[]) as t(a, c)`,
        [addressIds, customerIds, SEARCH_POINT.longitude, SEARCH_POINT.latitude],
      );
      await pool.query(
        `insert into orders (id, customer_id, address_id, service_id, master_id, status,
                             description, idempotency_key, accepted_at, created_at, updated_at)
         select o, c, a, $6::uuid, m, 'ACCEPTED', 'Realtime delivery benchmark order', k, now(), now(), now()
           from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[]) as t(o, c, a, m, k)`,
        [orderIds, customerIds, addressIds, masterIds, idempotencyKeys, serviceId],
      );

      return orderIds.map((orderId, i) => ({
        orderId,
        masterId: masterIds[i] ?? '',
        customerId: customerIds[i] ?? '',
        customerUserId: customerUserIds[i] ?? '',
      }));
    }

    async function mintTokens(
      userIds: readonly string[],
      sessions: SessionsService,
    ): Promise<readonly string[]> {
      const semaphore = new Semaphore(TOKEN_MINT_CONCURRENCY);
      return Promise.all(
        userIds.map(async (userId) => {
          const release = await semaphore.acquire();
          try {
            const pair = await sessions.startSession({ userId });
            return pair.accessToken;
          } finally {
            release();
          }
        }),
      );
    }

    beforeAll(async () => {
      const baseUrl = parseEnv(process.env).database.url;
      database = await createThrowawayDatabase(baseUrl);
      await runMigrations(database.url);
      await runSeed(database.url);

      set('DATABASE_URL', database.url);

      instanceA = await bootInstance();
      instanceB = await bootInstance();
      urlA = await instanceA.getUrl();
      urlB = await instanceB.getUrl();

      redis = instanceA.get<Redis>(REDIS_CLIENT);
      config = instanceA.get<AppConfig>(APP_CONFIG);

      pool = new Pool({ connectionString: database.url });
      pool.on('error', () => undefined);

      const { rows } = await pool.query<{ id: string }>(
        `select id from services where is_active order by id limit 1`,
      );
      const found = rows[0]?.id;
      if (found === undefined) {
        throw new Error('The seeded catalogue has no active service.');
      }
      serviceId = found;
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
      while (opened.length > 0) {
        opened.pop()?.disconnect();
      }
      await pool.end();
      await instanceA.close();
      await instanceB.close();
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await database.drop();
    }, 120_000);

    it(
      `delivers order:transition and order:master-position to ${CLIENT_COUNT} clients within ${P95_BUDGET_MS} ms p95`,
      async () => {
        const clients = await seedClients(CLIENT_COUNT);
        const sessions = instanceA.get(SessionsService);
        const accessTokens = await mintTokens(
          clients.map((c) => c.customerUserId),
          sessions,
        );

        const pgVersion = (await pool.query<{ server_version: string }>('show server_version'))
          .rows[0]?.server_version;
        const redisInfo = await redis.info('server');
        const redisVersion = /redis_version:(\S+)/.exec(redisInfo)?.[1] ?? 'unknown';

        const ledger = new PublishLedger();
        const sameInstanceSamples: number[] = [];
        const crossInstanceSamples: number[] = [];
        let publishedMeasured = 0;
        let unexpectedReceipts = 0;

        function recordReceipt(orderId: string, kind: EventKind, path: Path): void {
          const receivedAtPerf = performance.now();
          const pending = ledger.shift(orderId, kind);
          if (pending === undefined) {
            unexpectedReceipts += 1;
            return;
          }
          if (!pending.measured) {
            return;
          }
          const latency = receivedAtPerf - pending.publishedAtPerf;
          (path === 'same-instance' ? sameInstanceSamples : crossInstanceSamples).push(latency);
        }

        // Connect every client, half to each instance, and join its own
        // order room — bounded concurrency so opening `CLIENT_COUNT` sockets
        // at once does not itself become the bottleneck being measured.
        const connectSemaphore = new Semaphore(CONNECT_CONCURRENCY);
        await Promise.all(
          clients.map(async (client, index) => {
            const release = await connectSemaphore.acquire();
            try {
              const path: Path = index % 2 === 0 ? 'same-instance' : 'cross-instance';
              const url = path === 'same-instance' ? urlA : urlB;
              const token = accessTokens[index] ?? '';

              const socket = io(url, {
                transports: ['websocket'],
                reconnection: false,
                auth: { token },
              });
              opened.push(socket);

              await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('connect_error', reject);
              });

              socket.on(ORDER_TRANSITION_EVENT, () => {
                recordReceipt(client.orderId, 'transition', path);
              });
              socket.on(MASTER_POSITION_EVENT, () => {
                recordReceipt(client.orderId, 'position', path);
              });

              const ack = await new Promise<{ ok: boolean }>((resolve, reject) => {
                const timer = setTimeout(() => {
                  reject(new Error('no ack for room:join'));
                }, 10_000);
                socket.emit(
                  'room:join',
                  { kind: 'order', orderId: client.orderId },
                  (response: { ok: boolean }) => {
                    clearTimeout(timer);
                    resolve(response);
                  },
                );
              });
              if (!ack.ok) {
                throw new Error(`client for order ${client.orderId} could not join its room`);
              }
            } finally {
              release();
            }
          }),
        );

        const orderNotifications = instanceA.get(OrderNotificationsRegistry);
        const masterLocations = instanceA.get(MasterLocationRegistry);
        const keyPrefix = config.redis.keyPrefix;

        const warmupEndAt = Date.now() + WARMUP_SECONDS * 1_000;
        const stopAt = warmupEndAt + DURATION_SECONDS * 1_000;

        /** Never sleeps past `stopAt` — see `master-location.benchmark.test.ts` for why. */
        async function sleepUntilOrStop(delayMs: number): Promise<void> {
          await sleep(Math.max(0, Math.min(delayMs, stopAt - Date.now())));
        }

        async function driveTransitions(client: SeededClient): Promise<void> {
          // Staggered so `CLIENT_COUNT` drivers do not all publish in the
          // same instant.
          await sleepUntilOrStop(Math.random() * TRANSITION_INTERVAL_RANGE_SECONDS[1] * 1_000);

          let cycleIndex = 0;
          while (Date.now() < stopAt) {
            const status = TRANSITION_CYCLE[cycleIndex % TRANSITION_CYCLE.length] ?? 'ACCEPTED';
            cycleIndex += 1;

            const measured = Date.now() >= warmupEndAt;
            const publishedAtPerf = performance.now();
            ledger.push(client.orderId, 'transition', { publishedAtPerf, measured });
            if (measured) {
              publishedMeasured += 1;
            }

            await orderNotifications.transitioned({
              orderId: client.orderId,
              customerId: client.customerId,
              masterId: client.masterId,
              to: status,
              priceMinor: 6700,
              // Undefined, like an admin override or a system-driven edge: no
              // party is excluded, so the one client listening on this order
              // always receives it (`order-events.publisher.ts`).
              actorUserId: undefined,
            });

            await sleepUntilOrStop(randomInRange(TRANSITION_INTERVAL_RANGE_SECONDS) * 1_000);
          }
        }

        async function drivePositions(client: SeededClient): Promise<void> {
          await sleepUntilOrStop(Math.random() * POSITION_INTERVAL_RANGE_SECONDS[1] * 1_000);

          let latitude = SEARCH_POINT.latitude;
          let longitude = SEARCH_POINT.longitude;

          while (Date.now() < stopAt) {
            const bearing = Math.random() * 2 * Math.PI;
            const moved = moveBy(latitude, longitude, Math.random() * POSITION_STEP_M, bearing);
            latitude = moved.latitude;
            longitude = moved.longitude;

            // Force this report to be the leading edge of its order's
            // fan-out window, so the real throttle check
            // (`MasterPositionPublisher#openWindow`) always runs and always
            // lets this one through — see header comment.
            await redis.del(positionFanoutKey(keyPrefix, client.orderId));

            const measured = Date.now() >= warmupEndAt;
            const publishedAtPerf = performance.now();
            ledger.push(client.orderId, 'position', { publishedAtPerf, measured });
            if (measured) {
              publishedMeasured += 1;
            }

            await masterLocations.reported({
              masterId: client.masterId,
              latitude,
              longitude,
              recordedAt: new Date(),
            });

            await sleepUntilOrStop(randomInRange(POSITION_INTERVAL_RANGE_SECONDS) * 1_000);
          }
        }

        await Promise.all(
          clients.flatMap((client) => [driveTransitions(client), drivePositions(client)]),
        );

        // Give the last frames of the window time to land before deciding
        // anything still outstanding is lost.
        await sleep(DRAIN_MS);

        const lostMeasured = ledger.outstanding().filter((entry) => entry.measured).length;

        const sortedSame = [...sameInstanceSamples].sort((a, b) => a - b);
        const sortedCross = [...crossInstanceSamples].sort((a, b) => a - b);
        const receivedMeasured = sortedSame.length + sortedCross.length;

        function report(label: string, sorted: readonly number[]): string[] {
          if (sorted.length === 0) {
            return [`  ${label}: no samples`];
          }
          return [
            `  ${label}:`,
            `    samples: ${String(sorted.length)}`,
            `    p50: ${percentile(sorted, 0.5).toFixed(2)} ms`,
            `    p95: ${percentile(sorted, 0.95).toFixed(2)} ms`,
            `    p99: ${percentile(sorted, 0.99).toFixed(2)} ms`,
            `    max: ${(sorted[sorted.length - 1] ?? Number.NaN).toFixed(2)} ms`,
          ];
        }

        const cpu = os.cpus()[0];

        process.stdout.write(
          [
            '',
            'realtime delivery benchmark',
            `  clients:              ${String(CLIENT_COUNT)} (split evenly across instance A and instance B)`,
            `  warmup:               ${String(WARMUP_SECONDS)} s`,
            `  duration:             ${String(DURATION_SECONDS)} s`,
            `  events published:     ${String(publishedMeasured)}`,
            `  events received:      ${String(receivedMeasured)}`,
            `  events lost:          ${String(lostMeasured)}`,
            `  unexpected receipts:  ${String(unexpectedReceipts)}`,
            ...report('same-instance (A -> A)', sortedSame),
            ...report('cross-instance (A -> B, via Redis streams adapter)', sortedCross),
            `  cpu:                  ${cpu?.model ?? 'unknown'} x${String(os.cpus().length)}`,
            `  total memory:         ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`,
            `  postgres:             ${pgVersion ?? 'unknown'}`,
            `  redis:                ${redisVersion}`,
            '  note: the generator, both instances and every client share one',
            '        process and one event loop (see header comment).',
            '',
          ].join('\n'),
        );

        expect(unexpectedReceipts).toBe(0);
        expect(lostMeasured).toBe(0);
        expect(sortedSame.length).toBeGreaterThan(0);
        expect(sortedCross.length).toBeGreaterThan(0);
        expect(percentile(sortedSame, 0.95)).toBeLessThan(P95_BUDGET_MS);
        expect(percentile(sortedCross, 0.95)).toBeLessThan(P95_BUDGET_MS);
      },
      (WARMUP_SECONDS + DURATION_SECONDS) * 1_000 + SETUP_TIMEOUT_MS + DRAIN_MS,
    );
  },
);
