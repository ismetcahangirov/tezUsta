import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { MasterLocationReceipt, MasterPositionRealtimeEvent } from '@tezusta/types';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { MockInstance } from 'vitest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { AppConfig } from '../src/infra/config/app-config.types';
import { APP_CONFIG } from '../src/infra/config/config.tokens';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { OrdersRepository } from '../src/modules/orders/orders.repository';
import { positionFanoutKey } from '../src/modules/realtime/master-position.publisher';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { UsersRepository } from '../src/modules/users/users.repository';
import { expectLoggerIsListening, spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * A master's position reaching the one customer entitled to see it, and nobody
 * else, ever (issue #169).
 *
 * **One sentence is the whole security surface of this file**: a master's live
 * position is visible to the customer on the active order, and only while that
 * order is active (CLAUDE.md §11). So the positive test is one test, and the
 * rest of the file is the ways it must not leak — each asserted by an
 * **absence of delivery** rather than by an error code, because a fan-out that
 * reached one extra socket returns nothing to notice.
 *
 * **The fan-out window is deliberately long here (30 s) and the orders are
 * fresh per test.** The window is keyed per order, so the first report on a
 * new order always publishes and every later one in the same test is
 * throttled — which makes "one broadcast per window" assertable without a
 * test that sleeps through a window.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99460${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
/**
 * Distinctive enough that a substring search of every log sink means
 * something. Nothing else in the fixture data contains these digits.
 *
 * About 450 m from {@link SEARCH_POINT}, where each master's first row is
 * seeded a moment before they report: a point further away would be a jump
 * the plausibility check refuses (issue #274, ADR-0044), and the suite would
 * be testing that instead of the fan-out.
 */
const REPORTED_POINT = { latitude: 40.374819, longitude: 49.846537 };

const POSITION_EVENT = 'order:master-position';
const FANOUT_SECONDS = 30;

const ARRIVAL_TIMEOUT_MS = 10_000;
const SILENCE_MS = 1_200;
const TEST_TIMEOUT_MS = 60_000;

interface RoomAck {
  readonly ok: boolean;
  readonly room?: string;
  readonly code?: string;
}

interface SeededMaster {
  readonly masterId: string;
  readonly accessToken: string;
}

interface SeededCustomer {
  readonly orderId: string;
  readonly accessToken: string;
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Records every position frame on one socket, attached before the action. */
class Recorder {
  private readonly received: MasterPositionRealtimeEvent[] = [];
  private readonly handler = (payload: MasterPositionRealtimeEvent): void => {
    this.received.push(payload);
  };

  constructor(private readonly socket: Socket) {
    socket.on(POSITION_EVENT, this.handler);
  }

  async next(): Promise<MasterPositionRealtimeEvent> {
    const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
    for (;;) {
      const found = this.received[0];
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`no ${POSITION_EVENT} arrived within ${String(ARRIVAL_TIMEOUT_MS)}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  all(): readonly MasterPositionRealtimeEvent[] {
    return [...this.received];
  }

  async quiet(): Promise<readonly MasterPositionRealtimeEvent[]> {
    await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));
    return [...this.received];
  }

  clear(): void {
    this.received.length = 0;
  }

  stop(): void {
    this.socket.off(POSITION_EVENT, this.handler);
  }
}

describe('a master’s position fans out to the active order’s customer (issue #169)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let ordersRepository: OrdersRepository;
  let redis: Redis;
  let config: AppConfig;
  let serviceId: string;
  let url: string;

  const opened: Socket[] = [];
  const recorders: Recorder[] = [];
  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();
  let spies: MockInstance[] = [];

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function signIn(): Promise<{ userId: string; accessToken: string }> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
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

  function ask(socket: Socket, event: string, payload: unknown): Promise<RoomAck> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ack for ${event}`));
      }, ARRIVAL_TIMEOUT_MS);
      socket.emit(event, payload, (ack: RoomAck) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  function record(socket: Socket): Recorder {
    const recorder = new Recorder(socket);
    recorders.push(recorder);
    return recorder;
  }

  /** One position report, at the distinctive point unless told otherwise. */
  function report(master: SeededMaster, point = REPORTED_POINT) {
    return post('/masters/me/location', master.accessToken).send(point);
  }

  /**
   * Re-opens an order's fan-out window, so a test can make two broadcasts
   * without waiting {@link FANOUT_SECONDS}.
   *
   * It deletes the key the publisher itself builds, through the exported
   * helper rather than a re-spelled string — the point of exporting it.
   */
  async function reopenWindow(orderId: string): Promise<void> {
    await redis.del(positionFanoutKey(config.redis.keyPrefix, orderId));
  }

  async function seedMaster(): Promise<SeededMaster> {
    const caller = await signIn();
    const created = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;

    await pool.query(
      `update masters set verification_status = 'active', is_available = true,
                          commission_debt_minor = 0
        where id = $1`,
      [masterId],
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, 6700, true)`,
      [masterId, serviceId],
    );
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), now())`,
      [randomUUID(), masterId, SEARCH_POINT.longitude, SEARCH_POINT.latitude],
    );
    await presence.refresh(masterId);

    seededMasterIds.push(masterId);
    return { masterId, accessToken: caller.accessToken };
  }

  async function seedOrder(): Promise<SeededCustomer> {
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
    const offer = await eventually(
      async () => {
        const { rows } = await pool.query<{ id: string; status: string }>(
          `select id::text as id, status from order_offers
            where order_id = $1 and master_id = $2`,
          [orderId, master.masterId],
        );
        return rows[0];
      },
      (value) => value !== undefined && value.status === 'offered',
    );
    const accepted = await post(
      `/masters/me/offers/${offer?.id ?? ''}/accept`,
      master.accessToken,
    ).send({});
    expect(accepted.status).toBe(200);
  }

  function transition(orderId: string, to: string, token: string) {
    return post(`/orders/${orderId}/transitions`, token).send({ to, reason: 'Test səbəbi' });
  }

  /** An accepted order with the customer already listening to its room. */
  async function travellingOrder(): Promise<{
    order: SeededCustomer;
    master: SeededMaster;
    customerSocket: Socket;
    positions: Recorder;
  }> {
    const master = await seedMaster();
    const order = await seedOrder();
    await accept(order.orderId, master);

    const customerSocket = await dial(order.accessToken);
    expect(
      await ask(customerSocket, 'room:join', { kind: 'order', orderId: order.orderId }),
    ).toMatchObject({ ok: true });

    return { order, master, customerSocket, positions: record(customerSocket) };
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

    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');
    // The ingest limiter is #98's subject and an obstacle to every test here.
    // Raised, never removed: this issue does not loosen it in production and
    // does not add a second limiter beside it.
    set('MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_LOCATION_RATE_LIMIT_PER_IP_HOUR', '9000');

    set('DISPATCH_INITIAL_RADIUS_M', '1000');
    set('DISPATCH_MAX_RADIUS_M', '4000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '2');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '20');
    set('DISPATCH_MAX_MASTERS_PER_BROADCAST', '10');
    set('MAX_ORDER_REDISPATCHES', '3');

    set('REALTIME_INBOUND_MESSAGES_PER_SECOND', '50');
    set('REALTIME_INBOUND_BURST', '50');
    set('REALTIME_POSITION_FANOUT_SECONDS', String(FANOUT_SECONDS));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // `TestingLogger` swallows `log`, `warn` and `debug`, which would make
      // the "no coordinate is logged" assertion below pass vacuously.
      .setLogger(new ConsoleLogger())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
    ordersRepository = app.get(OrdersRepository);
    redis = app.get<Redis>(REDIS_CLIENT);
    config = app.get<AppConfig>(APP_CONFIG);

    pool = new Pool({ connectionString: database.url });
    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 120_000);

  afterEach(async () => {
    for (const spy of spies) {
      spy.mockRestore();
    }
    spies = [];
    while (recorders.length > 0) {
      recorders.pop()?.stop();
    }
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

  describe('the customer on the order', () => {
    it(
      'receives the master’s position after a report',
      async () => {
        const { order, master, positions } = await travellingOrder();

        expect((await report(master)).status).toBe(200);

        const event = await positions.next();
        expect(event).toStrictEqual({
          orderId: order.orderId,
          latitude: REPORTED_POINT.latitude,
          longitude: REPORTED_POINT.longitude,
          at: expect.any(Number) as number,
        });
        // The database's `recorded_at`, not the publisher's clock — the marker
        // ages from when the point was taken.
        const { rows } = await pool.query<{ recorded_at: Date }>(
          `select recorded_at from master_locations
            where master_id = $1 order by recorded_at desc limit 1`,
          [master.masterId],
        );
        expect(event.at).toBe(rows[0]?.recorded_at.getTime());
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'is told nothing about a master who is not on their order',
      async () => {
        const mine = await travellingOrder();
        const stranger = await seedMaster();

        expect((await report(stranger)).status).toBe(200);

        expect(await mine.positions.quiet()).toStrictEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'is told nothing about a position refused as an impossible jump (issue #274)',
      async () => {
        const { master, positions } = await travellingOrder();

        // ~50 km from the seeded fix, a moment after it: refused, and the
        // refusal must reach the customer's map no more than the table.
        const refused = await report(master, {
          latitude: REPORTED_POINT.latitude + 0.45,
          longitude: REPORTED_POINT.longitude,
        });
        expect(refused.status).toBe(422);
        expect((refused.body as { error: { code: string } }).error.code).toBe(
          'LOCATION_IMPLAUSIBLE',
        );

        expect(await positions.quiet()).toStrictEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  });

  /**
   * The receipt's `engagedOrderId` is how a backgrounded app — socket closed —
   * learns its job has ended and stops its background session (issue #171).
   */
  describe('the report’s answer names the job it is reporting for', () => {
    it(
      'names the order while the master is on it, and nothing once it is cancelled',
      async () => {
        const { order, master } = await travellingOrder();

        const during = await report(master);
        expect((during.body as MasterLocationReceipt).engagedOrderId).toBe(order.orderId);

        expect((await transition(order.orderId, 'CANCELLED', order.accessToken)).status).toBe(200);

        const after = await report(master);
        expect((after.body as MasterLocationReceipt).engagedOrderId).toBeNull();
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('nobody else receives it', () => {
    it(
      'not another customer, and not another master',
      async () => {
        const { order, master, positions } = await travellingOrder();

        const otherCustomer = await seedOrder();
        const otherCustomerSocket = await dial(otherCustomer.accessToken);
        // Refused by #167, and then asserted by silence: a refusal that
        // returned the right code and joined anyway leaks every position.
        expect(
          await ask(otherCustomerSocket, 'room:join', { kind: 'order', orderId: order.orderId }),
        ).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });

        const otherMaster = await seedMaster();
        const otherMasterSocket = await dial(otherMaster.accessToken);
        expect(
          await ask(otherMasterSocket, 'room:join', { kind: 'order', orderId: order.orderId }),
        ).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });

        const strangerHears = record(otherCustomerSocket);
        const otherMasterHears = record(otherMasterSocket);

        expect((await report(master)).status).toBe(200);

        // The delivery to the entitled customer is what makes the two
        // silences assertions rather than coincidences of timing.
        await positions.next();
        expect(await strangerHears.quiet()).toStrictEqual([]);
        expect(await otherMasterHears.quiet()).toStrictEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('publishing stops when the order does', () => {
    it(
      'stops on completion, and the master keeps reporting',
      async () => {
        const { order, master, positions } = await travellingOrder();

        expect((await report(master)).status).toBe(200);
        await positions.next();
        positions.clear();
        await reopenWindow(order.orderId);

        for (const to of ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
          expect((await transition(order.orderId, to, master.accessToken)).status).toBe(200);
        }
        positions.clear();

        expect((await report(master)).status).toBe(200);

        expect(await positions.quiet()).toStrictEqual([]);
        expect(await ordersRepository.findEngagedOrderIdForMaster(master.masterId)).toBeUndefined();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'stops on cancellation',
      async () => {
        const { order, master, positions } = await travellingOrder();

        expect((await report(master)).status).toBe(200);
        await positions.next();
        positions.clear();
        await reopenWindow(order.orderId);

        expect((await transition(order.orderId, 'CANCELLED', order.accessToken)).status).toBe(200);
        positions.clear();

        expect((await report(master)).status).toBe(200);

        expect(await positions.quiet()).toStrictEqual([]);
        expect(await ordersRepository.findEngagedOrderIdForMaster(master.masterId)).toBeUndefined();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'stops on re-dispatch, while the customer is still in the room',
      async () => {
        const { order, master, customerSocket, positions } = await travellingOrder();

        expect((await report(master)).status).toBe(200);
        await positions.next();
        positions.clear();
        await reopenWindow(order.orderId);

        expect((await transition(order.orderId, 'SEARCHING', master.accessToken)).status).toBe(200);
        positions.clear();

        // The sharpest case in this file. A re-dispatch clears `master_id` but
        // leaves the order live, so the customer is **still a party and still
        // in the room** — the eviction that protects the terminal cases does
        // not apply here, and only the lookup stops the ex-master's position
        // reaching them.
        expect((await report(master)).status).toBe(200);
        expect(await positions.quiet()).toStrictEqual([]);
        expect(
          await ask(customerSocket, 'room:join', { kind: 'order', orderId: order.orderId }),
        ).toMatchObject({ ok: true });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the throttle', () => {
    it(
      'collapses a burst to one broadcast',
      async () => {
        const { master, positions } = await travellingOrder();

        for (let step = 0; step < 4; step += 1) {
          expect(
            (
              await report(master, {
                latitude: REPORTED_POINT.latitude + step / 10_000,
                longitude: REPORTED_POINT.longitude,
              })
            ).status,
          ).toBe(200);
        }

        await positions.next();
        // Waited out rather than counted immediately: a second broadcast that
        // was merely slower than the assertion would otherwise pass.
        const delivered = await positions.quiet();
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.latitude).toBe(REPORTED_POINT.latitude);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'is one window per order, not one per master',
      async () => {
        const first = await travellingOrder();

        expect((await report(first.master)).status).toBe(200);
        await first.positions.next();

        // A second order, a second master, a window of its own: the throttle
        // must not be a single global gate.
        const second = await travellingOrder();
        expect((await report(second.master)).status).toBe(200);
        await second.positions.next();

        expect(second.positions.all()).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('a master with no order', () => {
    it(
      'broadcasts nothing but still writes its row',
      async () => {
        const master = await seedMaster();
        const bystander = await travellingOrder();

        const before = await pool.query<{ count: string }>(
          'select count(*)::text as count from master_locations where master_id = $1',
          [master.masterId],
        );

        expect((await report(master)).status).toBe(200);

        const after = await pool.query<{ count: string }>(
          'select count(*)::text as count from master_locations where master_id = $1',
          [master.masterId],
        );
        expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count) + 1);
        expect(await bystander.positions.quiet()).toStrictEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the things that must not happen', () => {
    it(
      'writes no coordinate to any log sink',
      async () => {
        const { master, positions } = await travellingOrder();

        const sink: string[] = [];
        spies = spyOnEveryLogSink(sink);
        expectLoggerIsListening(sink, 'MasterPositionFanout');

        expect((await report(master)).status).toBe(200);
        await positions.next();

        const everything = sink.join('\n');
        expect(everything).not.toContain(String(REPORTED_POINT.latitude));
        expect(everything).not.toContain(String(REPORTED_POINT.longitude));
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'answers "which active order is this master on" from an index',
      async () => {
        const { master } = await travellingOrder();

        const { rows } = await pool.query<{ 'QUERY PLAN': unknown[] }>(
          `explain (format json)
             select id from orders
              where master_id = $1
                and status in ('ACCEPTED','MASTER_ON_THE_WAY','MASTER_ARRIVED','IN_PROGRESS')
              limit 1`,
          [master.masterId],
        );

        const plan = JSON.stringify(rows[0]?.['QUERY PLAN']);
        // The partial unique index that already exists to make "one active
        // order per master" unraceable. Its predicate is exactly this `WHERE`,
        // which is why #169 added no second index — and why a drift between
        // the two lists would show up here rather than as a slow hot path.
        expect(plan).toContain('orders_one_active_per_master');
        expect(plan).not.toContain('Seq Scan');
      },
      TEST_TIMEOUT_MS,
    );
  });
});
