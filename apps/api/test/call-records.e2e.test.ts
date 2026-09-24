import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  AdminCallRecord,
  CallAcceptAck,
  CallActionAck,
  CallInviteAck,
  CallRealtimeEvent,
  CallRecord,
  CursorPage,
} from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import {
  CALL_MEDIA_PROVIDER,
  CallMediaUnavailableError,
} from '../src/infra/calls/call-media.types';
import { StubCallMediaProvider } from '../src/infra/calls/stub-call-media.provider';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { RecurringWorkService } from '../src/infra/queue/recurring-work.service';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import {
  CALL_REAPER_JOB,
  CallReconciliationService,
} from '../src/modules/calls/call-reconciliation.service';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Call records, the LiveKit webhook and the reaper (issue #186), over real
 * HTTP and real sockets against Postgres, Redis and the stub media server.
 *
 * **The stub stands in for LiveKit's room registry.** A room exists in it once
 * somebody joins with a credential the accept minted (`StubCallMediaProvider.
 * join`), and "LiveKit closed the empty room" is `deleteRoom` — which is all
 * the reaper can observe of the real server too: `listRooms` either names a
 * room or does not, or cannot be asked (`failWith`).
 *
 * **The reaper is driven by calling its sweep**, not by waiting out an
 * interval: `CALL_REAPER_INTERVAL_SECONDS` is 0 in the suites (`setup-env.ts`),
 * and one test runs it once through the queue to prove the job is wired.
 * Time is moved by backdating rows, never by sleeping.
 *
 * Every "exactly one `call:ended`" is counted on the parties' sockets, which is
 * what a device actually hears.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99457${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const ARRIVAL_TIMEOUT_MS = 10_000;
const SILENCE_MS = 1_000;
const TEST_TIMEOUT_MS = 60_000;
const RING_TIMEOUT_SECONDS = 10;
const WEBHOOK_CONTENT_TYPE = 'application/webhook+json';

interface Party {
  readonly userId: string;
  readonly accessToken: string;
  readonly phone: string;
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
  readonly customerSocket: Socket;
  readonly masterSocket: Socket;
}

interface AnsweredCall {
  readonly callId: string;
  readonly roomName: string;
  /** The master's (callee's) credential, from the accept ack. */
  readonly masterToken: string;
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

  async next(matches: (payload: CallRealtimeEvent) => boolean): Promise<CallRealtimeEvent> {
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

  /** Waits out the silence window, then counts what arrived for this call. */
  async countFor(callId: string): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));
    return this.received.filter((frame) => frame.call.id === callId).length;
  }

  stop(): void {
    this.socket.off(this.event, this.handler);
  }
}

