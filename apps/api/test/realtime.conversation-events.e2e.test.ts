import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type {
  ConversationTypingRealtimeEvent,
  Message,
  MessageNewRealtimeEvent,
  MessageReadRealtimeEvent,
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
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Messages, read receipts and typing reaching the other party's socket
 * (issue #179, EPIC 18, [ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md) § 3).
 *
 * **Two real API instances against one Redis, for the whole file.** Every
 * delivery below crosses from the instance that took the HTTP write to a
 * socket held by the other one, so "with two API instances running, a message
 * published on one reaches a client connected to the other" is asserted by
 * every positive test rather than by one special case — the failure it guards
 * against is the one that arrives months later as "sometimes the chat doesn't
 * update".
 *
 * As in `realtime.order-events.e2e.test.ts`, **every positive assertion has a
 * negative twin**, and the negative is an absence of delivery: a frame that
 * reached one extra socket returns nothing to notice.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99455${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };

const MESSAGE_NEW = 'message:new';
const MESSAGE_READ = 'message:read';
const TYPING = 'conversation:typing';

/** The body a trigger refuses, so a send can be made to fail after validation. */
const REFUSED_BODY = 'this insert is refused by a trigger';

const ARRIVAL_TIMEOUT_MS = 10_000;
/** See `realtime.order-events.e2e.test.ts`: each silence follows a delivery that already arrived. */
const SILENCE_MS = 1_200;
const TEST_TIMEOUT_MS = 60_000;

/** The per-connection budget both instances run under — small enough to flood. */
const INBOUND_BURST = 10;

interface Ack {
  readonly ok: boolean;
  readonly code?: string;
}

interface Party {
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededMaster extends Party {
  readonly masterId: string;
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

  async quiet(matches: (payload: T) => boolean = () => true): Promise<readonly T[]> {
    await new Promise((resolve) => setTimeout(resolve, SILENCE_MS));
    return this.received.filter(matches);
  }

  stop(): void {
    this.socket.off(this.event, this.handler);
  }
}

describe('conversation events on the socket (issue #179)', () => {
  /** Takes every HTTP request in the file. */
  let instanceA: NestFastifyApplication;
  /** Holds the socket of whoever is on the receiving end. */
  let instanceB: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;

  const opened: Socket[] = [];
  const recorders: Recorder<unknown>[] = [];
  const seededMasterIds: string[] = [];
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function post(path: string, accessToken: string) {
    return request(instanceA.getHttpServer())
      .post(path)
      .set('authorization', `Bearer ${accessToken}`);
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

  function ask(socket: Socket, event: string, payload: unknown): Promise<Ack> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ack for ${event}`));
      }, ARRIVAL_TIMEOUT_MS);
      socket.emit(event, payload, (ack: Ack) => {
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

  async function seedOrder(): Promise<{ orderId: string; customer: Party }> {
    const customer = await signIn();
    expect(
      (await post('/customers', customer.accessToken).send({ displayName: 'Müştəri' })).status,
    ).toBe(201);
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
    return { orderId: (order.body as { id: string }).id, customer };
  }

  async function accept(orderId: string, master: SeededMaster): Promise<void> {
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

  /**
   * An accepted order with both parties in its room — **the customer on
   * instance A and the master on instance B**, so every frame between them
   * crosses the adapter.
   */
  async function liveConversation(): Promise<{
    orderId: string;
    customer: Party;
    master: SeededMaster;
    customerSocket: Socket;
    masterSocket: Socket;
  }> {
    const master = await seedMaster();
    const { orderId, customer } = await seedOrder();
    await accept(orderId, master);

    const customerSocket = await dial(instanceA, customer.accessToken);
    const masterSocket = await dial(instanceB, master.accessToken);
    expect(await ask(customerSocket, 'room:join', { kind: 'order', orderId })).toMatchObject({
      ok: true,
    });
    expect(await ask(masterSocket, 'room:join', { kind: 'order', orderId })).toMatchObject({
      ok: true,
    });

    return { orderId, customer, master, customerSocket, masterSocket };
  }

  function send(orderId: string, token: string, body: string) {
    return post(`/orders/${orderId}/messages`, token).send({ body });
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
    set('MESSAGE_SEND_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MESSAGE_SEND_RATE_LIMIT_PER_IP_HOUR', '9000');

    set('DISPATCH_INITIAL_RADIUS_M', '1000');
    set('DISPATCH_MAX_RADIUS_M', '4000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '2');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '20');
    set('DISPATCH_MAX_MASTERS_PER_BROADCAST', '10');
    set('MAX_ORDER_REDISPATCHES', '3');

    // A slow refill and a small burst, so the flood test can drain a bucket in
    // one loop while an honest join-then-type never comes near it.
    set('REALTIME_INBOUND_MESSAGES_PER_SECOND', '1');
    set('REALTIME_INBOUND_BURST', String(INBOUND_BURST));

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

  describe('delivery', () => {
    it(
      'a customer writes and the master, on the other instance, receives the message itself',
      async () => {
        const { orderId, customer, customerSocket, masterSocket } = await liveConversation();
        const toMaster = record<MessageNewRealtimeEvent>(masterSocket, MESSAGE_NEW);
        const toCustomer = record<MessageNewRealtimeEvent>(customerSocket, MESSAGE_NEW);

        const sent = await send(orderId, customer.accessToken, 'Salam, giriş arxa tərəfdəndir');
        expect(sent.status).toBe(201);
        const created = sent.body as Message;

        const frame = await toMaster.next();
        // The whole message, exactly as the recipient's HTTP read would show
        // it — which is what "without a refetch" requires.
        expect(frame.orderId).toBe(orderId);
        expect(frame.message).toEqual({ ...created, readAt: null });
        expect(frame.message.body).toBe('Salam, giriş arxa tərəfdəndir');

        // The sender reconciles against the POST response, never a frame.
        expect(await toCustomer.quiet()).toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'the master writes and the customer receives it — the other direction',
      async () => {
        const { orderId, master, customerSocket, masterSocket } = await liveConversation();
        const toCustomer = record<MessageNewRealtimeEvent>(customerSocket, MESSAGE_NEW);
        const toMaster = record<MessageNewRealtimeEvent>(masterSocket, MESSAGE_NEW);

        const sent = await send(orderId, master.accessToken, 'On dəqiqəyə çatıram');
        expect(sent.status).toBe(201);

        const frame = await toCustomer.next();
        expect(frame.message.id).toBe((sent.body as Message).id);
        expect(frame.message.senderKind).toBe('master');
        expect(await toMaster.quiet()).toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a read receipt reaches the sender, once, and not the reader',
      async () => {
        const { orderId, customer, master, customerSocket, masterSocket } =
          await liveConversation();
        const sent = await send(orderId, customer.accessToken, 'Su kranı bağlıdır');
        const message = sent.body as Message;

        const toCustomer = record<MessageReadRealtimeEvent>(customerSocket, MESSAGE_READ);
        const toMaster = record<MessageReadRealtimeEvent>(masterSocket, MESSAGE_READ);

        const read = await post(`/orders/${orderId}/messages/read`, master.accessToken).send({
          throughMessageId: message.id,
        });
        expect(read.status).toBe(200);

        const frame = await toCustomer.next();
        expect(frame).toMatchObject({
          orderId,
          readerKind: 'master',
          throughMessageId: message.id,
        });
        expect(Number.isNaN(Date.parse(frame.readAt))).toBe(false);
        expect(await toMaster.quiet()).toHaveLength(0);

        // A repeated receipt marks nothing, so it says nothing.
        const again = await post(`/orders/${orderId}/messages/read`, master.accessToken).send({
          throughMessageId: message.id,
        });
        expect(again.status).toBe(200);
        expect(await toCustomer.quiet()).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('isolation', () => {
    it(
      'the parties to a different order hear nothing of this conversation',
      async () => {
        const mine = await liveConversation();
        const theirs = await liveConversation();

        const leaks = [
          record<unknown>(theirs.customerSocket, MESSAGE_NEW),
          record<unknown>(theirs.masterSocket, MESSAGE_NEW),
          record<unknown>(theirs.customerSocket, TYPING),
          record<unknown>(theirs.masterSocket, TYPING),
          record<unknown>(theirs.customerSocket, MESSAGE_READ),
        ];
        const delivered = record<MessageNewRealtimeEvent>(mine.masterSocket, MESSAGE_NEW);

        const sent = await send(mine.orderId, mine.customer.accessToken, 'Yalnız bu sifariş üçün');
        expect(sent.status).toBe(201);
        await post(`/orders/${mine.orderId}/messages/read`, mine.master.accessToken).send({
          throughMessageId: (sent.body as Message).id,
        });
        expect(await ask(mine.masterSocket, TYPING, { orderId: mine.orderId })).toEqual({
          ok: true,
        });

        await delivered.next();
        for (const leak of leaks) {
          expect(await leak.quiet()).toHaveLength(0);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a send that does not commit emits nothing',
      async () => {
        const { orderId, customer, masterSocket } = await liveConversation();
        const toMaster = record<MessageNewRealtimeEvent>(masterSocket, MESSAGE_NEW);

        // Refuse one body at the database, after validation and authorization
        // have both passed — the only way to reach "the write failed" from the
        // outside. A frame raised before the write returned would still go out.
        await pool.query(`
          create or replace function refuse_test_body() returns trigger language plpgsql as $$
          begin
            if new.body = '${REFUSED_BODY}' then
              raise exception 'refused by test trigger';
            end if;
            return new;
          end $$`);
        await pool.query(`
          create trigger refuse_test_body before insert on messages
            for each row execute function refuse_test_body()`);

        try {
          const refused = await send(orderId, customer.accessToken, REFUSED_BODY);
          expect(refused.status).toBe(500);

          const accepted = await send(orderId, customer.accessToken, 'Bu isə yazılır');
          expect(accepted.status).toBe(201);

          // The committed one arrives, so the silence about the refused one is
          // not just a slow adapter.
          await toMaster.next((frame) => frame.message.body === 'Bu isə yazılır');
          expect(await toMaster.quiet((frame) => frame.message.body === REFUSED_BODY)).toHaveLength(
            0,
          );
        } finally {
          await pool.query('drop trigger refuse_test_body on messages');
          await pool.query('drop function refuse_test_body()');
        }
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('typing', () => {
    it(
      'reaches the other party and not the typist',
      async () => {
        const { orderId, customerSocket, masterSocket } = await liveConversation();
        const toCustomer = record<ConversationTypingRealtimeEvent>(customerSocket, TYPING);
        const toMaster = record<ConversationTypingRealtimeEvent>(masterSocket, TYPING);

        expect(await ask(masterSocket, TYPING, { orderId })).toEqual({ ok: true });

        expect(await toCustomer.next()).toMatchObject({ orderId });
        expect(await toMaster.quiet()).toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'is refused from a socket that is not in the order s room',
      async () => {
        const { orderId, customerSocket } = await liveConversation();
        const toCustomer = record<unknown>(customerSocket, TYPING);

        // A signed-in stranger naming a real order id.
        const stranger = await signIn();
        const strangerSocket = await dial(instanceB, stranger.accessToken);
        expect(await ask(strangerSocket, TYPING, { orderId })).toMatchObject({
          ok: false,
          code: 'ROOM_FORBIDDEN',
        });

        // A party who has not joined the room is not in it either.
        const master = await seedMaster();
        const masterSocket = await dial(instanceB, master.accessToken);
        expect(await ask(masterSocket, TYPING, { orderId })).toMatchObject({
          ok: false,
          code: 'ROOM_FORBIDDEN',
        });

        expect(await toCustomer.quiet()).toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'refuses a malformed frame without disconnecting',
      async () => {
        const { orderId, masterSocket } = await liveConversation();

        for (const payload of [
          undefined,
          'typing',
          { orderId: 'not-a-uuid' },
          { orderId, typing: true },
        ]) {
          expect(await ask(masterSocket, TYPING, payload)).toMatchObject({
            ok: false,
            code: 'ROOM_INVALID',
          });
        }
        expect(masterSocket.connected).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'a flood is debounced and rate-limited, and the connection survives it',
      async () => {
        const { orderId, customer, customerSocket, masterSocket } = await liveConversation();
        const toCustomer = record<ConversationTypingRealtimeEvent>(customerSocket, TYPING);

        const acks = await Promise.all(
          Array.from({ length: INBOUND_BURST * 3 }, () => ask(masterSocket, TYPING, { orderId })),
        );

        expect(acks.filter((ack) => ack.code === 'RATE_LIMITED').length).toBeGreaterThan(0);
        expect(acks.filter((ack) => ack.ok).length).toBeLessThanOrEqual(INBOUND_BURST);

        // One relay for the whole burst: it fell inside one debounce interval.
        await toCustomer.next();
        expect(await toCustomer.quiet()).toHaveLength(1);

        // Still connected, and still in the room — a delivered message proves it.
        expect(masterSocket.connected).toBe(true);
        const toMaster = record<MessageNewRealtimeEvent>(masterSocket, MESSAGE_NEW);
        expect((await send(orderId, customer.accessToken, 'Hələ buradayam')).status).toBe(201);
        await toMaster.next();
      },
      TEST_TIMEOUT_MS,
    );
  });
});
