import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Call, CallAcceptAck, CallActionAck, CallInviteAck } from '@tezusta/types';
import { Pool } from 'pg';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { PUSH_SENDER } from '../src/infra/push/push-sender.types';
import type { PushEnvelope } from '../src/infra/push/push-sender.types';
import type { StubPushSender } from '../src/infra/push/stub-push-sender';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { DevicesService } from '../src/modules/devices/devices.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { ServicesService } from '../src/modules/services/services.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * A ringing call wakes the callee's phone, and `GET /calls/:callId` is what
 * the phone confirms it against (issue #189, ADR-0039 § 4).
 *
 * End to end through the real socket invite, the real notifications queue and
 * the real worker, stopping at `StubPushSender` — so every assertion about the
 * push is an assertion about the envelope that would have left for Expo.
 *
 * **The late job is driven, not raced.** A ring job normally runs within
 * milliseconds of the invite, well before anybody could answer, so "the call
 * was answered before the push left" cannot be produced reliably by timing.
 * Instead the job is enqueued by hand, through the same `NotificationsService`
 * the invite uses, for a call that has already moved on — which is exactly
 * what a queue that fell behind would hand the worker. Each negative has a
 * positive twin enqueued the same way, so silence means "refused", not "never
 * ran".
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99457${String(phoneCounter).padStart(7, '0')}`;
}

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `ExponentPushToken[ring-${String(tokenCounter)}]`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
/** The floor `CALL_RING_TIMEOUT_SECONDS` accepts. */
const RING_TIMEOUT_SECONDS = 10;
const ARRIVAL_TIMEOUT_MS = 10_000;
/** Long enough for an enqueued job to have run, were it going to send. */
const SILENCE_MS = 2_000;
const TEST_TIMEOUT_MS = 60_000;

interface Person {
  readonly userId: string;
  readonly accessToken: string;
  readonly pushToken: string;
  readonly phone: string;
  readonly profileId: string;
}

interface LiveOrder {
  readonly orderId: string;
  readonly customer: Person;
  readonly master: Person;
  readonly customerSocket: Socket;
  readonly masterSocket: Socket;
}

describe('a ringing call raises a push to the callee (issue #189)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let push: StubPushSender;
  let serviceId: string;
  let serviceName: string;

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

  function getCall(callId: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).get(`/calls/${callId}`);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function eventually(condition: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
    while (!(await condition())) {
      if (Date.now() > deadline) {
        throw new Error(
          `Condition was still false; sent: ${JSON.stringify(push.sent.map((e) => [e.pushToken, e.data.kind]))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const silence = () => new Promise((resolve) => setTimeout(resolve, SILENCE_MS));

  /** The ring pushes addressed to one phone. */
  function ringsTo(pushToken: string, callId?: string): PushEnvelope[] {
    return push.sent.filter(
      (envelope) =>
        envelope.pushToken === pushToken &&
        envelope.data.kind === 'call-incoming' &&
        (callId === undefined || envelope.data.callId === callId),
    );
  }

  async function signIn(displayName: string, role: 'customers' | 'masters'): Promise<Person> {
    const phone = nextPhone();
    const created = await app.get(UsersRepository).create({ phoneE164: phone, roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    const pushToken = nextToken();
    await app
      .get(DevicesService)
      .register(
        { userId: created.user.id, sessionId: randomUUID(), roles: [], status: 'active' },
        { expoPushToken: pushToken, platform: 'android' },
      );
    const profile = await post(`/${role}`, pair.accessToken).send({ displayName });
    expect(profile.status).toBe(201);
    return {
      userId: created.user.id,
      accessToken: pair.accessToken,
      pushToken,
      phone,
      profileId: (profile.body as { id: string }).id,
    };
  }

  async function seedMaster(): Promise<Person> {
    const master = await signIn('Usta Anar', 'masters');
    await pool.query(
      `update masters set verification_status = 'active', is_available = true,
                          commission_debt_minor = 0
        where id = $1`,
      [master.profileId],
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, 6700, true)`,
      [master.profileId, serviceId],
    );
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), now())`,
      [randomUUID(), master.profileId, SEARCH_POINT.longitude, SEARCH_POINT.latitude],
    );
    await app.get(MasterPresenceService).refresh(master.profileId);
    seededMasterIds.push(master.profileId);
    return master;
  }

  async function dial(token: string): Promise<Socket> {
    const socket = io(await app.getUrl(), {
      transports: ['websocket'],
      reconnection: false,
      auth: { token },
    });
    opened.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    return socket;
  }

  function ask<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ack for ${event}`));
      }, ARRIVAL_TIMEOUT_MS);
      socket.emit(event, payload, (ack: T) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  /** An order a real master accepted, both parties' phones registered and sockets open. */
  async function liveOrder(): Promise<LiveOrder> {
    const master = await seedMaster();
    const customer = await signIn('Müştəri Leyla', 'customers');
    const address = await post('/addresses', customer.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: SEARCH_POINT.latitude,
      longitude: SEARCH_POINT.longitude,
    });
    expect(address.status).toBe(201);
    const order = await post('/orders', customer.accessToken).send({
      serviceId,
      addressId: (address.body as { id: string }).id,
      description: 'Mətbəxdə kran sızır.',
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);
    const orderId = (order.body as { id: string }).id;

    let offerId: string | undefined;
    await eventually(async () => {
      const { rows } = await pool.query<{ id: string }>(
        `select id from order_offers where order_id = $1 and master_id = $2 and status = 'offered'`,
        [orderId, master.profileId],
      );
      offerId = rows[0]?.id;
      return offerId !== undefined;
    });
    const accepted = await post(
      `/masters/me/offers/${offerId ?? ''}/accept`,
      master.accessToken,
    ).send({});
    expect(accepted.status).toBe(200);

    return {
      orderId,
      customer,
      master,
      customerSocket: await dial(customer.accessToken),
      masterSocket: await dial(master.accessToken),
    };
  }

  async function invite(socket: Socket, orderId: string): Promise<string> {
    const ack = await ask<CallInviteAck>(socket, 'call:invite', { orderId });
    if (!ack.ok) {
      throw new Error(`invite refused: ${ack.code}`);
    }
    expect(ack.call.status).toBe('RINGING');
    return ack.call.id;
  }

  const act = (socket: Socket, frame: string, callId: string) =>
    ask<CallActionAck>(socket, frame, { callId });

  /** A ring job exactly as the invite enqueues one — what a lagging queue would hand the worker. */
  function enqueueRing(live: LiveOrder, callId: string, to: Person, from: 'customer' | 'master') {
    return app.get(NotificationsService).notify({
      userId: to.userId,
      kind: 'call-incoming',
      orderId: live.orderId,
      callId,
      senderKind: from,
    });
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('PUSH_PROVIDER', 'stub');
    set('PRESENCE_TTL_SECONDS', '600');
    set('PRESENCE_HEARTBEAT_SECONDS', '300');
    set('DISPATCH_MAX_POSITION_AGE_SECONDS', '600');
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('DISPATCH_INITIAL_RADIUS_M', '5000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '3600');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '3600');
    set('CALLS_PROVIDER', 'stub');
    set('CALL_RING_TIMEOUT_SECONDS', String(RING_TIMEOUT_SECONDS));
    set('CALL_INVITE_RATE_LIMIT_PER_ORDER', '50');
    set('CALL_INVITE_RATE_LIMIT_WINDOW_SECONDS', '600');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .setLogger(new ConsoleLogger())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));
    await app.listen(0, '127.0.0.1');

    push = app.get<StubPushSender>(PUSH_SENDER);
    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
    serviceName = (await app.get(ServicesService).getServiceById(serviceId, ['az'])).name;
  }, 120_000);

  afterEach(async () => {
    push.outcomes.clear();
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

  describe('the push', () => {
    it(
      'rings the callee — never the caller — at once, naming the caller and the order',
      async () => {
        const live = await liveOrder();

        const callId = await invite(live.customerSocket, live.orderId);

        await eventually(() => ringsTo(live.master.pushToken, callId).length === 1);
        const [envelope] = ringsTo(live.master.pushToken, callId);
        expect(envelope).toMatchObject({
          title: 'Müştəri Leyla',
          channelId: 'calls',
          ttlSeconds: RING_TIMEOUT_SECONDS,
          sound: 'default',
        });
        expect(envelope?.body).toContain(serviceName);
        // Ids only: exactly the kind, the order and the call.
        expect(envelope?.data).toEqual({
          kind: 'call-incoming',
          orderId: live.orderId,
          callId,
        });

        await silence();
        expect(ringsTo(live.customer.pushToken)).toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'rings the customer when the master calls, the other way round',
      async () => {
        const live = await liveOrder();

        const callId = await invite(live.masterSocket, live.orderId);

        await eventually(() => ringsTo(live.customer.pushToken, callId).length === 1);
        expect(ringsTo(live.customer.pushToken, callId)[0]?.title).toBe('Usta Anar');
        await silence();
        expect(ringsTo(live.master.pushToken)).toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    /**
     * #189's security requirement, asserted on what actually left: no join
     * credential and no phone number anywhere in any ring envelope — title,
     * body or data. The credential is minted on accept, so the call is
     * answered and its tokens collected before the envelopes are searched.
     */
    it(
      'carries no token and no phone number',
      async () => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);
        await eventually(() => ringsTo(live.master.pushToken, callId).length === 1);

        const answered = await ask<CallAcceptAck>(live.masterSocket, 'call:accept', { callId });
        if (!answered.ok) {
          throw new Error(`accept refused: ${answered.code}`);
        }
        const joined = await post(`/calls/${callId}/join`, live.customer.accessToken).send({});
        expect(joined.status).toBe(200);
        const credentials = [answered.credential.token, (joined.body as { token: string }).token];

        const rings = push.sent.filter((envelope) => envelope.data.kind === 'call-incoming');
        expect(rings.length).toBeGreaterThan(0);
        for (const envelope of rings) {
          // The push token is the address, not the payload; everything else is.
          const payload = JSON.stringify({ ...envelope, pushToken: undefined });
          for (const token of credentials) {
            expect(token.length).toBeGreaterThan(0);
            expect(payload).not.toContain(token);
          }
          for (const phone of [live.customer.phone, live.master.phone]) {
            expect(payload).not.toContain(phone);
            expect(payload).not.toContain(phone.slice(1));
          }
          // What reaches the wire: an `undefined` member is dropped by JSON.
          expect(Object.keys(JSON.parse(JSON.stringify(envelope.data)) as object).sort()).toEqual([
            'callId',
            'kind',
            'orderId',
          ]);
        }
      },
      TEST_TIMEOUT_MS,
    );

    /**
     * Every other kind leaves as it did: the ring's expiry and sound are the
     * ring's alone. The order acceptance behind `liveOrder` pushed the
     * customer an `order-accepted`, which is the envelope checked.
     */
    it(
      'leaves every other kind without an expiry or a sound',
      async () => {
        const live = await liveOrder();
        await eventually(() =>
          push.sent.some(
            (envelope) =>
              envelope.pushToken === live.customer.pushToken &&
              envelope.data.kind === 'order-accepted',
          ),
        );

        const others = push.sent.filter((envelope) => envelope.data.kind !== 'call-incoming');
        expect(others.length).toBeGreaterThan(0);
        for (const envelope of others) {
          expect(envelope.ttlSeconds).toBeUndefined();
          expect(envelope.sound).toBeUndefined();
          expect(envelope.data).not.toHaveProperty('callId');
        }
      },
      TEST_TIMEOUT_MS,
    );
  });

  /**
   * "The server's state decides, not the payload." A ring job the worker
   * picks up after the call left `RINGING` sends nothing.
   */
  describe('a job that runs late', () => {
    it(
      'still rings a call that is still ringing — the twin that makes the silences below mean something',
      async () => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);
        await eventually(() => ringsTo(live.master.pushToken, callId).length === 1);

        await enqueueRing(live, callId, live.master, 'customer');

        await eventually(() => ringsTo(live.master.pushToken, callId).length === 2);
      },
      TEST_TIMEOUT_MS,
    );

    it.each([
      ['accepted', 'call:accept'],
      ['declined', 'call:reject'],
    ] as const)(
      'sends nothing for a call the callee %s',
      async (_outcome, frame) => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);
        await eventually(() => ringsTo(live.master.pushToken, callId).length === 1);
        expect((await act(live.masterSocket, frame, callId)).ok).toBe(true);

        await enqueueRing(live, callId, live.master, 'customer');

        await silence();
        expect(ringsTo(live.master.pushToken, callId)).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'sends nothing for a call the caller cancelled',
      async () => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);
        await eventually(() => ringsTo(live.master.pushToken, callId).length === 1);
        expect((await act(live.customerSocket, 'call:cancel', callId)).ok).toBe(true);

        await enqueueRing(live, callId, live.master, 'customer');

        await silence();
        expect(ringsTo(live.master.pushToken, callId)).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'sends nothing for a call that was answered and has ended',
      async () => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);
        await eventually(() => ringsTo(live.master.pushToken, callId).length === 1);
        expect((await ask<CallAcceptAck>(live.masterSocket, 'call:accept', { callId })).ok).toBe(
          true,
        );
        expect((await act(live.customerSocket, 'call:hangup', callId)).ok).toBe(true);

        await enqueueRing(live, callId, live.master, 'customer');

        await silence();
        expect(ringsTo(live.master.pushToken, callId)).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'sends nothing for a call that timed out, by the real ring-timeout job',
      async () => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);
        await eventually(() => ringsTo(live.master.pushToken, callId).length === 1);

        const deadline = Date.now() + (RING_TIMEOUT_SECONDS + 10) * 1_000;
        for (;;) {
          const { rows } = await pool.query<{ status: string }>(
            'select status from calls where id = $1',
            [callId],
          );
          if (rows[0]?.status === 'TIMED_OUT') {
            break;
          }
          if (Date.now() > deadline) {
            throw new Error('the ring timeout never fired');
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        await enqueueRing(live, callId, live.master, 'customer');

        await silence();
        expect(ringsTo(live.master.pushToken, callId)).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );

    /** A job naming the caller as the recipient of their own ring — ringing, but not *them*. */
    it(
      'sends nothing to anybody but the callee, even while it rings',
      async () => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);
        await eventually(() => ringsTo(live.master.pushToken, callId).length === 1);

        await enqueueRing(live, callId, live.customer, 'master');

        await silence();
        expect(ringsTo(live.customer.pushToken)).toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );
  });

  /**
   * `GET /calls/:callId`: what the phone reads before a ring push may open an
   * incoming screen. Party-only, with the join route's refusal: a stranger and
   * an unknown id get the same 404.
   */
  describe('GET /calls/:callId', () => {
    it(
      'shows the callee a ringing call as theirs to answer, and the caller as theirs to wait on',
      async () => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);

        const asCallee = await getCall(callId, live.master.accessToken);
        expect(asCallee.status).toBe(200);
        expect(asCallee.body as Call).toMatchObject({
          id: callId,
          orderId: live.orderId,
          status: 'RINGING',
          role: 'callee',
          endReason: null,
          peer: { kind: 'customer', displayName: 'Müştəri Leyla' },
        });

        const asCaller = await getCall(callId, live.customer.accessToken);
        expect(asCaller.status).toBe(200);
        expect(asCaller.body as Call).toMatchObject({
          id: callId,
          status: 'RINGING',
          role: 'caller',
          peer: { kind: 'master', displayName: 'Usta Anar' },
        });

        // And it follows the call: once cancelled, that is what either party reads.
        expect((await act(live.customerSocket, 'call:cancel', callId)).ok).toBe(true);
        const after = await getCall(callId, live.master.accessToken);
        expect(after.body as Call).toMatchObject({ status: 'CANCELLED', endReason: 'cancelled' });

        // Nothing a credential could be made from.
        expect(JSON.stringify(asCallee.body)).not.toContain('token');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'tells a stranger nothing exists, exactly as for an id that does not',
      async () => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);
        const stranger = await signIn('Kənar', 'customers');

        const theirs = await getCall(callId, stranger.accessToken);
        const nobodys = await getCall(randomUUID(), stranger.accessToken);

        expect(theirs.status).toBe(404);
        expect(nobodys.status).toBe(404);
        // The same code and words; only the request id differs.
        const refusal = (body: unknown) => {
          const { code, message } = (body as { error: { code: string; message: string } }).error;
          return { code, message };
        };
        expect(refusal(theirs.body)).toEqual(refusal(nobodys.body));
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'requires a signed-in party and a well-formed id',
      async () => {
        const live = await liveOrder();
        const callId = await invite(live.customerSocket, live.orderId);

        expect((await getCall(callId)).status).toBe(401);
        expect((await getCall('not-a-uuid', live.customer.accessToken)).status).toBe(422);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
