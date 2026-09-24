import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { OrderOfferRealtimeEvent, OrderTransitionRealtimeEvent } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Order and dispatch events reaching the socket, over a real socket, a real
 * Postgres and the live dispatch engine (issue #168).
 *
 * #167 settled who may be in a room. This file is about what arrives there —
 * and the two halves of that are not equally dangerous. A missing event is a
 * screen that waits for a poll; an event in the wrong room is somebody reading
 * another person's order. **So every positive assertion here has a negative
 * twin**, and the negative one is an absence of delivery rather than an error
 * code: a publish that reached one extra socket returns nothing to notice.
 *
 * **The events are asserted through real clients, never through a spy on the
 * publisher.** What the acceptance criteria claim is that a phone receives a
 * frame, and a test that asserted `emit` was called with the right arguments
 * would pass just as happily with the wrong room name in it.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99459${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
/** Far outside `DISPATCH_MAX_RADIUS_M`, so no wave can reach this master. */
const FAR_AWAY = { latitude: 40.6, longitude: 50.2 };

const TRANSITION_EVENT = 'order:transition';
const OFFER_EVENT = 'order:offer';

/** How long an assertion waits for a frame that should arrive. */
const ARRIVAL_TIMEOUT_MS = 10_000;
/**
 * How long an assertion waits to conclude a frame is *not* coming.
 *
 * Longer than a local publish takes by a wide margin, and short enough that
 * the file's handful of absence assertions do not dominate its runtime. Every
 * one of them is preceded by a delivery to somebody else that has already
 * arrived, so the window starts after the publish has demonstrably happened.
 */
const SILENCE_MS = 1_200;
/**
 * Per-test budget.
 *
 * Vitest's default is five seconds, and almost every test here first drives a
 * real dispatch wave to an accept and then waits out a silence window. The
 * number is generous on purpose: what these tests assert is *which socket*
 * received a frame, and a timeout tuned tight enough to fail on a loaded
 * machine would turn that into a flake about scheduling.
 */
const TEST_TIMEOUT_MS = 60_000;

interface RoomAck {
  readonly ok: boolean;
  readonly room?: string;
  readonly code?: string;
}

interface SeededMaster {
  readonly masterId: string;
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededCustomer {
  readonly orderId: string;
  readonly userId: string;
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

/**
 * Records every frame of one event as it arrives on one socket.
 *
 * **Attached before the action, drained after it.** A `once` listener
 * registered after the request that publishes would race the delivery, and the
 * absence assertions in this file need a recorder that was listening the whole
 * time rather than one that started late and found nothing.
 */
class Recorder<T> {
  private readonly received: T[] = [];
  private readonly handler = (payload: T): void => {
    this.received.push(payload);
  };

  constructor(
    private readonly socket: Socket,
    private readonly event: string,
  ) {
    socket.on(event, this.handler);
  }

  /** Waits for the next frame matching `matches`, or fails the test. */
  async next(matches: (payload: T) => boolean = () => true): Promise<T> {
    const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
    for (;;) {
      const found = this.received.find(matches);
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`no ${this.event} arrived within ${String(ARRIVAL_TIMEOUT_MS)}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Everything seen so far, in arrival order. */
  all(): readonly T[] {
    return [...this.received];
  }

  /** Waits out {@link SILENCE_MS} and reports what, if anything, arrived. */
  async quiet(matches: (payload: T) => boolean = () => true): Promise<readonly T[]> {
    await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));
    return this.received.filter(matches);
  }

  stop(): void {
    this.socket.off(this.event, this.handler);
  }
}

describe('order events on the socket (issue #168)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let adminRepository: AdminRepository;
  let adminSessions: AdminSessionService;
  let gateway: RealtimeGateway;
  let serviceId: string;
  let url: string;

  const opened: Socket[] = [];
  const recorders: Recorder<unknown>[] = [];
  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

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

  function record<T>(socket: Socket, event: string): Recorder<T> {
    const recorder = new Recorder<T>(socket, event);
    recorders.push(recorder as Recorder<unknown>);
    return recorder;
  }

  async function seedMaster(at = SEARCH_POINT): Promise<SeededMaster> {
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
      [randomUUID(), masterId, at.longitude, at.latitude],
    );
    await presence.refresh(masterId);

    seededMasterIds.push(masterId);
    return { masterId, userId: caller.userId, accessToken: caller.accessToken };
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

    return {
      orderId: (order.body as { id: string }).id,
      userId: caller.userId,
      accessToken: caller.accessToken,
    };
  }

  async function liveOffer(orderId: string, masterId: string): Promise<string> {
    const offer = await eventually(
      async () => {
        const { rows } = await pool.query<{ id: string; status: string }>(
          `select id::text as id, status from order_offers
            where order_id = $1 and master_id = $2`,
          [orderId, masterId],
        );
        return rows[0];
      },
      (value) => value !== undefined && value.status === 'offered',
    );
    return offer?.id ?? '';
  }

  async function accept(orderId: string, master: SeededMaster): Promise<void> {
    const offerId = await liveOffer(orderId, master.masterId);
    const accepted = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);
  }

  /**
   * `reason` is mandatory on `CANCELLED` and `SEARCHING` and refused nowhere,
   * so it is always sent: this file is about what reaches the socket, and a
   * 422 from `transitionOrderSchema` would be a different test's subject.
   */
  function transition(orderId: string, to: string, token: string) {
    return post(`/orders/${orderId}/transitions`, token).send({
      to,
      reason: 'Test səbəbi',
    });
  }

  /** An order with an assigned master, and both parties listening to its room. */
  async function acceptedOrder(): Promise<{
    order: SeededCustomer;
    master: SeededMaster;
    customerSocket: Socket;
    masterSocket: Socket;
  }> {
    const master = await seedMaster();
    const order = await seedOrder();
    await accept(order.orderId, master);

    const customerSocket = await dial(order.accessToken);
    const masterSocket = await dial(master.accessToken);
    expect(
      await ask(customerSocket, 'room:join', { kind: 'order', orderId: order.orderId }),
    ).toMatchObject({ ok: true });
    expect(
      await ask(masterSocket, 'room:join', { kind: 'order', orderId: order.orderId }),
    ).toMatchObject({ ok: true });

    return { order, master, customerSocket, masterSocket };
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

    set('DISPATCH_INITIAL_RADIUS_M', '1000');
    set('DISPATCH_MAX_RADIUS_M', '4000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '2');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '20');
    set('DISPATCH_MAX_MASTERS_PER_BROADCAST', '10');
    set('MAX_ORDER_REDISPATCHES', '3');

    set('REALTIME_INBOUND_MESSAGES_PER_SECOND', '50');
    set('REALTIME_INBOUND_BURST', '50');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .setLogger(new ConsoleLogger())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // The adapter `main.ts` installs. `except()` is carried to other instances
    // by the cluster adapter, and the in-memory one would prove nothing about
    // that.
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
    adminRepository = app.get(AdminRepository);
    adminSessions = app.get(AdminSessionService);
    gateway = app.get(RealtimeGateway);

    pool = new Pool({ connectionString: database.url });
    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
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

  describe('a broadcast wave reaches the masters it offered to, and nobody else', () => {
    it(
      'delivers an offer to the reached master’s own room',
      async () => {
        const master = await seedMaster();
        const socket = await dial(master.accessToken);
        expect(
          await ask(socket, 'room:join', { kind: 'master', masterId: master.masterId }),
        ).toMatchObject({ ok: true });
        const offers = record<OrderOfferRealtimeEvent>(socket, OFFER_EVENT);

        const order = await seedOrder();

        const event = await offers.next((payload) => payload.orderId === order.orderId);
        expect(event).toStrictEqual({ orderId: order.orderId, at: expect.any(Number) as number });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'delivers nothing to a master the wave never reached',
      async () => {
        const near = await seedMaster();
        const far = await seedMaster(FAR_AWAY);

        const nearSocket = await dial(near.accessToken);
        const farSocket = await dial(far.accessToken);
        expect(
          await ask(nearSocket, 'room:join', { kind: 'master', masterId: near.masterId }),
        ).toMatchObject({ ok: true });
        expect(
          await ask(farSocket, 'room:join', { kind: 'master', masterId: far.masterId }),
        ).toMatchObject({ ok: true });

        const reached = record<OrderOfferRealtimeEvent>(nearSocket, OFFER_EVENT);
        const outside = record<OrderOfferRealtimeEvent>(farSocket, OFFER_EVENT);

        const order = await seedOrder();

        // The delivery to the master inside the radius is what makes the
        // silence below an assertion rather than a coincidence of timing.
        await reached.next((payload) => payload.orderId === order.orderId);
        expect(await outside.quiet()).toStrictEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the customer learns their order was accepted', () => {
    it(
      'carries the order id, the new status and the frozen price',
      async () => {
        const master = await seedMaster();
        const order = await seedOrder();

        const customerSocket = await dial(order.accessToken);
        expect(
          await ask(customerSocket, 'room:join', { kind: 'order', orderId: order.orderId }),
        ).toMatchObject({ ok: true });
        const transitions = record<OrderTransitionRealtimeEvent>(customerSocket, TRANSITION_EVENT);

        await accept(order.orderId, master);

        const event = await transitions.next((payload) => payload.status === 'ACCEPTED');
        expect(event).toStrictEqual({
          orderId: order.orderId,
          status: 'ACCEPTED',
          masterId: master.masterId,
          priceMinor: 6700,
          at: expect.any(Number) as number,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'tells nobody outside the order, even when they are on one of their own',
      async () => {
        const master = await seedMaster();
        const order = await seedOrder();
        const stranger = await seedOrder();

        const strangerSocket = await dial(stranger.accessToken);
        // Refused, as #167 requires — and then asserted by silence, because a
        // refusal that returned the right code and joined anyway would pass a
        // code-only check and leak everything published afterwards.
        expect(
          await ask(strangerSocket, 'room:join', { kind: 'order', orderId: order.orderId }),
        ).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });

        const customerSocket = await dial(order.accessToken);
        expect(
          await ask(customerSocket, 'room:join', { kind: 'order', orderId: order.orderId }),
        ).toMatchObject({ ok: true });

        const mine = record<OrderTransitionRealtimeEvent>(customerSocket, TRANSITION_EVENT);
        const theirs = record<OrderTransitionRealtimeEvent>(strangerSocket, TRANSITION_EVENT);

        await accept(order.orderId, master);
        await mine.next((payload) => payload.status === 'ACCEPTED');

        expect(await theirs.quiet((payload) => payload.orderId === order.orderId)).toStrictEqual(
          [],
        );
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('every EPIC 8 transition reaches the order room', () => {
    it(
      'publishes an advance to the other party, and not to the master who drove it',
      async () => {
        const { order, master, customerSocket, masterSocket } = await acceptedOrder();
        const toCustomer = record<OrderTransitionRealtimeEvent>(customerSocket, TRANSITION_EVENT);
        const toMaster = record<OrderTransitionRealtimeEvent>(masterSocket, TRANSITION_EVENT);

        expect(
          (await transition(order.orderId, 'MASTER_ON_THE_WAY', master.accessToken)).status,
        ).toBe(200);

        const event = await toCustomer.next();
        expect(event).toMatchObject({
          orderId: order.orderId,
          status: 'MASTER_ON_THE_WAY',
          masterId: master.masterId,
        });
        // The actor is told by their own HTTP response (#144's rule, on the
        // socket). A frame racing that response is how a client applies its own
        // change twice.
        expect(await toMaster.quiet()).toStrictEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'publishes a customer cancellation to the assigned master',
      async () => {
        const { order, customerSocket, masterSocket } = await acceptedOrder();
        const toMaster = record<OrderTransitionRealtimeEvent>(masterSocket, TRANSITION_EVENT);
        const toCustomer = record<OrderTransitionRealtimeEvent>(customerSocket, TRANSITION_EVENT);

        expect((await transition(order.orderId, 'CANCELLED', order.accessToken)).status).toBe(200);

        expect(await toMaster.next()).toMatchObject({
          orderId: order.orderId,
          status: 'CANCELLED',
        });
        expect(await toCustomer.quiet()).toStrictEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'publishes a re-dispatch to the customer, with the master and the price cleared',
      async () => {
        const { order, master, customerSocket } = await acceptedOrder();
        const toCustomer = record<OrderTransitionRealtimeEvent>(customerSocket, TRANSITION_EVENT);

        expect((await transition(order.orderId, 'SEARCHING', master.accessToken)).status).toBe(200);

        // The committed row, not the target asked for: a re-dispatch clears
        // `master_id` and `price_minor` together (ADR-0013), and the customer's
        // screen has to stop naming a master who is no longer on the job.
        expect(await toCustomer.next()).toMatchObject({
          orderId: order.orderId,
          status: 'SEARCHING',
          masterId: null,
          priceMinor: null,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'publishes an admin override to both parties, because an admin is neither',
      async () => {
        const { order, customerSocket, masterSocket } = await acceptedOrder();
        const toCustomer = record<OrderTransitionRealtimeEvent>(customerSocket, TRANSITION_EVENT);
        const toMaster = record<OrderTransitionRealtimeEvent>(masterSocket, TRANSITION_EVENT);

        const created = await adminRepository.createAdmin({
          email: `admin-${randomUUID()}@tezusta.az`,
          displayName: 'Test Admin',
          roles: ['super_admin'],
        });
        const session = await adminSessions.start(created.id);

        const overridden = await post(
          `/admin/orders/${order.orderId}/transitions`,
          session.accessToken,
        ).send({ to: 'CANCELLED', reason: 'Müştəri telefonla ləğv etdi' });
        expect(overridden.status).toBe(200);

        expect(await toCustomer.next()).toMatchObject({ status: 'CANCELLED' });
        expect(await toMaster.next()).toMatchObject({ status: 'CANCELLED' });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the payload itself', () => {
    it(
      'carries ids and changed fields only — no address, no phone number',
      async () => {
        const { order, master, customerSocket } = await acceptedOrder();
        const transitions = record<OrderTransitionRealtimeEvent>(customerSocket, TRANSITION_EVENT);

        await transition(order.orderId, 'MASTER_ON_THE_WAY', master.accessToken);
        const event = await transitions.next();

        // Asserted as the whole key set rather than by naming the fields that
        // must be absent: a field added later is caught by this even though
        // nobody thought to forbid it by name.
        expect(Object.keys(event).sort()).toStrictEqual([
          'at',
          'masterId',
          'orderId',
          'priceMinor',
          'status',
        ]);
        expect(JSON.stringify(event)).not.toContain('Nizami');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'stamps two events for one order with increasing values',
      async () => {
        const { order, master, customerSocket } = await acceptedOrder();
        const transitions = record<OrderTransitionRealtimeEvent>(customerSocket, TRANSITION_EVENT);

        await transition(order.orderId, 'MASTER_ON_THE_WAY', master.accessToken);
        await transitions.next((payload) => payload.status === 'MASTER_ON_THE_WAY');
        await transition(order.orderId, 'MASTER_ARRIVED', master.accessToken);
        await transitions.next((payload) => payload.status === 'MASTER_ARRIVED');

        const stamps = transitions.all().map((payload) => payload.at);
        expect(stamps).toHaveLength(2);
        expect(stamps[1]).toBeGreaterThan(stamps[0] ?? 0);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('a publish that fails does not fail the transition', () => {
    it(
      'commits the order and answers 200 with a throwing socket server',
      async () => {
        const { order, master } = await acceptedOrder();

        vi.spyOn(gateway.server, 'to').mockImplementation(() => {
          throw new Error('the socket server is having a bad minute');
        });

        const response = await transition(order.orderId, 'MASTER_ON_THE_WAY', master.accessToken);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: 'MASTER_ON_THE_WAY' });
        const { rows } = await pool.query<{ status: string }>(
          'select status from orders where id = $1',
          [order.orderId],
        );
        expect(rows[0]?.status).toBe('MASTER_ON_THE_WAY');
      },
      TEST_TIMEOUT_MS,
    );
  });
});
