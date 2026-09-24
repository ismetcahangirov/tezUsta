import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Order } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `POST /admin/orders/:orderId/transitions` over real HTTP (issue #137).
 *
 * **The one rule this suite exists to hold down**, from
 * `backend-architecture.md` § Admin override: *"An admin may perform a
 * transition the table permits even though they are neither the customer nor
 * the assigned master. An admin may not perform a transition the table does
 * not contain, and there is no code path that lets them."* Half of that is
 * easy to test and easy to get right; the other half is the one an override
 * endpoint tends to lose, so the rejections below name several different
 * non-edges rather than one.
 *
 * **Side effects follow the target, not the actor**, which is the second
 * thing asserted here at length: an admin-driven `SEARCHING` performs the
 * whole re-dispatch transaction, and an admin-driven terminal status closes
 * the order's offers. Both go through `OrdersService`, the same service the
 * customer and master surfaces use — a second implementation of "advance an
 * order" would be a second place for the trail row to be forgotten.
 *
 * **On TOTP.** The acceptance criteria ask that an admin token cannot reach
 * this route without a second factor. There is no second factor in the system
 * to assert against: ADR-0014 puts admin credential issuance — email,
 * password, mandatory TOTP, the sign-in form — in EPIC 13, and until it lands
 * a session exists only because a provisioning script or a test opened one
 * (`admin-session.service.ts`). What is asserted instead is everything that
 * does exist and that the TOTP gate will sit behind: no token, a consumer
 * token of either role, and a session that has been revoked. The route is
 * `/admin`-prefixed, so it inherits that gate the day it is built, with no
 * change here.
 *
 * The `/admin` surface being guarded by its **path** rather than by a
 * decorator is `admin-verification.e2e.test.ts`'s: it walks the live route
 * table and asserts every registered `/admin` route refuses a consumer token,
 * so this route is covered there the moment it is registered.
 */

/** `users.phone_e164` is unique among live rows. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99459${String(phoneCounter).padStart(7, '0')}`;
}

/** Baku. Every seeded order's address, and where every seeded master stands. */
const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DEFAULT_DISTANCE_M = 1200;
const ROUND_RADIUS_M = 3000;
const MASTER_PRICE_MINOR = 6700;
const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';
const REASON = 'Müştəri zəng etdi, sifariş ilişib qalıb.';

interface SeededMaster {
  readonly masterId: string;
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly customerToken: string;
  readonly customerUserId: string;
}

interface HistoryRow {
  readonly from_status: string;
  readonly to_status: string;
  readonly actor_kind: string;
  readonly actor_user_id: string | null;
  readonly actor_admin_id: string | null;
  readonly reason: string | null;
}

interface AuditRow {
  readonly admin_user_id: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly reason: string | null;
}

interface OrderRowShape {
  readonly status: string;
  readonly master_id: string | null;
  readonly price_minor: string | null;
  readonly accepted_at: Date | null;
  readonly redispatch_count: number;
}

describe('an admin overriding an order’s status (issue #137)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let adminRepository: AdminRepository;
  let adminSessions: AdminSessionService;
  let serviceId: string;
  let admin: { adminUserId: string; accessToken: string; sessionId: string };

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

  async function newAdmin(): Promise<{
    adminUserId: string;
    accessToken: string;
    sessionId: string;
  }> {
    const created = await adminRepository.createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Test Admin',
      roles: ['super_admin'],
    });
    const session = await adminSessions.start(created.id);
    return {
      adminUserId: created.id,
      accessToken: session.accessToken,
      sessionId: session.sessionId,
    };
  }

  async function signIn(): Promise<{ userId: string; accessToken: string }> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
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

    return { masterId, userId: caller.userId, accessToken: caller.accessToken };
  }

  /** A real customer, a real address at the job site, and a real `SEARCHING` order. */
  async function seedOrder(): Promise<SeededOrder> {
    const caller = await signIn();
    const profile = await post('/customers', caller.accessToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);

    const address = await post('/addresses', caller.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
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

    return {
      orderId: (order.body as { id: string }).id,
      customerToken: caller.accessToken,
      customerUserId: caller.userId,
    };
  }

  /** One live offer on an order, as a broadcast round would have written it. */
  async function offerTo(orderId: string, master: SeededMaster): Promise<string> {
    const offerId = randomUUID();
    await pool.query(
      `insert into order_offers
         (id, order_id, master_id, round, radius_m, distance_m, status, expires_at)
       values ($1, $2, $3, 1, $4, $5, 'offered', now() + make_interval(secs => 300))`,
      [offerId, orderId, master.masterId, ROUND_RADIUS_M, DEFAULT_DISTANCE_M],
    );
    return offerId;
  }

  /** An order in `ACCEPTED`, reached through the real accept path. */
  async function acceptedOrder(master: SeededMaster): Promise<SeededOrder> {
    const order = await seedOrder();
    const offerId = await offerTo(order.orderId, master);

    const accepted = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);

    return order;
  }

  /**
   * `reason: null` means "send no reason at all", which is not the same as
   * leaving the argument off — a default parameter fires on `undefined`.
   */
  function override(
    orderId: string,
    to: string,
    token: string | undefined = admin.accessToken,
    reason: string | null = REASON,
  ) {
    return post(`/admin/orders/${orderId}/transitions`, token).send(
      reason === null ? { to } : { to, reason },
    );
  }

  async function orderRow(orderId: string): Promise<OrderRowShape> {
    const { rows } = await pool.query<OrderRowShape>(
      `select status, master_id::text as master_id, price_minor::text as price_minor,
              accepted_at, redispatch_count
         from orders where id = $1`,
      [orderId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('No such order');
    }
    return row;
  }

  async function history(orderId: string): Promise<HistoryRow[]> {
    const { rows } = await pool.query<HistoryRow>(
      `select from_status, to_status, actor_kind,
              actor_user_id::text as actor_user_id, actor_admin_id::text as actor_admin_id, reason
         from order_status_history
        where order_id = $1
        order by created_at, id`,
      [orderId],
    );
    return rows;
  }

  async function auditFor(orderId: string): Promise<AuditRow[]> {
    const { rows } = await pool.query<AuditRow>(
      `select admin_user_id::text as admin_user_id, action,
              target_type, target_id::text as target_id, reason
         from admin_audit_log
        where target_id = $1
        order by created_at, id`,
      [orderId],
    );
    return rows;
  }

  async function offerStatuses(orderId: string): Promise<string[]> {
    const { rows } = await pool.query<{ status: string }>(
      'select status from order_offers where order_id = $1 order by created_at',
      [orderId],
    );
    return rows.map((row) => row.status);
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('PRESENCE_TTL_SECONDS', '30');
    set('PRESENCE_HEARTBEAT_SECONDS', '10');
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', '120');

    // Budgets are somebody else's subject; here they are only an obstacle.
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');

    // The live engine reaches nobody, the way `order-transitions.e2e.test.ts`
    // does it: this suite writes its own `order_offers` row per order, and a
    // broadcast into the same table would collide on
    // `order_offers_order_master_unique`.
    set('DISPATCH_INITIAL_RADIUS_M', '1');
    set('DISPATCH_RADIUS_STEP_SECONDS', '3600');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '3600');
    set('MAX_ORDER_REDISPATCHES', '2');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
    adminRepository = app.get(AdminRepository);
    adminSessions = app.get(AdminSessionService);

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;

    admin = await newAdmin();
  }, 120_000);

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

  describe('every edge the table contains, on an order that is none of their business', () => {
    it('drives a master’s edge without being the master', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      const response = await override(order.orderId, 'MASTER_ON_THE_WAY');

      expect(response.status).toBe(200);
      expect((response.body as Order).status).toBe('MASTER_ON_THE_WAY');
      expect((await orderRow(order.orderId)).status).toBe('MASTER_ON_THE_WAY');
    }, 30_000);

    it('drives a customer’s edge without being the customer', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await override(order.orderId, 'CANCELLED')).status).toBe(200);
      expect((await orderRow(order.orderId)).status).toBe('CANCELLED');
    }, 30_000);

    it('closes a dispute, which no consumer surface can reach at all', async () => {
      // `DISPUTED -> RESOLVED` and `-> REFUNDED` carry an empty actor list in
      // the table: nobody but an admin may drive them, which is exactly the
      // kind of edge this endpoint exists for. Getting an order to `DISPUTED`
      // is itself an override here, because no client route offers it yet.
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      for (const to of ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
        expect((await override(order.orderId, to)).status).toBe(200);
      }

      expect((await override(order.orderId, 'DISPUTED')).status).toBe(200);
      expect((await override(order.orderId, 'RESOLVED')).status).toBe(200);
      expect((await orderRow(order.orderId)).status).toBe('RESOLVED');
    }, 30_000);

    // The edge exists (ADR-0015); the admin door to it is shut until EPIC 12
    // ships a refund mechanism (ADR-0043 § 5, #245). When that lands this test
    // goes back to expecting REFUNDED.
    it('refuses to refund a dispute until a refund mechanism exists', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      for (const to of ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
        expect((await override(order.orderId, to)).status).toBe(200);
      }
      expect((await override(order.orderId, 'DISPUTED')).status).toBe(200);

      const refund = await override(order.orderId, 'REFUNDED');
      expect(refund.status).toBe(409);
      expect((refund.body as ErrorEnvelope).error.code).toBe('REFUND_NOT_AVAILABLE');
      expect((await orderRow(order.orderId)).status).toBe('DISPUTED');
    }, 30_000);
  });

  describe('every edge the table does not contain', () => {
    it.each([
      ['ACCEPTED', 'IN_PROGRESS', 'a skipped step'],
      ['ACCEPTED', 'COMPLETED', 'a jump to the end'],
      ['ACCEPTED', 'PAID', 'a payment outcome on a job nobody has done'],
      ['ACCEPTED', 'RESOLVED', 'a dispute outcome on an order with no dispute'],
      ['ACCEPTED', 'NO_MASTER_FOUND', 'a supply outcome on an order that found one'],
    ])(
      'refuses %s -> %s (%s)',
      async (_from, to) => {
        const master = await seedMaster();
        const order = await acceptedOrder(master);

        const response = await override(order.orderId, to);

        // The actor check is bypassed; the edge check is not. An admin gets
        // exactly the answer anybody else would.
        expect(response.status).toBe(409);
        expect((response.body as ErrorEnvelope).error.code).toBe('ORDER_INVALID_TRANSITION');
        expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
      },
      30_000,
    );

    it('refuses to move an order that is already finished', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await override(order.orderId, 'CANCELLED')).status).toBe(200);

      const response = await override(order.orderId, 'SEARCHING');

      expect(response.status).toBe(409);
      expect((response.body as ErrorEnvelope).error.code).toBe('ORDER_INVALID_TRANSITION');
      expect((await orderRow(order.orderId)).status).toBe('CANCELLED');
    }, 30_000);

    it('refuses DRAFT as a target at the boundary', async () => {
      // No edge leads to `DRAFT`, and an admin who could set an order back to
      // the idempotency anchor of an in-flight creation could hide one.
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await override(order.orderId, 'DRAFT')).status).toBe(422);
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 30_000);
  });

  describe('the side effects follow the target, not the actor', () => {
    it('performs the whole re-dispatch transaction, cap included', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await override(order.orderId, 'SEARCHING')).status).toBe(200);

      const row = await orderRow(order.orderId);
      expect(row.status).toBe('SEARCHING');
      expect(row.master_id).toBeNull();
      expect(row.price_minor).toBeNull();
      expect(row.accepted_at).toBeNull();
      // Counted against `MAX_ORDER_REDISPATCHES` exactly as a master-driven
      // one is: an admin who wants a different outcome needs a different edge,
      // and a new edge needs an ADR.
      expect(row.redispatch_count).toBe(1);
    }, 30_000);

    it('closes the order’s live offers when it ends the order', async () => {
      const master = await seedMaster();
      const order = await seedOrder();
      await offerTo(order.orderId, master);

      expect(await offerStatuses(order.orderId)).toEqual(['offered']);

      expect((await override(order.orderId, 'CANCELLED')).status).toBe(200);

      expect(await offerStatuses(order.orderId)).toEqual(['expired']);
    }, 30_000);

    it('closes them for NO_MASTER_FOUND too, not only for a cancellation', async () => {
      // The close-out is keyed on the target being terminal rather than on it
      // being `CANCELLED`: an admin ending a stuck search leaves the same
      // contradiction behind if the offers stay live.
      const master = await seedMaster();
      const order = await seedOrder();
      await offerTo(order.orderId, master);

      expect((await override(order.orderId, 'NO_MASTER_FOUND')).status).toBe(200);

      expect((await orderRow(order.orderId)).status).toBe('NO_MASTER_FOUND');
      expect(await offerStatuses(order.orderId)).toEqual(['expired']);
    }, 30_000);
  });

  describe('what the override leaves behind', () => {
    it('names the admin on the order’s own trail, and no consumer', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await override(order.orderId, 'MASTER_ON_THE_WAY')).status).toBe(200);

      const row = (await history(order.orderId)).at(-1);
      expect(row?.from_status).toBe('ACCEPTED');
      expect(row?.to_status).toBe('MASTER_ON_THE_WAY');
      expect(row?.actor_kind).toBe('admin');
      expect(row?.actor_admin_id).toBe(admin.adminUserId);
      // `order_status_history_actor_shape` enforces the pairing, so this
      // assertion is about the service having picked the right column rather
      // than about the row being well-formed.
      expect(row?.actor_user_id).toBeNull();
      expect(row?.reason).toBe(REASON);
    }, 30_000);

    it('records the action in admin_audit_log, with the reason', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await override(order.orderId, 'MASTER_ON_THE_WAY')).status).toBe(200);

      // Not redundant with the trail row above: that answers "what happened to
      // this order", and this answers "what has this admin been doing", which
      // is the investigation view (`admin-flow.md`, non-negotiable 1).
      expect(await auditFor(order.orderId)).toEqual([
        {
          admin_user_id: admin.adminUserId,
          action: 'order.transition',
          target_type: 'order',
          target_id: order.orderId,
          reason: REASON,
        },
      ]);
    }, 30_000);

    it('writes no audit row for an override the table refused', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await override(order.orderId, 'IN_PROGRESS')).status).toBe(409);

      expect(await auditFor(order.orderId)).toEqual([]);
    }, 30_000);
  });

  describe('the reason', () => {
    it('refuses an override with none', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await override(order.orderId, 'MASTER_ON_THE_WAY', undefined, null)).status).toBe(
        422,
      );
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 30_000);

    it('refuses a blank one, which is the same as none', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect((await override(order.orderId, 'MASTER_ON_THE_WAY', undefined, '   ')).status).toBe(
        422,
      );
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 30_000);

    it('refuses one longer than the trail can hold', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      expect(
        (await override(order.orderId, 'MASTER_ON_THE_WAY', undefined, 'ə'.repeat(601))).status,
      ).toBe(422);
    }, 30_000);
  });

  describe('who may not reach it', () => {
    it('refuses a caller with no token', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      const response = await post(`/admin/orders/${order.orderId}/transitions`).send({
        to: 'MASTER_ON_THE_WAY',
        reason: REASON,
      });

      expect(response.status).toBe(401);
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 30_000);

    it('refuses the order’s own customer and its assigned master', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);

      // 401, not 403: a consumer token fails the admin token family's audience
      // check outright, so it is not a caller this surface recognises at all
      // (ADR-0014).
      expect((await override(order.orderId, 'CANCELLED', order.customerToken)).status).toBe(401);
      expect((await override(order.orderId, 'SEARCHING', master.accessToken)).status).toBe(401);
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 30_000);

    it('refuses an admin whose session has been revoked', async () => {
      const master = await seedMaster();
      const order = await acceptedOrder(master);
      const other = await newAdmin();

      await adminSessions.revoke(other.sessionId);

      // The closest thing to the TOTP assertion the acceptance criteria ask
      // for that this branch can make: the session, not the signature, is what
      // authorizes, and it is re-read from the database on every request.
      expect((await override(order.orderId, 'MASTER_ON_THE_WAY', other.accessToken)).status).toBe(
        401,
      );
      expect((await orderRow(order.orderId)).status).toBe('ACCEPTED');
    }, 30_000);

    it('answers 404 for an order id that does not exist', async () => {
      expect((await override(randomUUID(), 'CANCELLED')).status).toBe(404);
    }, 30_000);
  });
});
