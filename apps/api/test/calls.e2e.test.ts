import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  CallAcceptAck,
  CallActionAck,
  CallInviteAck,
  CallJoinCredential,
  CallRealtimeEvent,
} from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { CALL_MEDIA_PROVIDER } from '../src/infra/calls/call-media.types';
import { StubCallMediaProvider } from '../src/infra/calls/stub-call-media.provider';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The ring/answer state machine end to end (issue #185, ADR-0034 § 3, § 4,
 * § 6): real HTTP, real sockets, Postgres, Redis and the deferred-work queue.
 *
 * **Two API instances for the whole file, and the parties are split across
 * them** — the customer's socket and every HTTP request on instance A, the
 * master's socket on instance B. So every frame that reaches the other party
 * crossed the Redis adapter, and "caller and callee on different API
 * instances" is asserted by every positive test rather than by one special
 * case, the way `realtime.conversation-events.e2e.test.ts` does it.
 *
 * **The media server is the stub**, and each instance holds its own: a token
 * minted on B is verified by B's stub (`StubCallMediaProvider.join`), which is
 * what proves the credential admits its holder to *this call's room* and not
 * merely that some string came back.
 *
 * As in the other realtime suites, **every positive assertion has a negative
 * twin**, and the negative is an absence of delivery.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99456${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };

const INCOMING = 'call:incoming';
const ACCEPTED = 'call:accepted';
const REJECTED = 'call:rejected';
const CANCELLED = 'call:cancelled';
const TIMEOUT = 'call:timeout';
const BUSY = 'call:busy';
const ENDED = 'call:ended';

const ARRIVAL_TIMEOUT_MS = 10_000;
const SILENCE_MS = 1_200;
const TEST_TIMEOUT_MS = 60_000;

/** The floor `CALL_RING_TIMEOUT_SECONDS` accepts. */
const RING_TIMEOUT_SECONDS = 10;
/** Small enough that the rate-limit test reaches it in a few invites. */
const INVITES_PER_ORDER = 3;

const REASON = 'Planlar dəyişdi';

interface Party {
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededMaster extends Party {
  readonly masterId: string;
}

interface SeededCustomer extends Party {
  readonly customerId: string;
}

interface LiveOrder {
  readonly orderId: string;
  readonly customer: SeededCustomer;
  readonly master: SeededMaster;
  /** On instance A. */
  readonly customerSocket: Socket;
  /** On instance B. */
  readonly masterSocket: Socket;
}

interface CallRowProbe {
  readonly status: string;
  readonly end_reason: string | null;
  readonly answered_at: Date | null;
  readonly ended_at: Date | null;
  readonly room_name: string;
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

/** Attached before the action and drained after it — see the order-events suite. */
class Recorder {
  readonly received: CallRealtimeEvent[] = [];
  private readonly handler = (payload: CallRealtimeEvent): void => {
    this.received.push(payload);
  };

  constructor(
    private readonly socket: Socket,
    readonly event: string,
  ) {
    socket.on(event, this.handler);
  }