describe('call records, the LiveKit webhook and the reaper (issue #186)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;
  let stub: StubCallMediaProvider;
  let reconciliation: CallReconciliationService;
  let adminToken: string;

  const opened: Socket[] = [];
  const recorders: Recorder[] = [];
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

  function get(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).get(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  /** A delivery exactly as LiveKit would send one: raw bytes, its own content type. */
  function webhook(body: string, authorization?: string, contentType = WEBHOOK_CONTENT_TYPE) {
    const pending = request(app.getHttpServer())
      .post('/webhooks/livekit')
      .set('content-type', contentType);
    return (
      authorization === undefined ? pending : pending.set('authorization', authorization)
    ).send(body);
  }

  /**
   * A signed `room-finished` for a room. **Deliberately not what
   * `JSON.stringify` would produce** — spaces and key order of its own — so
   * that a controller which parsed and re-serialised the body would fail to
   * verify a genuine delivery.
   */
  function roomFinished(roomName: string, eventId = randomUUID()): string {
    return `{ "type" : "room-finished",  "roomName":"${roomName}", "eventId": "${eventId}", "createdAt" : "${new Date().toISOString()}" }`;
  }

  async function signIn(): Promise<Party> {
    const phone = nextPhone();
    const created = await app.get(UsersRepository).create({ phoneE164: phone, roles: [] });
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken, phone };
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

  function record(socket: Socket, event: string): Recorder {
    const recorder = new Recorder(socket, event);
    recorders.push(recorder);
    return recorder;
  }

  async function seedMaster(): Promise<SeededMaster> {
    const party = await signIn();
    const created = await post('/masters', party.accessToken).send({ displayName: 'Usta Anar' });
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
    await app.get(MasterPresenceService).refresh(masterId);

    seededMasterIds.push(masterId);
    return { ...party, masterId };
  }

  async function seedCustomer(): Promise<SeededCustomer> {
    const party = await signIn();
    const created = await post('/customers', party.accessToken).send({
      displayName: 'Müştəri Leyla',
    });
    expect(created.status).toBe(201);
    return { ...party, customerId: (created.body as { id: string }).id };
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

  async function liveOrder(): Promise<LiveOrder> {
    const master = await seedMaster();
    const customer = await seedCustomer();
    const orderId = await placeOrder(customer);
    await acceptOrder(orderId, master);
    return {
      orderId,
      customer,
      master,
      customerSocket: await dial(customer.accessToken),
      masterSocket: await dial(master.accessToken),
    };
  }

  async function ring(live: LiveOrder): Promise<string> {
    const ack = await ask<CallInviteAck>(live.customerSocket, 'call:invite', {
      orderId: live.orderId,
    });
    if (!ack.ok) {
      throw new Error(`invite refused: ${ack.code}`);
    }
    expect(ack.call.status).toBe('RINGING');
    return ack.call.id;
  }

  /** The customer rings, the master answers. Nobody has joined the room yet. */
  async function answered(live: LiveOrder): Promise<AnsweredCall> {
    const callId = await ring(live);
    const ack = await ask<CallAcceptAck>(live.masterSocket, 'call:accept', { callId });
    if (!ack.ok) {
      throw new Error(`accept refused: ${ack.code}`);
    }
    return { callId, roomName: `call-${callId}`, masterToken: ack.credential.token };
  }

  /** Moves a call's clock back, keeping `started_at <= answered_at` as the CHECK wants. */
  async function backdate(callId: string, seconds: number): Promise<void> {
    await pool.query(
      `update calls
          set started_at = started_at - make_interval(secs => $2),
              answered_at = answered_at - make_interval(secs => $2)
        where id = $1`,
      [callId, seconds],
    );
  }

  async function callRow(callId: string) {
    const { rows } = await pool.query<{
      status: string;
      end_reason: string | null;
      ended_at: Date | null;
    }>(`select status, end_reason, ended_at from calls where id = $1`, [callId]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`no call ${callId}`);
    }
    return row;
  }

  async function roomExists(roomName: string): Promise<boolean> {
    return (await stub.listRooms()).some((room) => room.name === roomName);
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
    set('CALLS_PROVIDER', 'stub');
    set('CALL_RING_TIMEOUT_SECONDS', String(RING_TIMEOUT_SECONDS));
    set('CALL_INVITE_RATE_LIMIT_PER_ORDER', '50');
    set('CALL_MAX_DURATION_MINUTES', '30');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .setLogger(new ConsoleLogger())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));
    await app.listen(0, '127.0.0.1');

    const provider = app.get<unknown>(CALL_MEDIA_PROVIDER);
    if (!(provider instanceof StubCallMediaProvider)) {
      throw new Error('these tests run against the stub media server');
    }
    stub = provider;
    reconciliation = app.get(CallReconciliationService);

    const admin = await app.get(AdminRepository).createAdmin({
      email: `admin-${randomUUID()}@tezusta.az`,
      displayName: 'Test Admin',
    });
    adminToken = (await app.get(AdminSessionService).start(admin.id)).accessToken;

    pool = new Pool({ connectionString: database.url });
    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 120_000);

  afterEach(async () => {
    stub.failWith = undefined;
    while (recorders.length > 0) {
      recorders.pop()?.stop();
    }
    while (opened.length > 0) {
      opened.pop()?.disconnect();
    }
    // One order per master at a time: a finished test's master must not be
    // offered the next test's order.
    if (seededMasterIds.length > 0) {
      await pool.query('update masters set is_available = false where id = any($1::uuid[])', [
        seededMasterIds,
      ]);
      seededMasterIds.length = 0;
    }
    // Leave no live call behind to be swept up by a later test's sweep.
    await pool.query(
      `update calls set status = 'ENDED', end_reason = 'hangup', ended_at = greatest(now(), started_at)
        where status = 'ACCEPTED'`,
    );
    await pool.query(
      `update calls set status = 'CANCELLED', end_reason = 'cancelled', ended_at = greatest(now(), started_at)
        where status = 'RINGING'`,
    );
    stub.reset();
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

  describe('the webhook', () => {
    it(
      'ends an answered call whose room finished, tells both parties once, and a replay changes nothing',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);
        const toCustomer = record(live.customerSocket, 'call:ended');
        const toMaster = record(live.masterSocket, 'call:ended');

        const body = roomFinished(call.roomName);
        const signature = stub.signWebhook(body);

        const first = await webhook(body, signature);
        expect(first.status).toBe(200);
        const ended = await callRow(call.callId);
        expect(ended).toMatchObject({ status: 'ENDED', end_reason: 'room_gone' });

        const frame = await toCustomer.next((f) => f.call.id === call.callId);
        expect(frame.call).toMatchObject({ status: 'ENDED', endReason: 'room_gone' });

        // At-least-once delivery: the same event again.
        const replay = await webhook(body, signature);
        expect(replay.status).toBe(200);
        expect(await callRow(call.callId)).toEqual(ended);

        expect(await toCustomer.countFor(call.callId)).toBe(1);
        expect(await toMaster.countFor(call.callId)).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'refuses a bad signature, an absent header and a body it cannot check, and changes nothing',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);
        const body = roomFinished(call.roomName);

        // Signed by somebody else's key.
        const forged = await webhook(body, `Stub ${Buffer.from('forged').toString('base64url')}`);
        expect(forged.status).toBe(401);
        expect(forged.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

        // The right signature over a different body.
        const tampered = await webhook(
          roomFinished(call.roomName).replace('room-finished', 'room-finished '),
          stub.signWebhook(body),
        );
        expect(tampered.status).toBe(401);

        const unsigned = await webhook(body);
        expect(unsigned.status).toBe(401);

        // Genuinely signed, but sent as `application/json`: the framework
        // parsed it, the raw bytes are gone, and nothing can be verified.
        const parsed = await webhook(body, stub.signWebhook(body), 'application/json');
        expect(parsed.status).toBe(401);

        expect(await callRow(call.callId)).toMatchObject({ status: 'ACCEPTED', end_reason: null });
      },
      TEST_TIMEOUT_MS,
    );

    it('refuses a body over the size limit before verifying anything', async () => {
      const body = JSON.stringify({ type: 'room-finished', padding: 'x'.repeat(70 * 1024) });
      const res = await webhook(body, stub.signWebhook(body));
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    });

    it(
      'ignores a stale room-finished for a room that exists now, and one it cannot confirm',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);
        // The room is live: a party is in it. A late, genuine room-finished
        // describes an earlier incarnation and must not cut the call off.
        stub.join(call.masterToken);
        const stale = roomFinished(call.roomName);
        expect((await webhook(stale, stub.signWebhook(stale))).status).toBe(200);
        expect(await callRow(call.callId)).toMatchObject({ status: 'ACCEPTED' });

        // The room is gone but LiveKit cannot be asked: left to the reaper.
        await stub.deleteRoom(call.roomName);
        stub.failWith = new CallMediaUnavailableError('list rooms');
        const unconfirmed = roomFinished(call.roomName);
        expect((await webhook(unconfirmed, stub.signWebhook(unconfirmed))).status).toBe(200);
        expect(await callRow(call.callId)).toMatchObject({ status: 'ACCEPTED' });
      },
      TEST_TIMEOUT_MS,
    );

    it('cuts off an oversized body of any content type at the route, before parsing it', async () => {
      const body = JSON.stringify({ type: 'room-finished', padding: 'x'.repeat(100 * 1024) });
      const res = await webhook(body, stub.signWebhook(body), 'application/json');
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    });

    it('cuts off a chunked body with no declared length once it passes the limit', async () => {
      const url = new URL('/webhooks/livekit', await app.getUrl());
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.write(`{"padding":"${'x'.repeat(40 * 1024)}`);
        req.write(`${'x'.repeat(40 * 1024)}"}`);
        req.end();
      });
      expect(status).toBe(413);
    });

    it(
      'answers 200 to a participant leaving, an event it does not act on, and a ringing call — and changes nothing',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);

        const left = JSON.stringify({
          type: 'participant-left',
          eventId: randomUUID(),
          createdAt: new Date().toISOString(),
          roomName: call.roomName,
          participantIdentity: `customer:${live.customer.customerId}`,
        });
        expect((await webhook(left, stub.signWebhook(left))).status).toBe(200);

        const other = JSON.stringify({
          type: 'track_published',
          eventId: randomUUID(),
          createdAt: new Date().toISOString(),
        });
        expect((await webhook(other, stub.signWebhook(other))).status).toBe(200);

        const unknownRoom = roomFinished(`call-${randomUUID()}`);
        expect((await webhook(unknownRoom, stub.signWebhook(unknownRoom))).status).toBe(200);

        expect(await callRow(call.callId)).toMatchObject({ status: 'ACCEPTED' });

        // A ringing call has no room; a room event naming it says nothing.
        await ask<CallActionAck>(live.masterSocket, 'call:hangup', { callId: call.callId });
        const ringing = await ring(live);
        const aboutRinging = roomFinished(`call-${ringing}`);
        expect((await webhook(aboutRinging, stub.signWebhook(aboutRinging))).status).toBe(200);
        expect(await callRow(ringing)).toMatchObject({ status: 'RINGING' });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the reaper', () => {
    it(
      'ends an answered call whose room is gone — and a force-killed client leaves nobody busy',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);

        // Both parties were in the room, then both apps were killed without a
        // hangup; LiveKit closed the empty room, and its webhook was lost.
        const inRoom = stub.join(call.masterToken);
        expect(await roomExists(call.roomName)).toBe(true);
        inRoom.leave();
        await stub.deleteRoom(call.roomName);
        live.customerSocket.disconnect();
        live.masterSocket.disconnect();
        await backdate(call.callId, 120);

        const report = await reconciliation.sweep();
        expect(report).toMatchObject({ roomGone: 1, mediaUnavailable: false });
        expect(await callRow(call.callId)).toMatchObject({
          status: 'ENDED',
          end_reason: 'room_gone',
        });

        // Nobody is left BUSY: the customer can ring the master again.
        const again = await dial(live.customer.accessToken);
        const ack = await ask<CallInviteAck>(again, 'call:invite', { orderId: live.orderId });
        expect(ack.ok && ack.call.status).toBe('RINGING');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'leaves a call whose room is present, and one answered inside the grace, alone',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);
        stub.join(call.masterToken);
        await backdate(call.callId, 120);

        const other = await liveOrder();
        const fresh = await answered(other);

        const report = await reconciliation.sweep();
        expect(report.roomGone).toBe(0);
        expect(await callRow(call.callId)).toMatchObject({ status: 'ACCEPTED' });
        expect(await callRow(fresh.callId)).toMatchObject({ status: 'ACCEPTED' });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'changes nothing when the media server cannot be asked — an outage does not end live calls',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);
        await backdate(call.callId, 120);
        stub.failWith = new CallMediaUnavailableError('list rooms');

        const report = await reconciliation.sweep();
        expect(report).toMatchObject({ roomGone: 0, roomsClosed: 0, mediaUnavailable: true });
        expect(await callRow(call.callId)).toMatchObject({ status: 'ACCEPTED', end_reason: null });

        // And once it answers again, the call's missing room is acted on.
        stub.failWith = undefined;
        expect((await reconciliation.sweep()).roomGone).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'ends a call past the duration cap as reaped and closes its room',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);
        stub.join(call.masterToken);
        await backdate(call.callId, 31 * 60);

        const report = await reconciliation.sweep();
        expect(report.reaped).toBe(1);
        expect(await callRow(call.callId)).toMatchObject({ status: 'ENDED', end_reason: 'reaped' });
        expect(await roomExists(call.roomName)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'times out a call left ringing past its deadline, telling both parties',
      async () => {
        const live = await liveOrder();
        const toMaster = record(live.masterSocket, 'call:timeout');
        const callId = await ring(live);
        await backdate(callId, RING_TIMEOUT_SECONDS + 60);

        const report = await reconciliation.sweep();
        expect(report.timedOut).toBe(1);
        expect(await callRow(callId)).toMatchObject({
          status: 'TIMED_OUT',
          end_reason: 'no_answer',
        });
        await toMaster.next((f) => f.call.id === callId);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'closes rooms whose call is over or never existed, and nothing else',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);
        // The hangup deletes the room; a credential used after it re-creates
        // one, the way LiveKit does on join.
        const hung = await ask<CallActionAck>(live.masterSocket, 'call:hangup', {
          callId: call.callId,
        });
        expect(hung.ok).toBe(true);
        stub.join(call.masterToken);
        expect(await roomExists(call.roomName)).toBe(true);

        const strayRoom = `call-${randomUUID()}`;
        const foreignRoom = 'somebody-elses-room';
        for (const roomName of [strayRoom, foreignRoom]) {
          const credential = await stub.mintJoinToken({ roomName, identity: 'customer:x' });
          stub.join(credential.token);
        }

        const other = await liveOrder();
        const liveCall = await answered(other);
        stub.join(liveCall.masterToken);

        const report = await reconciliation.sweep();
        expect(report.roomsClosed).toBe(2);
        expect(await roomExists(call.roomName)).toBe(false);
        expect(await roomExists(strayRoom)).toBe(false);
        expect(await roomExists(foreignRoom)).toBe(true);
        expect(await roomExists(liveCall.roomName)).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'runs as a job on the maintenance queue',
      async () => {
        const live = await liveOrder();
        const call = await answered(live);
        await backdate(call.callId, 120);

        await app.get(RecurringWorkService).runNow(CALL_REAPER_JOB);

        await eventually(
          () => callRow(call.callId),
          (row) => row.status === 'ENDED',
        );
        expect(await callRow(call.callId)).toMatchObject({ end_reason: 'room_gone' });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('the webhook and the reaper on one call', () => {
    async function endedFramesAfter(
      steps: (call: AnsweredCall) => Promise<void>,
    ): Promise<{ customer: number; master: number; reason: string | null }> {
      const live = await liveOrder();
      const call = await answered(live);
      await backdate(call.callId, 120);
      const toCustomer = record(live.customerSocket, 'call:ended');
      const toMaster = record(live.masterSocket, 'call:ended');

      await steps(call);

      return {
        customer: await toCustomer.countFor(call.callId),
        master: await toMaster.countFor(call.callId),
        reason: (await callRow(call.callId)).end_reason,
      };
    }

    const deliver = async (call: AnsweredCall): Promise<void> => {
      const body = roomFinished(call.roomName);
      expect((await webhook(body, stub.signWebhook(body))).status).toBe(200);
    };

    it(
      'webhook first, then the reaper: ended once',
      async () => {
        const result = await endedFramesAfter(async (call) => {
          await deliver(call);
          expect((await reconciliation.sweep()).roomGone).toBe(0);
        });
        expect(result).toEqual({ customer: 1, master: 1, reason: 'room_gone' });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'the reaper first, then the webhook: ended once',
      async () => {
        const result = await endedFramesAfter(async (call) => {
          expect((await reconciliation.sweep()).roomGone).toBe(1);
          await deliver(call);
        });
        expect(result).toEqual({ customer: 1, master: 1, reason: 'room_gone' });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'both at once, twice each: ended once',
      async () => {
        const result = await endedFramesAfter(async (call) => {
          await Promise.all([
            deliver(call),
            reconciliation.sweep(),
            deliver(call),
            reconciliation.sweep(),
          ]);
        });
        expect(result).toEqual({ customer: 1, master: 1, reason: 'room_gone' });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('records', () => {
    /** An order with three calls: ended with a known duration, busy-free timed out, and live. */
    async function orderWithHistory() {
      const live = await liveOrder();

      const first = await answered(live);
      await ask<CallActionAck>(live.customerSocket, 'call:hangup', { callId: first.callId });
      await pool.query(
        `update calls set started_at = now() - interval '10 minutes',
                          answered_at = now() - interval '9 minutes',
                          ended_at = now() - interval '9 minutes' + interval '83.9 seconds'
          where id = $1`,
        [first.callId],
      );

      const second = await ring(live);
      await ask<CallActionAck>(live.customerSocket, 'call:cancel', { callId: second });

      const third = await answered(live);
      return { live, first: first.callId, second, third: third.callId };
    }

    function expectNoPii(body: unknown, parties: readonly Party[]): void {
      const text = JSON.stringify(body);
      for (const party of parties) {
        expect(text).not.toContain(party.phone);
        expect(text).not.toContain(party.phone.slice(1));
        expect(text).not.toContain(party.userId);
      }
      expect(text).not.toMatch(/token|phone/i);
    }

    it(
      'shows each party their own calls on the order, newest first, with a server-computed duration',
      async () => {
        const { live, first, second, third } = await orderWithHistory();

        const asCustomer = await get(`/orders/${live.orderId}/calls`, live.customer.accessToken);
        expect(asCustomer.status).toBe(200);
        const page = asCustomer.body as CursorPage<CallRecord>;
        expect(page.items.map((item) => item.id)).toEqual([third, second, first]);
        expect(page.items[2]).toMatchObject({
          id: first,
          role: 'caller',
          status: 'ENDED',
          endReason: 'hangup',
          durationSeconds: 83,
          peer: { kind: 'master', displayName: 'Usta Anar' },
        });
        expect(page.items[1]).toMatchObject({ status: 'CANCELLED', durationSeconds: null });
        expect(page.items[0]).toMatchObject({ status: 'ACCEPTED', durationSeconds: null });
        expectNoPii(page, [live.customer, live.master]);

        const asMaster = await get(
          `/orders/${live.orderId}/calls?limit=2`,
          live.master.accessToken,
        );
        expect(asMaster.status).toBe(200);
        const masterPage = asMaster.body as CursorPage<CallRecord>;
        expect(masterPage.items.map((item) => [item.id, item.role])).toEqual([
          [third, 'callee'],
          [second, 'callee'],
        ]);
        expect(masterPage.nextCursor).not.toBeNull();
        const rest = await get(
          `/orders/${live.orderId}/calls?limit=2&cursor=${String(masterPage.nextCursor)}`,
          live.master.accessToken,
        );
        expect((rest.body as CursorPage<CallRecord>).items.map((item) => item.id)).toEqual([first]);
        expect((rest.body as CursorPage<CallRecord>).nextCursor).toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'answers 404 to anybody who is not a party to the order, and to an unknown order',
      async () => {
        const { live } = await orderWithHistory();
        const stranger = await seedCustomer();

        const refused = await get(`/orders/${live.orderId}/calls`, stranger.accessToken);
        expect(refused.status).toBe(404);
        const unknown = await get(`/orders/${randomUUID()}/calls`, stranger.accessToken);
        expect(unknown.status).toBe(404);
        expect(refused.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
        expect(unknown.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
        expect((await get(`/orders/${live.orderId}/calls`)).status).toBe(401);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'lets an admin list, filter and page through calls, and nobody else',
      async () => {
        const a = await orderWithHistory();
        const b = await orderWithHistory();

        for (const token of [a.live.customer.accessToken, a.live.master.accessToken, undefined]) {
          const refused = await get('/admin/calls', token);
          expect(refused.status).toBe(401);
          expect(JSON.stringify(refused.body)).not.toContain(a.first);
        }

        const byOrder = await get(`/admin/calls?orderId=${a.live.orderId}`, adminToken);
        expect(byOrder.status).toBe(200);
        const orderPage = byOrder.body as CursorPage<AdminCallRecord>;
        expect(orderPage.items.map((item) => item.id)).toEqual([a.third, a.second, a.first]);
        expect(orderPage.items[2]).toEqual({
          id: a.first,
          orderId: a.live.orderId,
          caller: {
            kind: 'customer',
            profileId: a.live.customer.customerId,
            displayName: 'Müştəri Leyla',
          },
          callee: { kind: 'master', profileId: a.live.master.masterId, displayName: 'Usta Anar' },
          status: 'ENDED',
          endReason: 'hangup',
          startedAt: expect.any(String) as unknown,
          answeredAt: expect.any(String) as unknown,
          endedAt: expect.any(String) as unknown,
          durationSeconds: 83,
        });
        expectNoPii(orderPage, [a.live.customer, a.live.master]);

        // Every read is an audited action: one row, the order as the
        // target, and the filters — ids only — as what was looked at.
        const { rows: audited } = await pool.query<{
          action: string;
          target_type: string;
          target_id: string;
          reason: string;
        }>(
          `select action, target_type, target_id::text as target_id, reason
             from admin_audit_log where action = 'call.list' and target_id = $1`,
          [a.live.orderId],
        );
        expect(audited).toEqual([
          {
            action: 'call.list',
            target_type: 'order',
            target_id: a.live.orderId,
            reason: `orderId=${a.live.orderId}; limit=25`,
          },
        ]);
        expectNoPii(audited, [a.live.customer, a.live.master]);

        const byMaster = await get(`/admin/calls?masterId=${b.live.master.masterId}`, adminToken);
        expect((byMaster.body as CursorPage<AdminCallRecord>).items.map((i) => i.id)).toEqual([
          b.third,
          b.second,
          b.first,
        ]);
        const byCustomer = await get(
          `/admin/calls?customerId=${b.live.customer.customerId}&status=CANCELLED`,
          adminToken,
        );
        expect((byCustomer.body as CursorPage<AdminCallRecord>).items.map((i) => i.id)).toEqual([
          b.second,
        ]);

        // `from` inclusive, `to` exclusive, on `started_at`: `a.first` was
        // backdated ten minutes, so a window ending five minutes ago holds it
        // and nothing placed since.
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
        const windowed = await get(
          `/admin/calls?orderId=${a.live.orderId}&to=${encodeURIComponent(fiveMinutesAgo)}`,
          adminToken,
        );
        expect((windowed.body as CursorPage<AdminCallRecord>).items.map((i) => i.id)).toEqual([
          a.first,
        ]);
        const recent = await get(
          `/admin/calls?orderId=${a.live.orderId}&from=${encodeURIComponent(fiveMinutesAgo)}`,
          adminToken,
        );
        expect((recent.body as CursorPage<AdminCallRecord>).items.map((i) => i.id)).toEqual([
          a.third,
          a.second,
        ]);

        // Paging the unfiltered list one row at a time visits every call once.
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const res = await get(
            `/admin/calls?limit=1${cursor === null ? '' : `&cursor=${cursor}`}`,
            adminToken,
          );
          expect(res.status).toBe(200);
          const page = res.body as CursorPage<AdminCallRecord>;
          seen.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor;
        } while (cursor !== null);
        const { rows } = await pool.query<{ count: string }>(
          'select count(*)::text as count from calls',
        );
        expect(seen).toHaveLength(Number(rows[0]?.count));
        expect(new Set(seen).size).toBe(seen.length);
        for (const id of [a.first, a.second, a.third, b.first, b.second, b.third]) {
          expect(seen).toContain(id);
        }

        // An unscoped read is audited too, against a target of its own.
        const { rows: unscoped } = await pool.query<{ count: string }>(
          `select count(*)::text as count from admin_audit_log
            where action = 'call.list' and target_type = 'call_list'`,
        );
        expect(Number(unscoped[0]?.count)).toBeGreaterThanOrEqual(seen.length);

        const backwards = await get(
          `/admin/calls?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(fiveMinutesAgo)}`,
          adminToken,
        );
        expect(backwards.status).toBe(422);
        expect((await get('/admin/calls?limit=101', adminToken)).status).toBe(422);
        expect((await get('/admin/calls?phone=%2B994', adminToken)).status).toBe(422);
      },
      TEST_TIMEOUT_MS * 2,
    );
  });
});
