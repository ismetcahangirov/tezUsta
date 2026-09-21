import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { PUSH_SENDER } from '../src/infra/push/push-sender.types';
import type { StubPushSender } from '../src/infra/push/stub-push-sender';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { CustomersService } from '../src/modules/customers/customers.service';
import { DevicesService } from '../src/modules/devices/devices.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Order and dispatch events raising notifications, end to end (issue #144).
 *
 * The whole chain as it ships: a real order, a real broadcast from the live
 * dispatch engine, a real accept through the offer it wrote, the real
 * transition endpoint, the real queue and the real worker. Only the network
 * stops, at `StubPushSender`.
 *
 * **What only this layer can prove** is the recipient set. Every requirement
 * in the issue is a statement about *who was told* — the accepting master is
 * not told about their own accept, an admin is not told about their own
 * override, a cancellation with no master assigned tells nobody — and a unit
 * test over the planner asserts the rule while this asserts that the rule is
 * the one actually wired to each of the seven events.
 *
 * The give-up path is its own file, because it needs a dispatch timeout short
 * enough to fire inside a test and this one needs it long enough never to.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99450${String(phoneCounter).padStart(7, '0')}`;
}

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `ExponentPushToken[${String(tokenCounter).padStart(22, 'e')}]`;
}

/** Baku. Every seeded order's address, and where every seeded master stands. */
const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DEFAULT_DISTANCE_M = 1200;
const MASTER_PRICE_MINOR = 6700;
const STREET = 'Nizami küçəsi 203';
const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';

interface Person {
  readonly userId: string;
  readonly accessToken: string;
  readonly pushToken: string;
}

interface SeededMaster extends Person {
  readonly masterId: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly customer: Person;
}

/** One push as this suite cares about it: who got it, and what about. */
interface Received {
  readonly pushToken: string;
  readonly kind: string;
  readonly orderId: string | undefined;
}

describe('order and dispatch events raise notifications (issue #144)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let devices: DevicesService;
  let customers: CustomersService;
  let adminRepository: AdminRepository;
  let adminSessions: AdminSessionService;
  let push: StubPushSender;
  let serviceId: string;
  let admin: { adminUserId: string; accessToken: string };

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

  /** Polls rather than sleeping — see `notifications.e2e.test.ts` on why. */
  async function eventually(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) {
        throw new Error(
          `Condition was still false after ${String(timeoutMs)}ms. Sent so far: ${JSON.stringify(
            received(),
          )}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function received(): Received[] {
    return push.sent.map((envelope) => ({
      pushToken: envelope.pushToken,
      kind: String(envelope.data.kind),
      orderId: envelope.data.orderId === undefined ? undefined : String(envelope.data.orderId),
    }));
  }

  /** Every notification for one order, so a stray one cannot pad an assertion. */
  function forOrder(orderId: string): Received[] {
    return received().filter((one) => one.orderId === orderId);
  }

  async function signIn(): Promise<Person> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    const pushToken = nextToken();
    await devices.register(
      { userId: created.user.id, sessionId: randomUUID(), roles: [], status: 'active' },
      { expoPushToken: pushToken, platform: 'android' },
    );
    return { userId: created.user.id, accessToken: pair.accessToken, pushToken };
  }

  /** A master eligible on every term the accept path re-checks. */
  async function seedMaster(): Promise<SeededMaster> {
    const caller = await signIn();
    const created = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;

    await pool.query(
      `update masters
          set verification_status = 'active', is_available = true, commission_debt_minor = 0
        where id = $1`,
      [masterId],
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, $3, true)`,
      [masterId, serviceId, MASTER_PRICE_MINOR],
    );
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values (
         $1, $2,
         ST_Project(
           ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
           $5::double precision,
           radians(90)
         )::geometry,
         now()
       )`,
      [randomUUID(), masterId, SEARCH_POINT.longitude, SEARCH_POINT.latitude, DEFAULT_DISTANCE_M],
    );
    await presence.refresh(masterId);

    return { ...caller, masterId };
  }

  async function seedOrder(): Promise<SeededOrder> {
    const caller = await signIn();
    const profile = await post('/customers', caller.accessToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);

    const address = await post('/addresses', caller.accessToken).send({
      formattedAddress: STREET,
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);

    const order = await post('/orders', caller.accessToken).send({
      serviceId,
      addressId: (address.body as { id: string }).id,
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);

    return { orderId: (order.body as { id: string }).id, customer: caller };
  }

  /** The offer the live broadcast wrote for this master on this order. */
  async function offerFor(orderId: string, masterId: string): Promise<string> {
    let offerId: string | undefined;
    await eventually(async () => {
      const { rows } = await pool.query<{ id: string }>(
        `select id from order_offers where order_id = $1 and master_id = $2 and status = 'offered'`,
        [orderId, masterId],
      );
      offerId = rows[0]?.id;
      return offerId !== undefined;
    });
    if (offerId === undefined) {
      throw new Error('unreachable: eventually would have thrown');
    }
    return offerId;
  }

  /**
   * An order in `ACCEPTED`, through the real broadcast and the real accept.
   *
   * **It waits for the notifications its own setup raises**, and that is not
   * politeness — it is what makes every `push.reset()` after it mean
   * something. A raise is asynchronous by design: the request returns, the job
   * is queued, the worker sends later. A helper that returned as soon as the
   * HTTP call did would let its own offer and accept pushes land *after* the
   * test cleared the sender, and each would then be counted as a notification
   * the behaviour under test produced.
   */
  async function acceptedOrder(master: SeededMaster): Promise<SeededOrder> {
    const order = await seedOrder();
    const offerId = await offerFor(order.orderId, master.masterId);
    await eventually(() => forOrder(order.orderId).some((one) => one.kind === 'order-offer'));

    const accepted = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);
    await eventually(() => forOrder(order.orderId).some((one) => one.kind === 'order-accepted'));

    return order;
  }

  function advance(orderId: string, token: string, to: string, reason?: string) {
    return post(`/orders/${orderId}/transitions`, token).send(
      reason === undefined ? { to } : { to, reason },
    );
  }

  async function statusOf(orderId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      'select status from orders where id = $1',
      [orderId],
    );
    return rows[0]?.status ?? 'MISSING';
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('PRESENCE_TTL_SECONDS', '600');
    set('PRESENCE_HEARTBEAT_SECONDS', '300');
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', '600');

    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');

    /**
     * **The live engine broadcasts for real here**, unlike the transition
     * suites that configure it to reach nobody. The offer notification is one
     * of the seven events under test, so the wave that raises it has to be the
     * shipped one rather than a hand-written `order_offers` row.
     *
     * One wave, wide enough to reach a master 1200 m away, and a total timeout
     * no test lives long enough to hit — a give-up firing mid-suite would add
     * a `NO_MASTER_FOUND` to somebody else's assertions. The give-up event has
     * its own file for exactly that reason.
     */
    set('DISPATCH_INITIAL_RADIUS_M', '5000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '3600');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '3600');
    set('MAX_ORDER_REDISPATCHES', '3');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
    devices = app.get(DevicesService);
    customers = app.get(CustomersService);
    adminRepository = app.get(AdminRepository);
    adminSessions = app.get(AdminSessionService);
    push = app.get<StubPushSender>(PUSH_SENDER);

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;

    const created = await adminRepository.createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Test Admin',
    });
    const session = await adminSessions.start(created.id);
    admin = { adminUserId: created.id, accessToken: session.accessToken };
  }, 180_000);

  /**
   * **Masters do not leak between tests**, and without this they would.
   *
   * A master seeded by one test stays eligible for every broadcast after it,
   * so the next test's order would raise offer notifications to strangers and
   * every "and nobody else" assertion below would be asserting the wrong set.
   * Switching availability off is how a master stops being supply — the same
   * predicate dispatch itself reads — so each test's own masters are the only
   * ones its waves can reach.
   */
  beforeEach(async () => {
    await pool.query('update masters set is_available = false');
    push.reset();
  });

  afterEach(() => {
    push.reset();
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database?.drop();
  });

  it('is the stub sender under test, not a real transport', () => {
    expect(push.constructor.name).toBe('StubPushSender');
  });

  describe('a broadcast', () => {
    it('tells every master it reached, and nobody else', async () => {
      const first = await seedMaster();
      const second = await seedMaster();
      const order = await seedOrder();

      await eventually(() => forOrder(order.orderId).length >= 2);

      const offers = forOrder(order.orderId);
      expect(offers.map((one) => one.kind)).toEqual(['order-offer', 'order-offer']);
      expect(offers.map((one) => one.pushToken).sort()).toEqual(
        [first.pushToken, second.pushToken].sort(),
      );
      // The customer is told nothing about an order they just created.
      expect(offers.some((one) => one.pushToken === order.customer.pushToken)).toBe(false);
    });
  });

  describe('an accept', () => {
    it('tells the customer, and never the master who accepted', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      const offerId = await offerFor(order.orderId, master.masterId);
      // The broadcast's own push has to land before the sender is cleared, or
      // it arrives afterwards and is counted as the accept's doing.
      await eventually(() => forOrder(order.orderId).some((one) => one.kind === 'order-offer'));
      push.reset();

      await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send({}).expect(200);

      await eventually(() => forOrder(order.orderId).length >= 1);
      expect(forOrder(order.orderId)).toEqual([
        {
          pushToken: order.customer.pushToken,
          kind: 'order-accepted',
          orderId: order.orderId,
        },
      ]);
    });
  });

  describe('the master-driven walk', () => {
    it('tells the customer at each step, and the master at none of them', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      for (const to of ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
        push.reset();
        await advance(order.orderId, master.accessToken, to).expect(200);

        await eventually(() => forOrder(order.orderId).length >= 1);
        expect(forOrder(order.orderId)).toEqual([
          {
            pushToken: order.customer.pushToken,
            kind: 'order-status-changed',
            orderId: order.orderId,
          },
        ]);
      }

      expect(await statusOf(order.orderId)).toBe('COMPLETED');
    });
  });

  describe('a cancellation', () => {
    it('tells the assigned master, and not the customer who cancelled', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);
      push.reset();

      await advance(
        order.orderId,
        order.customer.accessToken,
        'CANCELLED',
        'Fikrimi dəyişdim',
      ).expect(200);

      await eventually(() => forOrder(order.orderId).length >= 1);
      expect(forOrder(order.orderId)).toEqual([
        { pushToken: master.pushToken, kind: 'order-cancelled', orderId: order.orderId },
      ]);
    });

    it('tells nobody when the order has no master yet', async () => {
      const order = await seedOrder();
      await eventually(async () => (await statusOf(order.orderId)) === 'SEARCHING');
      push.reset();

      await advance(
        order.orderId,
        order.customer.accessToken,
        'CANCELLED',
        'Özüm düzəltdim',
      ).expect(200);

      await eventually(async () => (await statusOf(order.orderId)) === 'CANCELLED');
      expect(forOrder(order.orderId)).toEqual([]);
    });
  });

  describe('a re-dispatch', () => {
    it('tells the customer, and offers the job to nobody it was taken from', async () => {
      const dropping = await seedMaster();
      const order = await acceptedOrder(dropping);
      push.reset();

      await advance(order.orderId, dropping.accessToken, 'SEARCHING', 'Maşınım xarab oldu').expect(
        200,
      );

      await eventually(() =>
        forOrder(order.orderId).some((one) => one.kind === 'order-redispatched'),
      );

      const told = forOrder(order.orderId);
      expect(told).toEqual([
        { pushToken: order.customer.pushToken, kind: 'order-redispatched', orderId: order.orderId },
      ]);
      // And specifically: the master who dropped it gets no fresh offer, which
      // `order_offers` already guarantees by never re-offering an accepted row.
      expect(told.some((one) => one.pushToken === dropping.pushToken)).toBe(false);
    });
  });

  describe('an admin override', () => {
    it('tells both parties and never the admin', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);
      push.reset();

      await post(`/admin/orders/${order.orderId}/transitions`, admin.accessToken)
        .send({ to: 'CANCELLED', reason: 'Müştəri dəstəyə zəng etdi' })
        .expect(200);

      await eventually(() => forOrder(order.orderId).length >= 2);

      const told = forOrder(order.orderId);
      expect(told.map((one) => one.kind)).toEqual(['order-cancelled', 'order-cancelled']);
      expect(told.map((one) => one.pushToken).sort()).toEqual(
        [order.customer.pushToken, master.pushToken].sort(),
      );
    });
  });

  describe('what a notification is allowed to carry', () => {
    it('never carries an address, a phone number or a coordinate', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);
      await advance(order.orderId, master.accessToken, 'MASTER_ON_THE_WAY').expect(200);

      await eventually(() => forOrder(order.orderId).length >= 1);

      const everything = JSON.stringify(push.sent);
      expect(everything).not.toContain(STREET);
      expect(everything).not.toContain(DESCRIPTION);
      expect(everything).not.toContain(String(SEARCH_POINT.latitude));
      expect(everything).not.toContain(String(SEARCH_POINT.longitude));
      expect(everything).not.toContain('+994');
    });
  });

  describe('a notification may never cost a transition', () => {
    /**
     * The bug this issue most easily ships, forced rather than argued. A
     * trigger makes the trail insert fail, so the `UPDATE orders` that was
     * already staged is rolled back with it — exactly the shape of "the
     * database changed its mind" that an enqueue inside the transaction would
     * have already told a customer about.
     */
    it('sends nothing for a transition that rolled back', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);
      push.reset();

      await pool.query(`
        create or replace function tezusta_test_block_trail() returns trigger as $$
        begin raise exception 'blocked by test'; end;
        $$ language plpgsql;
      `);
      await pool.query(`
        create trigger tezusta_test_block_trail
        before insert on order_status_history
        for each row execute function tezusta_test_block_trail();
      `);

      try {
        const refused = await advance(order.orderId, master.accessToken, 'MASTER_ON_THE_WAY');
        expect(refused.status).toBe(500);
      } finally {
        await pool.query('drop trigger tezusta_test_block_trail on order_status_history');
      }

      expect(await statusOf(order.orderId)).toBe('ACCEPTED');
      expect(forOrder(order.orderId)).toEqual([]);
    });

    /**
     * The converse, and the requirement that a raise failing must not
     * propagate. The resolution the raiser does is made to throw; the
     * transition must still answer 200 and still be committed.
     */
    it('commits the transition even when raising the notification throws', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);
      push.reset();

      const original = customers.findUserId.bind(customers);
      customers.findUserId = () => {
        throw new Error('the notification raiser is having a bad second');
      };

      try {
        await advance(order.orderId, master.accessToken, 'MASTER_ON_THE_WAY').expect(200);
      } finally {
        customers.findUserId = original;
      }

      expect(await statusOf(order.orderId)).toBe('MASTER_ON_THE_WAY');
      expect(forOrder(order.orderId)).toEqual([]);
    });
  });
});
