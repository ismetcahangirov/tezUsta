import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  CurrentMasterJob,
  OrderArrivalPromiseRealtimeEvent,
  OrderDetail,
} from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { estimateDrivingSeconds } from '../src/infra/geo/driving-estimate';
import { ROUTING_PROVIDER } from '../src/infra/geo/routing.types';
import type { RouteEstimate, RoutingProvider } from '../src/infra/geo/routing.types';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { DeferredJobHandlerRegistry } from '../src/infra/queue/deferred-job-handler.registry';
import { SessionsService } from '../src/modules/auth/sessions.service';
import {
  ARRIVAL_PROMISE_JOB,
  ARRIVAL_PROMISE_SWEEP_JOB,
} from '../src/modules/orders/arrival-promise.job';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';
import { grantTestSubscription } from './support/subscriptions';

/**
 * The arrival promise end to end (issue #396,
 * [ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)
 * § 7–13): a real accept, the job on the `arrival` queue, the conditional
 * write, the three reads and the socket frame.
 *
 * The routing provider is the one thing replaced: a controllable fake, so a
 * test can choose a route, a failure or no road, and can hold the job until
 * both parties' sockets are listening. Everything else is the application.
 *
 * Cases that need a state no accept can produce — an accepted master with no
 * fresh position, an accept a minute old with no job — are written with SQL
 * and run the handler directly, which is also how idempotency is shown: the
 * same job run again, after a re-dispatch, and for the wrong accept.
 */

