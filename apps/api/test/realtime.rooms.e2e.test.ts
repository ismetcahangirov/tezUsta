import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { RealtimeGateway } from '../src/modules/realtime/realtime.gateway';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Who may hear what, over a real socket against a real Postgres (issue #167).
 *
 * #166 proved only authenticated callers hold a connection. This file is about
 * the next question, and it is the one where a mistake is a privacy incident
 * rather than a missing feature: without a per-join authorization check, the
 * socket is a read API for every order in the system, including live home
 * addresses and a master's position.
 *
 * **Every negative case is asserted by the absence of a delivery, not only by
 * an error code.** A refusal that returns the right code and joins the room
 * anyway passes a code-only test and leaks everything — so each refusal below
 * is followed by a publish into the room the client asked for, and the
 * assertion is that nothing arrived.
 *
 * **The live dispatch engine is not incidental.** "The currently assigned
 * master" only exists once a real master has really accepted a really
 * broadcast order, and the transition that takes it away from them is the one
 * the eviction test needs. The dispatch parameters are turned right down the
 * way `order-conversation.e2e.test.ts` turns them down.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99458${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };

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

interface RoomAck {
  readonly ok: boolean;
  readonly room?: string;
  readonly code?: string;
  readonly message?: string;
}

interface SeededMaster {
  readonly masterId: string;
  readonly accessToken: string;
}

describe('realtime rooms: who may hear what (issue #167)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let gateway: RealtimeGateway;
  let serviceId: string;
  let url: string;

  const opened: Socket[] = [];
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

  /** Dials and resolves once connected. Every socket here is expected to hold. */
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
      }, 10_000);
      socket.emit(event, payload, (ack: RoomAck) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  /**
   * Publishes a probe into a room and reports whether this socket heard it.
   *
   * The publish goes through the gateway's own `server`, which is what #168
   * will use — so "was this client in the room" is answered by the same
   * mechanism that will later carry real events, not by inspecting internals.
   *
   * The wait is bounded rather than raced against a single tick: with the
   * Redis adapter a publish is a round trip, and a test that gave it one
   * microtask would report "did not hear it" for a delivery that was merely
   * slower than the assertion.
   */
  async function hears(socket: Socket, room: string): Promise<boolean> {
    const probe = randomUUID();
    const heard = new Promise<boolean>((resolve) => {
      // `on` with an explicit `off`, never `once`. Two sockets in one room
      // both receive the *previous* test's probe, and the assertion on the
      // first of them resolves as soon as it arrives there — which can be
      // before the second socket has processed the same frame. A `once`
      // listener registered in between is then consumed by that stale probe
      // and the real one lands with nobody listening, so the test reports "did
      // not hear it" about a delivery that worked. Matching on the id and
      // leaving the listener attached until this resolves is what makes the
      // check about membership rather than about arrival order.
      const onProbe = (received: string): void => {
        if (received === probe) {
          finish(true);
        }
      };
      const timer = setTimeout(() => {
        finish(false);
      }, 600);

      function finish(value: boolean): void {
        clearTimeout(timer);
        socket.off('probe', onProbe);
        resolve(value);
      }

      socket.on('probe', onProbe);
    });

    gateway.server.to(room).emit('probe', probe);
    return heard;
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
       values ($1, $2,
         ST_Project(ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 400, radians(90))::geometry,
         now())`,
      [randomUUID(), masterId, SEARCH_POINT.longitude, SEARCH_POINT.latitude],
    );
    await presence.refresh(masterId);

    seededMasterIds.push(masterId);
    return { masterId, accessToken: caller.accessToken };
  }

  async function seedOrder(): Promise<{ orderId: string; customerToken: string }> {
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

    return { orderId: (order.body as { id: string }).id, customerToken: caller.accessToken };
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
    expect(offer).toBeDefined();
    const accepted = await post(
      `/masters/me/offers/${offer?.id ?? ''}/accept`,
      master.accessToken,
    ).send({});
    expect(accepted.status).toBe(200);
  }

  async function acceptedOrder(): Promise<{
    orderId: string;
    customerToken: string;
    master: SeededMaster;
  }> {
    const master = await seedMaster();
    const order = await seedOrder();
    await accept(order.orderId, master);
    return { ...order, master };
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

    // The inbound budget is the subject of exactly one test below, and an
    // obstacle to every other one. Small enough to exhaust deliberately in a
    // handful of frames, large enough that no other test in the file gets
    // near it — and a burst equal to the rate, so the bucket cannot hide a
    // refusal behind a reservoir.
    set('REALTIME_INBOUND_MESSAGES_PER_SECOND', '4');
    set('REALTIME_INBOUND_BURST', '4');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Nest's `TestingLogger` swallows `warn`, which is where a refusal's
      // reason is recorded.
      .setLogger(new ConsoleLogger())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // The adapter `main.ts` installs. Without it every assertion here would run
    // against the in-memory adapter, a combination that never ships — and the
    // eviction path in particular is about `fetchSockets()`, which is the
    // cluster adapter's.
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);
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
    while (opened.length > 0) {
      opened.pop()?.disconnect();
    }
    // Masters accumulate and every broadcast reaches only the nearest few, so
    // one left available crowds out the fresh master the next test waits for.
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

  describe('the parties to an order may listen to it', () => {
    it('admits the customer and the assigned master, and both receive what is published', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();

      const customerSocket = await dial(customerToken);
      const masterSocket = await dial(master.accessToken);

      const asCustomer = await ask(customerSocket, 'room:join', { kind: 'order', orderId });
      const asMaster = await ask(masterSocket, 'room:join', { kind: 'order', orderId });

      expect(asCustomer).toMatchObject({ ok: true, room: `order:${orderId}` });
      expect(asMaster).toMatchObject({ ok: true, room: `order:${orderId}` });

      expect(await hears(customerSocket, `order:${orderId}`)).toBe(true);
      expect(await hears(masterSocket, `order:${orderId}`)).toBe(true);
    });

    it('admits a master to their own room', async () => {
      const master = await seedMaster();
      const socket = await dial(master.accessToken);

      const ack = await ask(socket, 'room:join', { kind: 'master', masterId: master.masterId });

      expect(ack).toMatchObject({ ok: true, room: `master:${master.masterId}` });
      expect(await hears(socket, `master:${master.masterId}`)).toBe(true);
    });

    it('lets a party stop listening', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const socket = await dial(customerToken);

      expect(await ask(socket, 'room:join', { kind: 'order', orderId })).toMatchObject({
        ok: true,
      });
      expect(await ask(socket, 'room:leave', { kind: 'order', orderId })).toMatchObject({
        ok: true,
      });

      expect(await hears(socket, `order:${orderId}`)).toBe(false);
    });
  });

  describe('everybody else is refused, and receives nothing', () => {
    it('refuses another customer, who then hears nothing published to the room', async () => {
      const { orderId } = await acceptedOrder();
      const stranger = await seedOrder();
      const socket = await dial(stranger.customerToken);

      const ack = await ask(socket, 'room:join', { kind: 'order', orderId });

      expect(ack).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });
      expect(await hears(socket, `order:${orderId}`)).toBe(false);
    });

    it('refuses a master who was never assigned to the order', async () => {
      const { orderId } = await acceptedOrder();
      const outsider = await seedMaster();
      const socket = await dial(outsider.accessToken);

      const ack = await ask(socket, 'room:join', { kind: 'order', orderId });

      expect(ack).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });
      expect(await hears(socket, `order:${orderId}`)).toBe(false);
    });

    it('refuses an order that is still searching, which has no assigned master yet', async () => {
      const order = await seedOrder();
      const outsider = await seedMaster();
      const socket = await dial(outsider.accessToken);

      const ack = await ask(socket, 'room:join', { kind: 'order', orderId: order.orderId });

      expect(ack).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });
      expect(await hears(socket, `order:${order.orderId}`)).toBe(false);
    });

    it('refuses an order that does not exist, with the code a foreign order gets', async () => {
      const caller = await signIn();
      const socket = await dial(caller.accessToken);
      const orderId = randomUUID();

      const ack = await ask(socket, 'room:join', { kind: 'order', orderId });

      // Identical to the refusal above on purpose: a client that could tell
      // the two apart would hold an existence oracle over every order id.
      expect(ack).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });
      expect(await hears(socket, `order:${orderId}`)).toBe(false);
    });

    it("refuses one account the other master's own room", async () => {
      const mine = await seedMaster();
      const theirs = await seedMaster();
      const socket = await dial(mine.accessToken);

      const ack = await ask(socket, 'room:join', { kind: 'master', masterId: theirs.masterId });

      expect(ack).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });
      expect(await hears(socket, `master:${theirs.masterId}`)).toBe(false);
    });

    it('refuses an account with no master profile at all', async () => {
      const caller = await signIn();
      const socket = await dial(caller.accessToken);
      const masterId = randomUUID();

      const ack = await ask(socket, 'room:join', { kind: 'master', masterId });

      expect(ack).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });
      expect(await hears(socket, `master:${masterId}`)).toBe(false);
    });

    it('refuses an order that has ended', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const socket = await dial(customerToken);

      const cancelled = await post(`/orders/${orderId}/transitions`, customerToken).send({
        to: 'CANCELLED',
        reason: 'Planlarım dəyişdi.',
      });
      expect(cancelled.status).toBe(200);

      const ack = await ask(socket, 'room:join', { kind: 'order', orderId });

      expect(ack).toMatchObject({ ok: false, code: 'ROOM_FORBIDDEN' });
      expect(await hears(socket, `order:${orderId}`)).toBe(false);
    });
  });

  describe('losing the right removes you, without a reconnect', () => {
    it('drops the assigned master from the room when they re-dispatch the order', async () => {
      const { orderId, master } = await acceptedOrder();
      const socket = await dial(master.accessToken);

      expect(await ask(socket, 'room:join', { kind: 'order', orderId })).toMatchObject({
        ok: true,
      });
      expect(await hears(socket, `order:${orderId}`)).toBe(true);

      const redispatched = await post(`/orders/${orderId}/transitions`, master.accessToken).send({
        to: 'SEARCHING',
        reason: 'Maşınım xarab oldu, gedə bilmirəm.',
      });
      expect(redispatched.status).toBe(200);

      // Same socket, never reconnected. The connection is still authenticated
      // and still open — what changed is the row it was authorized against.
      expect(socket.connected).toBe(true);
      expect(await hears(socket, `order:${orderId}`)).toBe(false);
    });

    it('drops the customer too once the order reaches a terminal status', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const socket = await dial(customerToken);

      expect(await ask(socket, 'room:join', { kind: 'order', orderId })).toMatchObject({
        ok: true,
      });
      expect(await hears(socket, `order:${orderId}`)).toBe(true);

      const cancelled = await post(`/orders/${orderId}/transitions`, customerToken).send({
        to: 'CANCELLED',
        reason: 'Planlarım dəyişdi.',
      });
      expect(cancelled.status).toBe(200);

      expect(socket.connected).toBe(true);
      expect(await hears(socket, `order:${orderId}`)).toBe(false);
    });
  });

  describe('an inbound message is untrusted input', () => {
    it('refuses a payload that names no known room shape, and keeps the socket up', async () => {
      const caller = await signIn();
      const socket = await dial(caller.accessToken);

      expect(await ask(socket, 'room:join', { kind: 'geohash', cell: 'ud8p' })).toMatchObject({
        ok: false,
        code: 'ROOM_INVALID',
      });
      expect(socket.connected).toBe(true);
    });

    it.each([
      ['a non-uuid order id', { kind: 'order', orderId: 'not-a-uuid' }],
      ['a missing id', { kind: 'order' }],
      ['an extra key', { kind: 'master', masterId: randomUUID(), orderId: randomUUID() }],
      ['a string instead of an object', 'order:everything'],
      ['null', null],
    ])('refuses %s', async (_label, payload) => {
      const caller = await signIn();
      const socket = await dial(caller.accessToken);

      expect(await ask(socket, 'room:join', payload)).toMatchObject({
        ok: false,
        code: 'ROOM_INVALID',
      });
      expect(socket.connected).toBe(true);
    });

    it('throttles a flood rather than serving it, and the socket survives', async () => {
      const caller = await signIn();
      const socket = await dial(caller.accessToken);
      const orderId = randomUUID();

      // Twice the burst, sent without pause. The bucket refills at four a
      // second, so the second half cannot be covered by refill either.
      const acks: RoomAck[] = [];
      for (let index = 0; index < 8; index += 1) {
        acks.push(await ask(socket, 'room:join', { kind: 'order', orderId }));
      }

      expect(acks.some((ack) => ack.code === 'RATE_LIMITED')).toBe(true);
      // Throttled, not disconnected: this connection may be carrying a live
      // order, and closing it would turn a rejected frame into a lost job.
      expect(socket.connected).toBe(true);
    });
  });
});