  async next(
    matches: (payload: CallRealtimeEvent) => boolean = () => true,
    timeoutMs = ARRIVAL_TIMEOUT_MS,
  ): Promise<CallRealtimeEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find(matches);
      if (found !== undefined) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(`no ${this.event} arrived within ${String(timeoutMs)}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async quiet(
    matches: (payload: CallRealtimeEvent) => boolean = () => true,
  ): Promise<readonly CallRealtimeEvent[]> {
    await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));
    return this.received.filter(matches);
  }

  stop(): void {
    this.socket.off(this.event, this.handler);
  }
}

describe('calls: the ring/answer state machine (issue #185)', () => {
  /** Takes every HTTP request, and holds the customer's socket. */
  let instanceA: NestFastifyApplication;
  /** Holds the master's socket. */
  let instanceB: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;

  const opened: Socket[] = [];
  const recorders: Recorder[] = [];
  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function post(path: string, accessToken?: string) {
    const pending = request(instanceA.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  function stubOf(instance: NestFastifyApplication): StubCallMediaProvider {
    const provider = instance.get<unknown>(CALL_MEDIA_PROVIDER);
    if (!(provider instanceof StubCallMediaProvider)) {
      throw new Error('these tests run against the stub media server');
    }
    return provider;
  }

  async function signIn(): Promise<Party> {
    const created = await instanceA
      .get(UsersRepository)
      .create({ phoneE164: nextPhone(), roles: [] });
    const pair = await instanceA.get(SessionsService).startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  async function dial(instance: NestFastifyApplication, token: string): Promise<Socket> {
    const socket = io(await instance.getUrl(), {
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

  const invite = (socket: Socket, orderId: string) =>
    ask<CallInviteAck>(socket, 'call:invite', { orderId });
  const accept = (socket: Socket, callId: string) =>
    ask<CallAcceptAck>(socket, 'call:accept', { callId });
  const act = (socket: Socket, frame: string, callId: string) =>
    ask<CallActionAck>(socket, frame, { callId });

  function record(socket: Socket, event: string): Recorder {
    const recorder = new Recorder(socket, event);
    recorders.push(recorder);
    return recorder;
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
    await instanceA.get(MasterPresenceService).refresh(masterId);

    seededMasterIds.push(masterId);
    return { ...caller, masterId };
  }

  async function seedCustomer(): Promise<SeededCustomer> {
    const customer = await signIn();
    const created = await post('/customers', customer.accessToken).send({
      displayName: 'Müştəri Leyla',
    });
    expect(created.status).toBe(201);
    return { ...customer, customerId: (created.body as { id: string }).id };
  }

  async function placeOrder(customer: SeededCustomer): Promise<string> {
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
    return (order.body as { id: string }).id;
  }

  async function acceptOrder(orderId: string, master: SeededMaster): Promise<void> {
    const offer = await eventually(
      async () => {
        const { rows } = await pool.query<{ id: string; status: string }>(
          `select id::text as id, status from order_offers where order_id = $1 and master_id = $2`,
          [orderId, master.masterId],
        );
        return rows[0];
      },
      (row) => row?.status === 'offered',
    );
    if (offer === undefined) {
      throw new Error('unreachable: the poll only returns a defined row');
    }
    const accepted = await post(`/masters/me/offers/${offer.id}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);
  }

  /** An accepted order, the customer's socket on A and the master's on B. */
  async function liveOrder(customer?: SeededCustomer): Promise<LiveOrder> {
    const master = await seedMaster();
    const owner = customer ?? (await seedCustomer());
    const orderId = await placeOrder(owner);
    await acceptOrder(orderId, master);

    const customerSocket = await dial(instanceA, owner.accessToken);
    const masterSocket = await dial(instanceB, master.accessToken);
    return { orderId, customer: owner, master, customerSocket, masterSocket };
  }

  /** The customer rings the master and the master's phone rings. */
  async function ring(live: LiveOrder): Promise<string> {
    const incoming = record(live.masterSocket, INCOMING);
    const ack = await invite(live.customerSocket, live.orderId);
    if (!ack.ok) {
      throw new Error(`invite refused: ${ack.code}`);
    }
    expect(ack.call.status).toBe('RINGING');
    await incoming.next((frame) => frame.call.id === ack.call.id);
    return ack.call.id;
  }

  async function callRow(callId: string): Promise<CallRowProbe> {
    const { rows } = await pool.query<CallRowProbe>(
      `select status, end_reason, answered_at, ended_at, room_name from calls where id = $1`,
      [callId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`no call ${callId}`);
    }
    return row;
  }