let emailCounter = 0;
function nextEmail(): string {
  emailCounter += 1;
  return `user-${String(emailCounter)}@example.com`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const NEAR = { latitude: 40.381, longitude: 49.85 };
/** A second master, a different distance from the job. */
const ACROSS = { latitude: 40.36, longitude: 49.82 };
const ROUTE_SECONDS = 600;
const BUFFER_SECONDS = 30;
const ARRIVAL_EVENT = 'order:arrival-promise';
const TEST_TIMEOUT_MS = 60_000;

class ControllableRouting implements RoutingProvider {
  mode: 'route' | 'throw' | 'null' = 'route';
  calls = 0;
  private release: (() => void) | null = null;
  private gate: Promise<void> | null = null;

  /** Holds every call until {@link open}, so sockets can join before the frame. */
  hold(): void {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.release?.();
    this.gate = null;
    this.release = null;
  }

  reset(): void {
    this.open();
    this.mode = 'route';
    this.calls = 0;
  }

  async drivingRoute(): Promise<RouteEstimate | null> {
    this.calls += 1;
    if (this.gate !== null) {
      await this.gate;
    }
    if (this.mode === 'throw') {
      throw new Error('The routing provider did not answer: HTTP 503.');
    }
    if (this.mode === 'null') {
      return null;
    }
    return { durationSeconds: ROUTE_SECONDS, distanceMeters: 5_000 };
  }
}

async function eventually<T>(
  produce: () => Promise<T>,
  satisfied: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (satisfied(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Condition still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface SeededMaster {
  readonly masterId: string;
  readonly accessToken: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly accessToken: string;
}

interface PromiseRow {
  readonly promised_arrival_at: Date | null;
  readonly arrival_promise_source: string | null;
  readonly accepted_at: Date | null;
}

describe('the arrival promise (issue #396)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let handlers: DeferredJobHandlerRegistry;
  let serviceId: string;
  let url: string;
  const routing = new ControllableRouting();

  const opened: Socket[] = [];
  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function post(path: string, accessToken: string) {
    return request(app.getHttpServer()).post(path).set('authorization', `Bearer ${accessToken}`);
  }

  function get(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).get(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function signIn(): Promise<{ accessToken: string }> {
    const created = await usersRepo.create({ email: nextEmail(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { accessToken: pair.accessToken };
  }

  async function dial(token: string): Promise<Socket> {
    const socket = io(url, { transports: ['websocket'], reconnection: false, auth: { token } });
    opened.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    return socket;
  }

  function joinOrder(socket: Socket, orderId: string): Promise<{ ok: boolean }> {
    return new Promise((resolve) => {
      socket.emit('room:join', { kind: 'order', orderId }, resolve);
    });
  }

  function frames(socket: Socket): OrderArrivalPromiseRealtimeEvent[] {
    const received: OrderArrivalPromiseRealtimeEvent[] = [];
    socket.on(ARRIVAL_EVENT, (payload: OrderArrivalPromiseRealtimeEvent) => {
      received.push(payload);
    });
    return received;
  }

  /**
   * A master with a position. `dispatchable: false` leaves out the service
   * offer and subscription, so no wave offers them anything — for the cases
   * whose accept is written with SQL.
   */
  async function seedMaster(
    at = NEAR,
    { dispatchable = true, positionAgeSeconds = 0 } = {},
  ): Promise<SeededMaster> {
    const caller = await signIn();
    const created = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;

    await pool.query(
      `update masters set verification_status = 'active', is_available = true where id = $1`,
      [masterId],
    );
    if (dispatchable) {
      await grantTestSubscription(pool, masterId);
      await pool.query(
        `insert into master_services (master_id, service_id, price_minor, is_active)
         values ($1, $2, 6700, true)`,
        [masterId, serviceId],
      );
    }
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326),
               now() - make_interval(secs => $5))`,
      [randomUUID(), masterId, at.longitude, at.latitude, positionAgeSeconds],
    );
    if (dispatchable) {
      await presence.refresh(masterId);
    }
    seededMasterIds.push(masterId);
    return { masterId, accessToken: caller.accessToken };
  }

  async function seedOrder(): Promise<SeededOrder> {
    const caller = await signIn();
    expect(
      (await post('/customers', caller.accessToken).send({ displayName: 'Müştəri' })).status,
    ).toBe(201);
    const address = await post('/addresses', caller.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);
    const order = await post('/orders', caller.accessToken).send({
      serviceId,
      addressId: (address.body as { id: string }).id,
      description: 'Mətbəxdə kran sızır, su kəsilmir.',
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);
    return { orderId: (order.body as { id: string }).id, accessToken: caller.accessToken };
  }

  async function accept(orderId: string, master: SeededMaster): Promise<void> {
    const offers = await eventually(
      async () =>
        (
          await pool.query<{ id: string; status: string }>(
            `select id::text as id, status from order_offers where order_id = $1 and master_id = $2`,
            [orderId, master.masterId],
          )
        ).rows,
      (rows) => rows[0]?.status === 'offered',
    );
    const accepted = await post(
      `/masters/me/offers/${offers[0]?.id ?? ''}/accept`,
      master.accessToken,
    ).send({});
    expect(accepted.status).toBe(200);
  }

  /**
   * An accept no request made: the order moved to `ACCEPTED` for `master` by
   * SQL, with the accepted offer the job's fallback reads. No job is
   * scheduled, which is the point.
   */
  async function acceptBySql(
    order: SeededOrder,
    master: SeededMaster,
    { acceptedAgoSeconds = 0, distanceM = 2_000 } = {},
  ): Promise<number> {
    await pool.query(
      `insert into order_offers
         (id, order_id, master_id, round, radius_m, distance_m, status, expires_at, responded_at)
       values ($1, $2, $3, 1, 3000, $4, 'accepted', now(), now())`,
      [randomUUID(), order.orderId, master.masterId, distanceM],
    );
    const { rows } = await pool.query<{ accepted_at_ms: string }>(
      `update orders
          set status = 'ACCEPTED', master_id = $2, price_minor = 6700,
              accepted_at = date_trunc('milliseconds', now() - make_interval(secs => $3))
        where id = $1
       returning (extract(epoch from accepted_at) * 1000)::bigint::text as accepted_at_ms`,
      [order.orderId, master.masterId, acceptedAgoSeconds],
    );
    return Number(rows[0]?.accepted_at_ms);
  }

  async function promiseOf(orderId: string): Promise<PromiseRow | undefined> {
    const { rows } = await pool.query<PromiseRow>(
      `select promised_arrival_at, arrival_promise_source, accepted_at from orders where id = $1`,
      [orderId],
    );
    return rows[0];
  }

  function promised(orderId: string): Promise<PromiseRow | undefined> {
    return eventually(
      () => promiseOf(orderId),
      (row) => row?.promised_arrival_at !== null && row?.promised_arrival_at !== undefined,
    );
  }

  /** Seconds between the accept and the promise, buffer included. */
  function promisedAfterAccept(row: PromiseRow | undefined): number {
    if (row?.promised_arrival_at == null || row.accepted_at == null) {
      throw new Error('no promise to measure');
    }
    return (row.promised_arrival_at.getTime() - row.accepted_at.getTime()) / 1000;
  }

  async function straightLineM(from: typeof NEAR, to: typeof SEARCH_POINT): Promise<number> {
    const { rows } = await pool.query<{ d: number }>(
      `select ST_Distance(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                          ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)::float8 as d`,
      [from.longitude, from.latitude, to.longitude, to.latitude],
    );
    return Number(rows[0]?.d);
  }

  function runJob(orderId: string, masterId: string, acceptedAtMs: number): Promise<void> {
    return handlers.resolve(ARRIVAL_PROMISE_JOB)({ orderId, masterId, acceptedAtMs });
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('PRESENCE_TTL_SECONDS', '60');
    set('PRESENCE_HEARTBEAT_SECONDS', '10');
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', '120');
    set('ARRIVAL_PROMISE_BUFFER_SECONDS', String(BUFFER_SECONDS));
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_FEED_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('DISPATCH_INITIAL_RADIUS_M', '3000');
    set('DISPATCH_MAX_RADIUS_M', '4000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '2');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '20');
    set('MAX_ORDER_REDISPATCHES', '3');
    set('REALTIME_INBOUND_MESSAGES_PER_SECOND', '50');
    set('REALTIME_INBOUND_BURST', '50');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(routing)
      .setLogger(new ConsoleLogger())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
    handlers = app.get(DeferredJobHandlerRegistry);

    pool = new Pool({ connectionString: database.url });
    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 120_000);

  afterEach(async () => {
    routing.reset();
    while (opened.length > 0) {
      opened.pop()?.disconnect();
    }
    if (seededMasterIds.length > 0) {
      await pool.query('update masters set is_available = false where id = any($1::uuid[])', [
        seededMasterIds,
      ]);
      seededMasterIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
    await database.drop();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  describe('after a real accept', () => {
    it(
      'promises accept + route + 30 s on both reads, and tells both parties and nobody else',
      async () => {
        const master = await seedMaster();
        const order = await seedOrder();
        const bystander = await seedOrder();
        routing.hold();
        await accept(order.orderId, master);

        const customerSocket = await dial(order.accessToken);
        const masterSocket = await dial(master.accessToken);
        const bystanderSocket = await dial(bystander.accessToken);
        expect(await joinOrder(customerSocket, order.orderId)).toMatchObject({ ok: true });
        expect(await joinOrder(masterSocket, order.orderId)).toMatchObject({ ok: true });
        expect(await joinOrder(bystanderSocket, bystander.orderId)).toMatchObject({ ok: true });
        const toCustomer = frames(customerSocket);
        const toMaster = frames(masterSocket);
        const toBystander = frames(bystanderSocket);
        routing.open();

        const row = await promised(order.orderId);
        expect(row?.arrival_promise_source).toBe('route');
        expect(promisedAfterAccept(row)).toBe(ROUTE_SECONDS + BUFFER_SECONDS);
        const promisedAt = row?.promised_arrival_at?.toISOString();

        const customerRead = await get(`/orders/${order.orderId}`, order.accessToken);
        expect(customerRead.status).toBe(200);
        const detail = customerRead.body as OrderDetail;
        expect(detail.arrivalPromise).toStrictEqual({
          promisedAt,
          secondsRemaining: expect.any(Number) as number,
          source: 'route',
        });
        expect(detail.arrivalPromise?.secondsRemaining).toBeGreaterThan(ROUTE_SECONDS - 30);
        expect(detail.arrivalPromise?.secondsRemaining).toBeLessThanOrEqual(
          ROUTE_SECONDS + BUFFER_SECONDS,
        );

        const masterRead = await get('/masters/me/jobs/current', master.accessToken);
        expect(masterRead.status).toBe(200);
        expect((masterRead.body as CurrentMasterJob).job?.arrivalPromise).toMatchObject({
          promisedAt,
          source: 'route',
        });

        await eventually(
          () => Promise.resolve(toCustomer.length + toMaster.length),
          (count) => count === 2,
        );
        for (const frame of [toCustomer[0], toMaster[0]]) {
          expect(frame).toStrictEqual({
            orderId: order.orderId,
            promisedArrivalAt: promisedAt,
            source: 'route',
            at: expect.any(Number) as number,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(toBystander).toStrictEqual([]);
        expect(routing.calls).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it.each(['throw', 'null'] as const)(
      'falls back to the estimate when routing answers %s, and the accept still succeeds',
      async (mode) => {
        routing.mode = mode;
        const master = await seedMaster();
        const order = await seedOrder();
        await accept(order.orderId, master);

        const row = await promised(order.orderId);

        expect(row?.arrival_promise_source).toBe('estimate');
        expect(promisedAfterAccept(row)).toBe(
          estimateDrivingSeconds(await straightLineM(NEAR, SEARCH_POINT)) + BUFFER_SECONDS,
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'clears the promise on a re-dispatch; the old accept’s job writes nothing, the next master gets their own',
      async () => {
        const first = await seedMaster();
        const order = await seedOrder();
        await accept(order.orderId, first);
        const before = await promised(order.orderId);
        const oldAcceptMs = before?.accepted_at?.getTime() ?? 0;

        const back = await post(`/orders/${order.orderId}/transitions`, first.accessToken).send({
          to: 'SEARCHING',
          reason: 'Test səbəbi',
        });
        expect(back.status).toBe(200);
        expect(await promiseOf(order.orderId)).toMatchObject({
          promised_arrival_at: null,
          arrival_promise_source: null,
          accepted_at: null,
        });

        await runJob(order.orderId, first.masterId, oldAcceptMs);
        expect((await promiseOf(order.orderId))?.promised_arrival_at).toBeNull();
        expect(
          ((await get(`/orders/${order.orderId}`, order.accessToken)).body as OrderDetail)
            .arrivalPromise,
        ).toBeNull();

        // The estimate is a function of the master's own distance, so it
        // proves whose data the second promise was computed from.
        routing.mode = 'throw';
        const second = await seedMaster(ACROSS);
        await accept(order.orderId, second);
        const after = await promised(order.orderId);
        expect(after?.accepted_at?.getTime()).not.toBe(oldAcceptMs);
        expect(promisedAfterAccept(after)).toBe(
          estimateDrivingSeconds(await straightLineM(ACROSS, SEARCH_POINT)) + BUFFER_SECONDS,
        );
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the job', () => {
    it(
      'estimates from the accepted offer’s distance when the master has no fresh position',
      async () => {
        const master = await seedMaster(NEAR, { dispatchable: false, positionAgeSeconds: 600 });
        const order = await seedOrder();
        const acceptedAtMs = await acceptBySql(order, master, { distanceM: 2_000 });

        await runJob(order.orderId, master.masterId, acceptedAtMs);

        const row = await promiseOf(order.orderId);
        expect(row?.arrival_promise_source).toBe('estimate');
        expect(promisedAfterAccept(row)).toBe(estimateDrivingSeconds(2_000) + BUFFER_SECONDS);
        expect(routing.calls).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'writes once: not for another accept, not twice, and never moves a promise',
      async () => {
        const master = await seedMaster(NEAR, { dispatchable: false });
        const order = await seedOrder();
        const acceptedAtMs = await acceptBySql(order, master);

        await runJob(order.orderId, master.masterId, acceptedAtMs + 1);
        expect((await promiseOf(order.orderId))?.promised_arrival_at).toBeNull();

        await runJob(order.orderId, master.masterId, acceptedAtMs);
        const first = await promiseOf(order.orderId);
        expect(first?.promised_arrival_at).not.toBeNull();

        routing.mode = 'throw';
        await runJob(order.orderId, master.masterId, acceptedAtMs);
        expect(await promiseOf(order.orderId)).toStrictEqual(first);
        expect(routing.calls).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'is swept for an accept that has gone a minute without one, and not for a fresh accept',
      async () => {
        const stale = await seedMaster(NEAR, { dispatchable: false });
        const staleOrder = await seedOrder();
        await acceptBySql(staleOrder, stale, { acceptedAgoSeconds: 120 });
        const fresh = await seedMaster(NEAR, { dispatchable: false });
        const freshOrder = await seedOrder();
        await acceptBySql(freshOrder, fresh, { acceptedAgoSeconds: 5 });

        await handlers.resolve(ARRIVAL_PROMISE_SWEEP_JOB)({});

        expect((await promised(staleOrder.orderId))?.arrival_promise_source).toBe('route');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect((await promiseOf(freshOrder.orderId))?.promised_arrival_at).toBeNull();
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the column and the read', () => {
    it('refuses half a promise, or one on an order nobody accepted', async () => {
      const order = await seedOrder();

      await expect(
        pool.query(`update orders set promised_arrival_at = now() where id = $1`, [order.orderId]),
      ).rejects.toThrow(/orders_arrival_promise_shape/);
      await expect(
        pool.query(
          `update orders set promised_arrival_at = now(), arrival_promise_source = 'route'
            where id = $1`,
          [order.orderId],
        ),
      ).rejects.toThrow(/orders_arrival_promise_shape/);
    });

    it(
      'counts below zero once the promise has passed',
      async () => {
        const master = await seedMaster(NEAR, { dispatchable: false });
        const order = await seedOrder();
        await acceptBySql(order, master, { acceptedAgoSeconds: 900 });
        await pool.query(
          `update orders
              set promised_arrival_at = now() - interval '3 minutes',
                  arrival_promise_source = 'route'
            where id = $1`,
          [order.orderId],
        );

        const read = await get(`/orders/${order.orderId}`, order.accessToken);

        const remaining = (read.body as OrderDetail).arrivalPromise?.secondsRemaining ?? 0;
        expect(remaining).toBeLessThanOrEqual(-180);
        expect(remaining).toBeGreaterThan(-200);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