  async function liveCallsOn(orderId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from calls
        where order_id = $1 and status in ('RINGING', 'ACCEPTED')`,
      [orderId],
    );
    return Number(rows[0]?.count ?? '0');
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

    set('CALLS_PROVIDER', 'stub');
    set('CALL_RING_TIMEOUT_SECONDS', String(RING_TIMEOUT_SECONDS));
    set('CALL_INVITE_RATE_LIMIT_PER_ORDER', String(INVITES_PER_ORDER));
    set('CALL_INVITE_RATE_LIMIT_WINDOW_SECONDS', '600');

    instanceA = await bootInstance();
    instanceB = await bootInstance();

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
    await instanceA.close();
    await instanceB.close();
    await database.drop();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  describe('a call that is answered and hung up', () => {
    it(
      'rings the master on the other instance, and on accept both get credentials for this call s room',
      async () => {
        const live = await liveOrder();
        const customerAccepted = record(live.customerSocket, ACCEPTED);
        const masterAccepted = record(live.masterSocket, ACCEPTED);
        const customerIncoming = record(live.customerSocket, INCOMING);
        const masterIncoming = record(live.masterSocket, INCOMING);

        const invited = await invite(live.customerSocket, live.orderId);
        if (!invited.ok) {
          throw new Error(`invite refused: ${invited.code}`);
        }
        expect(invited.call).toMatchObject({
          orderId: live.orderId,
          status: 'RINGING',
          role: 'caller',
          endReason: null,
          answeredAt: null,
          endedAt: null,
          peer: { kind: 'master', displayName: 'Usta Anar' },
        });
        const callId = invited.call.id;

        // The callee's phone rings, presented as *their* call.
        const ringing = await masterIncoming.next();
        expect(ringing.call).toMatchObject({
          id: callId,
          role: 'callee',
          status: 'RINGING',
          peer: { kind: 'customer', displayName: 'Müştəri Leyla' },
        });
        // The caller's own devices are not rung.
        expect(await customerIncoming.quiet()).toHaveLength(0);

        const answered = await accept(live.masterSocket, callId);
        if (!answered.ok) {
          throw new Error(`accept refused: ${answered.code}`);
        }
        expect(answered.call).toMatchObject({ id: callId, status: 'ACCEPTED', role: 'callee' });
        expect(answered.credential).toMatchObject({
          callId,
          identity: `master:${live.master.masterId}`,
          peerIdentity: `customer:${live.customer.customerId}`,
          url: 'stub://calls',
        });

        // Both parties hear the answer — and the broadcast carries no credential.
        const toCustomer = await customerAccepted.next();
        const toMaster = await masterAccepted.next();
        expect(toCustomer.call).toMatchObject({ id: callId, status: 'ACCEPTED', role: 'caller' });
        expect(toMaster.call).toMatchObject({ id: callId, status: 'ACCEPTED', role: 'callee' });
        expect(JSON.stringify(toCustomer)).not.toMatch(/token/i);
        expect(JSON.stringify(toMaster)).not.toMatch(/token/i);

        // The caller fetches its own credential from the one HTTP route.
        const joined = await post(`/calls/${callId}/join`, live.customer.accessToken).send({});
        expect(joined.status).toBe(200);
        const customerCredential = joined.body as CallJoinCredential;
        expect(customerCredential).toMatchObject({
          callId,
          identity: `customer:${live.customer.customerId}`,
          peerIdentity: `master:${live.master.masterId}`,
        });

        // Each token admits its holder to exactly this call's room.
        const room = `call-${callId}`;
        stubOf(instanceB).join(answered.credential.token);
        stubOf(instanceA).join(customerCredential.token);
        expect(await stubOf(instanceB).listParticipants(room)).toEqual([
          expect.objectContaining({ identity: `master:${live.master.masterId}` }),
        ]);
        expect(await stubOf(instanceA).listParticipants(room)).toEqual([
          expect.objectContaining({ identity: `customer:${live.customer.customerId}` }),
        ]);

        const row = await callRow(callId);
        expect(row).toMatchObject({ status: 'ACCEPTED', end_reason: null, room_name: room });
        expect(row.answered_at).not.toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a hangup ends it on both devices, records the reason, and closes the media room',
      async () => {
        const live = await liveOrder();
        const callId = await ring(live);
        const answered = await accept(live.masterSocket, callId);
        if (!answered.ok) {
          throw new Error(`accept refused: ${answered.code}`);
        }
        stubOf(instanceB).join(answered.credential.token);
        expect((await stubOf(instanceB).listRooms()).map((r) => r.name)).toContain(
          `call-${callId}`,
        );

        const customerEnded = record(live.customerSocket, ENDED);
        const masterEnded = record(live.masterSocket, ENDED);

        const hungUp = await act(live.masterSocket, 'call:hangup', callId);
        expect(hungUp).toMatchObject({ ok: true, call: { status: 'ENDED', endReason: 'hangup' } });

        expect((await customerEnded.next()).call).toMatchObject({
          id: callId,
          status: 'ENDED',
          endReason: 'hangup',
        });
        expect((await masterEnded.next()).call.endReason).toBe('hangup');

        const row = await callRow(callId);
        expect(row).toMatchObject({ status: 'ENDED', end_reason: 'hangup' });
        expect(row.answered_at).not.toBeNull();
        expect(row.ended_at).not.toBeNull();
        expect((await stubOf(instanceB).listRooms()).map((r) => r.name)).not.toContain(
          `call-${callId}`,
        );

        // Over is over: a second hangup, from either side, is stale.
        expect(await act(live.customerSocket, 'call:hangup', callId)).toMatchObject({
          ok: false,
          code: 'CALL_STALE',
          call: { status: 'ENDED' },
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a media server that cannot close the room does not undo the hangup',
      async () => {
        const live = await liveOrder();
        const callId = await ring(live);
        expect((await accept(live.masterSocket, callId)).ok).toBe(true);

        stubOf(instanceA).failWith = new Error('media server unreachable');
        try {
          const hungUp = await act(live.customerSocket, 'call:hangup', callId);
          expect(hungUp).toMatchObject({ ok: true, call: { status: 'ENDED' } });
          expect((await callRow(callId)).status).toBe('ENDED');
        } finally {
          stubOf(instanceA).failWith = undefined;
        }
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('a call that is never answered', () => {
    it(
      'declined: both devices hear it and the reason is declined',
      async () => {
        const live = await liveOrder();
        const callId = await ring(live);
        const customerRejected = record(live.customerSocket, REJECTED);
        const masterRejected = record(live.masterSocket, REJECTED);

        expect(await act(live.masterSocket, 'call:reject', callId)).toMatchObject({
          ok: true,
          call: { status: 'REJECTED', endReason: 'declined' },
        });
        expect((await customerRejected.next()).call).toMatchObject({
          id: callId,
          status: 'REJECTED',
          role: 'caller',
        });
        expect((await masterRejected.next()).call.status).toBe('REJECTED');
        expect(await callRow(callId)).toMatchObject({
          status: 'REJECTED',
          end_reason: 'declined',
          answered_at: null,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'cancelled by the caller: both devices hear it, and a late answer is stale',
      async () => {
        const live = await liveOrder();
        const callId = await ring(live);
        const customerCancelled = record(live.customerSocket, CANCELLED);
        const masterCancelled = record(live.masterSocket, CANCELLED);

        expect(await act(live.customerSocket, 'call:cancel', callId)).toMatchObject({
          ok: true,
          call: { status: 'CANCELLED', endReason: 'cancelled' },
        });
        await customerCancelled.next();
        expect((await masterCancelled.next()).call).toMatchObject({
          id: callId,
          status: 'CANCELLED',
          role: 'callee',
        });

        expect(await accept(live.masterSocket, callId)).toMatchObject({
          ok: false,
          code: 'CALL_STALE',
          call: { status: 'CANCELLED' },
        });
        expect(await callRow(callId)).toMatchObject({
          status: 'CANCELLED',
          end_reason: 'cancelled',
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'times out on the server with the caller s app gone, and leaves no token behind',
      async () => {
        const live = await liveOrder();
        const minted = [
          vi.spyOn(stubOf(instanceA), 'mintJoinToken'),
          vi.spyOn(stubOf(instanceB), 'mintJoinToken'),
        ];
        const masterTimeout = record(live.masterSocket, TIMEOUT);

        const callId = await ring(live);
        // The caller's app is killed mid-ring. Nothing on the client side can
        // end this call any more; the delayed job has to.
        live.customerSocket.disconnect();

        const frame = await masterTimeout.next(
          (payload) => payload.call.id === callId,
          (RING_TIMEOUT_SECONDS + 15) * 1000,
        );
        expect(frame.call).toMatchObject({ status: 'TIMED_OUT', endReason: 'no_answer' });
        expect(await callRow(callId)).toMatchObject({
          status: 'TIMED_OUT',
          end_reason: 'no_answer',
          answered_at: null,
        });

        // Answering after the deadline is too late, and nothing was ever minted.
        expect(await accept(live.masterSocket, callId)).toMatchObject({
          ok: false,
          code: 'CALL_STALE',
        });
        for (const spy of minted) {
          expect(spy).not.toHaveBeenCalled();
        }
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('invalid transitions are refused, not applied', () => {
    it(
      'refuses the edges that belong to the other party, and the ones that do not exist',
      async () => {
        const live = await liveOrder();
        const callId = await ring(live);

        // RINGING: accept and reject are the callee's, cancel is the caller's.
        expect(await accept(live.customerSocket, callId)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        expect(await act(live.customerSocket, 'call:reject', callId)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        expect(await act(live.masterSocket, 'call:cancel', callId)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        // A ringing call is cancelled or declined, never hung up: RINGING →
        // ENDED exists, but it is the system's edge (the order closing).
        expect(await act(live.masterSocket, 'call:hangup', callId)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        expect((await callRow(callId)).status).toBe('RINGING');

        // ACCEPTED: only a hangup leaves it.
        expect((await accept(live.masterSocket, callId)).ok).toBe(true);
        expect(await accept(live.masterSocket, callId)).toMatchObject({
          ok: false,
          code: 'CALL_STALE',
        });
        expect(await act(live.masterSocket, 'call:reject', callId)).toMatchObject({
          ok: false,
          code: 'CALL_STALE',
        });
        expect(await act(live.customerSocket, 'call:cancel', callId)).toMatchObject({
          ok: false,
          code: 'CALL_STALE',
        });
        expect((await callRow(callId)).status).toBe('ACCEPTED');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'refuses a malformed frame without disconnecting',
      async () => {
        const live = await liveOrder();

        for (const [frame, payload] of [
          ['call:invite', undefined],
          ['call:invite', { orderId: 'not-a-uuid' }],
          ['call:invite', { orderId: live.orderId, calleeId: live.master.userId }],
          ['call:invite', { orderId: live.orderId, roomName: 'call-anything' }],
          ['call:accept', {}],
          ['call:hangup', { callId: 42 }],
          ['call:reject', 'call'],
        ] as const) {
          expect(await ask(live.customerSocket, frame, payload)).toMatchObject({
            ok: false,
            code: 'CALL_INVALID',
          });
        }
        expect(live.customerSocket.connected).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('authorization against current state', () => {
    it(
      'a third party can neither invite, accept, reject, hang up nor observe',
      async () => {
        const live = await liveOrder();
        const stranger = await seedCustomer();
        const strangerSocket = await dial(instanceB, stranger.accessToken);
        const heard = [INCOMING, ACCEPTED, REJECTED, CANCELLED, ENDED, BUSY].map((event) =>
          record(strangerSocket, event),
        );

        expect(await invite(strangerSocket, live.orderId)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });

        const callId = await ring(live);
        for (const frame of ['call:accept', 'call:reject', 'call:cancel', 'call:hangup']) {
          expect(await ask(strangerSocket, frame, { callId })).toMatchObject({
            ok: false,
            code: 'CALL_FORBIDDEN',
          });
        }
        // An unknown call id reads exactly like somebody else's.
        expect(await accept(strangerSocket, randomUUID())).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        expect((await callRow(callId)).status).toBe('RINGING');

        expect((await accept(live.masterSocket, callId)).ok).toBe(true);
        expect((await act(live.customerSocket, 'call:hangup', callId)).ok).toBe(true);
        for (const recorder of heard) {
          expect(await recorder.quiet()).toHaveLength(0);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a master who was offered the order but not assigned it cannot call about it',
      async () => {
        const assigned = await seedMaster();
        const bystander = await seedMaster();
        const customer = await seedCustomer();
        const orderId = await placeOrder(customer);
        // Both were offered the job; one took it.
        await eventually(
          async () => {
            const { rows } = await pool.query<{ count: string }>(
              `select count(*)::text as count from order_offers
                where order_id = $1 and master_id = $2`,
              [orderId, bystander.masterId],
            );
            return Number(rows[0]?.count ?? '0');
          },
          (count) => count > 0,
        );
        await acceptOrder(orderId, assigned);

        const bystanderSocket = await dial(instanceB, bystander.accessToken);
        expect(await invite(bystanderSocket, orderId)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        expect(await liveCallsOn(orderId)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a call on an order that is not live is refused — before accept, and after the end',
      async () => {
        // Still searching: there is no master to call and no conversation.
        const customer = await seedCustomer();
        const searching = await placeOrder(customer);
        const customerSocket = await dial(instanceA, customer.accessToken);
        expect(await invite(customerSocket, searching)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });

        // Cancelled: terminal, whoever asks.
        const live = await liveOrder();
        const cancelled = await post(
          `/orders/${live.orderId}/transitions`,
          live.customer.accessToken,
        ).send({ to: 'CANCELLED', reason: REASON });
        expect(cancelled.status).toBe(200);
        expect(await invite(live.customerSocket, live.orderId)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        expect(await invite(live.masterSocket, live.orderId)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a party to one order cannot act on the call of another',
      async () => {
        const mine = await liveOrder();
        const theirs = await liveOrder();
        const theirCall = await ring(theirs);

        expect(await accept(mine.masterSocket, theirCall)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        expect(await act(mine.customerSocket, 'call:cancel', theirCall)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        expect(
          (await post(`/calls/${theirCall}/join`, mine.customer.accessToken).send({})).status,
        ).toBe(404);
        expect((await callRow(theirCall)).status).toBe('RINGING');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a session signed out after the socket connected is refused on its next call frame',
      async () => {
        const live = await liveOrder();
        await pool.query('update sessions set revoked_at = now() where user_id = $1', [
          live.customer.userId,
        ]);

        // The socket is still open — it closes at the token's `exp` — but it
        // can no longer act.
        expect(live.customerSocket.connected).toBe(true);
        expect(await invite(live.customerSocket, live.orderId)).toMatchObject({
          ok: false,
          code: 'CALL_FORBIDDEN',
        });
        expect(await liveCallsOn(live.orderId)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the order closing ends its call', () => {
    it(
      'an answered call ends on both devices when the customer cancels the order',
      async () => {
        const live = await liveOrder();
        const callId = await ring(live);
        expect((await accept(live.masterSocket, callId)).ok).toBe(true);
        const deleted = vi.spyOn(stubOf(instanceA), 'deleteRoom');
        const customerEnded = record(live.customerSocket, ENDED);
        const masterEnded = record(live.masterSocket, ENDED);

        const cancelled = await post(
          `/orders/${live.orderId}/transitions`,
          live.customer.accessToken,
        ).send({ to: 'CANCELLED', reason: REASON });
        expect(cancelled.status).toBe(200);

        expect((await customerEnded.next()).call).toMatchObject({
          id: callId,
          status: 'ENDED',
          endReason: 'order_closed',
        });
        expect((await masterEnded.next()).call.endReason).toBe('order_closed');
        expect(await callRow(callId)).toMatchObject({
          status: 'ENDED',
          end_reason: 'order_closed',
        });
        // The instance that committed the transition closed the room.
        expect(deleted).toHaveBeenCalledWith(`call-${callId}`);

        // And there is nothing to join any more.
        const joined = await post(`/calls/${callId}/join`, live.customer.accessToken).send({});
        expect(joined.status).toBe(409);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a ringing call ends when the master hands the job back',
      async () => {
        const live = await liveOrder();
        const callId = await ring(live);
        const customerEnded = record(live.customerSocket, ENDED);

        const redispatched = await post(
          `/orders/${live.orderId}/transitions`,
          live.master.accessToken,
        ).send({ to: 'SEARCHING', reason: REASON });
        expect(redispatched.status).toBe(200);

        expect((await customerEnded.next()).call).toMatchObject({
          id: callId,
          status: 'ENDED',
          endReason: 'order_closed',
        });
        expect(await callRow(callId)).toMatchObject({
          status: 'ENDED',
          end_reason: 'order_closed',
          answered_at: null,
        });
        // The master the re-dispatch removed can no longer answer it.
        expect(await accept(live.masterSocket, callId)).toMatchObject({
          ok: false,
          code: 'CALL_STALE',
        });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('busy, decided atomically', () => {
    it(
      'the same invite sent twice at once rings once; the other is BUSY',
      async () => {
        const live = await liveOrder();
        const busy = record(live.customerSocket, BUSY);

        const acks = await Promise.all([
          invite(live.customerSocket, live.orderId),
          invite(live.customerSocket, live.orderId),
        ]);

        const statuses = acks.map((ack) => (ack.ok ? ack.call.status : ack.code)).sort();
        expect(statuses).toEqual(['BUSY', 'RINGING']);
        expect(await liveCallsOn(live.orderId)).toBe(1);

        const refused = acks.find((ack) => ack.ok && ack.call.status === 'BUSY');
        if (refused === undefined || !refused.ok) {
          throw new Error('unreachable: one ack is BUSY');
        }
        expect((await busy.next()).call).toMatchObject({
          id: refused.call.id,
          status: 'BUSY',
          endReason: 'busy',
        });
        expect(await callRow(refused.call.id)).toMatchObject({
          status: 'BUSY',
          end_reason: 'busy',
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'A calling B while B calls A, on two instances at once, leaves exactly one live call',
      async () => {
        const live = await liveOrder();

        const acks = await Promise.all([
          invite(live.customerSocket, live.orderId),
          invite(live.masterSocket, live.orderId),
        ]);

        const statuses = acks.map((ack) => (ack.ok ? ack.call.status : ack.code)).sort();
        expect(statuses).toEqual(['BUSY', 'RINGING']);
        expect(await liveCallsOn(live.orderId)).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'two masters ringing one customer at once, on two orders, leave the customer on one call',
      async () => {
        // Different orders, so `calls_one_live_per_order` cannot help: only
        // the lock on the customer's account stands between these two.
        const customer = await seedCustomer();
        const first = await liveOrder(customer);
        const second = await liveOrder(customer);
        const secondMasterSocket = await dial(instanceA, second.master.accessToken);

        // Twice, inside the file's budget of three invites per account per
        // order, so one lucky interleaving cannot hide a missing lock.
        for (let round = 0; round < 2; round += 1) {
          const acks = await Promise.all([
            invite(first.masterSocket, first.orderId),
            invite(secondMasterSocket, second.orderId),
          ]);
          const statuses = acks.map((ack) => (ack.ok ? ack.call.status : ack.code)).sort();
          expect(statuses).toEqual(['BUSY', 'RINGING']);

          const ringing = acks.find((ack) => ack.ok && ack.call.status === 'RINGING');
          if (ringing === undefined || !ringing.ok) {
            throw new Error('unreachable: one ack is RINGING');
          }
          const socket =
            ringing.call.orderId === first.orderId ? first.masterSocket : secondMasterSocket;
          expect((await act(socket, 'call:cancel', ringing.call.id)).ok).toBe(true);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a party already on a call with somebody else is BUSY to a third caller, and is not rung',
      async () => {
        const customer = await seedCustomer();
        const first = await liveOrder(customer);
        const second = await liveOrder(customer);
        const firstCall = await ring(first);
        expect((await accept(first.masterSocket, firstCall)).ok).toBe(true);

        // The customer is on the phone with the first master; the second calls.
        const rung = record(second.customerSocket, INCOMING);
        const busy = record(second.masterSocket, BUSY);
        const refused = await invite(second.masterSocket, second.orderId);
        expect(refused).toMatchObject({ ok: true, call: { status: 'BUSY', role: 'caller' } });
        await busy.next();
        expect(await rung.quiet()).toHaveLength(0);
        expect(await liveCallsOn(second.orderId)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('credentials', () => {
    it(
      'no token is minted on any path but an accept',
      async () => {
        const live = await liveOrder();
        const minted = [
          vi.spyOn(stubOf(instanceA), 'mintJoinToken'),
          vi.spyOn(stubOf(instanceB), 'mintJoinToken'),
        ];
        const frames = [INCOMING, REJECTED, CANCELLED, BUSY].flatMap((event) => [
          record(live.customerSocket, event),
          record(live.masterSocket, event),
        ]);

        // Rung and declined.
        const declined = await ring(live);
        expect((await act(live.masterSocket, 'call:reject', declined)).ok).toBe(true);
        // Rung and cancelled, with a busy invite in between.
        const cancelled = await ring(live);
        expect(await invite(live.masterSocket, live.orderId)).toMatchObject({
          ok: true,
          call: { status: 'BUSY' },
        });
        expect((await act(live.customerSocket, 'call:cancel', cancelled)).ok).toBe(true);
        // And the join route refuses a call that was never answered.
        const ringing = await post(`/calls/${declined}/join`, live.customer.accessToken).send({});
        expect(ringing.status).toBe(409);
        expect((ringing.body as { error: { code: string } }).error.code).toBe('CALL_NOT_JOINABLE');

        for (const spy of minted) {
          expect(spy).not.toHaveBeenCalled();
        }
        for (const recorder of frames) {
          for (const frame of recorder.received) {
            expect(JSON.stringify(frame)).not.toMatch(/token/i);
          }
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'the join route answers only a party, only for an answered call',
      async () => {
        const live = await liveOrder();
        const callId = await ring(live);

        // Ringing: yours, but nothing to join.
        expect((await post(`/calls/${callId}/join`, live.master.accessToken).send({})).status).toBe(
          409,
        );

        expect((await accept(live.masterSocket, callId)).ok).toBe(true);
        const minted = vi.spyOn(stubOf(instanceA), 'mintJoinToken');

        // A stranger is told nothing exists; so is an id that does not.
        const stranger = await seedCustomer();
        expect((await post(`/calls/${callId}/join`, stranger.accessToken).send({})).status).toBe(
          404,
        );
        expect(
          (await post(`/calls/${randomUUID()}/join`, live.customer.accessToken).send({})).status,
        ).toBe(404);
        // Unauthenticated, and malformed.
        expect((await post(`/calls/${callId}/join`).send({})).status).toBe(401);
        expect(
          (await post('/calls/not-a-uuid/join', live.customer.accessToken).send({})).status,
        ).toBe(422);
        expect(minted).not.toHaveBeenCalled();

        // Either party may fetch one — the callee reconnecting, say.
        const again = await post(`/calls/${callId}/join`, live.master.accessToken).send({});
        expect(again.status).toBe(200);
        expect((again.body as CallJoinCredential).identity).toBe(`master:${live.master.masterId}`);
        expect(minted).toHaveBeenCalledTimes(1);
        expect(minted).toHaveBeenCalledWith({
          roomName: `call-${callId}`,
          identity: `master:${live.master.masterId}`,
        });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('rate limit', () => {
    it(
      'refuses the invite past the per-order budget, with a stable code',
      async () => {
        const live = await liveOrder();

        for (let attempt = 0; attempt < INVITES_PER_ORDER; attempt += 1) {
          const ack = await invite(live.customerSocket, live.orderId);
          if (!ack.ok) {
            throw new Error(`invite ${String(attempt)} refused: ${ack.code}`);
          }
          expect((await act(live.customerSocket, 'call:cancel', ack.call.id)).ok).toBe(true);
        }

        expect(await invite(live.customerSocket, live.orderId)).toMatchObject({
          ok: false,
          code: 'CALL_RATE_LIMITED',
        });
        expect(await liveCallsOn(live.orderId)).toBe(0);

        // The budget is this account's on this order: the other party still may.
        const back = await invite(live.masterSocket, live.orderId);
        expect(back).toMatchObject({ ok: true, call: { status: 'RINGING' } });
      },
      TEST_TIMEOUT_MS,
    );
  });
});
