import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Conversation, CursorPage, Message } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { MAX_MESSAGE_BODY_LENGTH } from '../src/modules/orders/conversations.schema';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The conversation on an order, over real HTTP against real Postgres
 * (issues #177 and #178, EPIC 18,
 * [ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md)).
 *
 * **The live dispatch engine is not incidental here.** A conversation is
 * opened inside the transaction that claims an order, so the only way to
 * assert "accepting opens exactly one" is to have a real master really accept
 * a really broadcast order. The dispatch parameters are turned right down the
 * way `order-redispatch.e2e.test.ts` turns them down, and for the same reason
 * ADR-0009 made them configuration rather than literals.
 *
 * **Three things asserted here are not reachable through the API at all**, and
 * they are the ones most worth having: the partial unique index that makes
 * "one open conversation per order" true under a concurrent accept, the
 * write-once trigger on `messages`, and the plan of the history query. Each is
 * a guarantee the application layer *relies on* rather than implements, so a
 * test that only drove the endpoints would pass just as happily with all three
 * silently absent.
 */

/** `users.phone_e164` is unique among live rows. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99457${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };
const DESCRIPTION = 'Mətbəxdə kran sızır, su kəsilmir.';

/**
 * The send budget this suite runs under. Low enough that one test can exhaust
 * it in a sane number of requests, high enough that no other test in the file
 * comes near — every test seeds its own users, and the budget is per user.
 */
const SEND_BUDGET = 25;

interface SeededMaster {
  readonly masterId: string;
  readonly userId: string;
  readonly accessToken: string;
}

interface SeededOrder {
  readonly orderId: string;
  readonly customerToken: string;
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

describe('the conversation on an order (issues #177, #178)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let serviceId: string;

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

  async function signIn(): Promise<{ userId: string; accessToken: string }> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

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
    return { masterId, userId: caller.userId, accessToken: caller.accessToken };
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
      description: DESCRIPTION,
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);

    return {
      orderId: (order.body as { id: string }).id,
      customerToken: caller.accessToken,
    };
  }

  async function offerIdFor(orderId: string, masterId: string): Promise<string> {
    const row = await eventually(
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
    if (row === undefined) {
      throw new Error('unreachable: the poll only returns a defined row');
    }
    return row.id;
  }

  async function accept(orderId: string, master: SeededMaster): Promise<void> {
    const offerId = await offerIdFor(orderId, master.masterId);
    const accepted = await post(`/masters/me/offers/${offerId}/accept`, master.accessToken).send(
      {},
    );
    expect(accepted.status).toBe(200);
  }

  /** An order a real master really accepted, with both sides' tokens. */
  async function acceptedOrder(): Promise<{
    orderId: string;
    customerToken: string;
    master: SeededMaster;
  }> {
    const master = await seedMaster();
    const order = await seedOrder();
    await accept(order.orderId, master);
    return { orderId: order.orderId, customerToken: order.customerToken, master };
  }

  async function conversationRows(
    orderId: string,
  ): Promise<{ id: string; master_id: string; closed_at: Date | null }[]> {
    const { rows } = await pool.query<{ id: string; master_id: string; closed_at: Date | null }>(
      `select id::text as id, master_id::text as master_id, closed_at
         from conversations where order_id = $1 order by created_at`,
      [orderId],
    );
    return rows;
  }

  function send(orderId: string, token: string, body: string) {
    return post(`/orders/${orderId}/messages`, token).send({ body });
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

    // Budgets other suites own; here they are only an obstacle.
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('ORDER_TRANSITION_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_USER_HOUR', '9000');
    set('MASTER_OFFER_RESPONSE_RATE_LIMIT_PER_IP_HOUR', '9000');

    // The one budget this suite *is* about. Per-user is the subject; per-IP is
    // turned off, because every request in the file arrives from one address
    // and a tight per-IP number would fail whichever test happened to run last.
    set('MESSAGE_SEND_RATE_LIMIT_PER_USER_HOUR', String(SEND_BUDGET));
    set('MESSAGE_SEND_RATE_LIMIT_PER_IP_HOUR', '9000');

    set('DISPATCH_INITIAL_RADIUS_M', '1000');
    set('DISPATCH_MAX_RADIUS_M', '4000');
    set('DISPATCH_RADIUS_STEP_SECONDS', '2');
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', '20');
    set('DISPATCH_MAX_MASTERS_PER_BROADCAST', '10');
    set('MAX_ORDER_REDISPATCHES', '3');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    await new Promise<void>((resolve, reject) => {
      const server = app.getHttpServer();
      server.once('error', reject);
      server.listen(0, () => {
        resolve();
      });
    });

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    presence = app.get(MasterPresenceService);

    pool = new Pool({ connectionString: database.url });

    const catalogue = await pool.query<{ id: string }>('select id from services limit 1');
    const found = catalogue.rows[0]?.id;
    if (found === undefined) {
      throw new Error('the seeded catalogue should contain at least one service');
    }
    serviceId = found;
  }, 120_000);

  beforeEach(async () => {
    // Masters accumulate across tests and every broadcast reaches only the
    // nearest few, so a master left available from a finished test crowds out
    // the fresh one the next test is waiting for — the fixture hazard
    // `order-redispatch.e2e.test.ts` documents.
    if (seededMasterIds.length === 0) {
      return;
    }
    await pool.query('update masters set is_available = false where id = any($1::uuid[])', [
      seededMasterIds,
    ]);
    seededMasterIds.length = 0;
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

  describe('opening and closing (issue #177)', () => {
    it('accepting an order opens exactly one conversation, bound to the accepting master', async () => {
      const { orderId, master } = await acceptedOrder();

      const rows = await conversationRows(orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.master_id).toBe(master.masterId);
      expect(rows[0]?.closed_at).toBeNull();
    });

    it('a searching order has no conversation, and asking for one is a 404', async () => {
      const order = await seedOrder();

      expect(await conversationRows(order.orderId)).toHaveLength(0);

      const response = await get(`/orders/${order.orderId}/conversation`, order.customerToken);
      expect(response.status).toBe(404);
    });

    /**
     * The invariant ADR-0009 calls the most important one in the backend,
     * applied to this table. Two masters tap accept together; the conditional
     * `UPDATE` decides the winner, and `conversations_one_open_per_order` is
     * what guarantees the loser's transaction cannot also leave a row behind.
     */
    it('two masters accepting together leave exactly one conversation', async () => {
      const [first, second] = await Promise.all([seedMaster(), seedMaster()]);
      const order = await seedOrder();

      const offers = await Promise.all([
        offerIdFor(order.orderId, first.masterId),
        offerIdFor(order.orderId, second.masterId),
      ]);

      const responses = await Promise.all([
        post(`/masters/me/offers/${offers[0]}/accept`, first.accessToken).send({}),
        post(`/masters/me/offers/${offers[1]}/accept`, second.accessToken).send({}),
      ]);

      const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const rows = await conversationRows(order.orderId);
      expect(rows).toHaveLength(1);

      // And it belongs to whichever master actually holds the order.
      const { rows: orderRows } = await pool.query<{ master_id: string }>(
        'select master_id::text as master_id from orders where id = $1',
        [order.orderId],
      );
      expect(rows[0]?.master_id).toBe(orderRows[0]?.master_id);
    });

    it('re-dispatch closes the conversation, and the next accept opens a new one', async () => {
      const { orderId, master } = await acceptedOrder();
      const opened = await conversationRows(orderId);
      expect(opened).toHaveLength(1);

      const redispatched = await post(`/orders/${orderId}/transitions`, master.accessToken).send({
        to: 'SEARCHING',
        reason: 'Maşınım xarab oldu.',
      });
      expect(redispatched.status).toBe(200);

      const afterRedispatch = await conversationRows(orderId);
      expect(afterRedispatch).toHaveLength(1);
      expect(afterRedispatch[0]?.closed_at).not.toBeNull();

      // A different master takes the job on the second round.
      const replacement = await seedMaster();
      await accept(orderId, replacement);

      const afterSecondAccept = await conversationRows(orderId);
      expect(afterSecondAccept).toHaveLength(2);
      expect(afterSecondAccept.filter((row) => row.closed_at === null)).toHaveLength(1);
      expect(afterSecondAccept.at(-1)?.master_id).toBe(replacement.masterId);
      expect(afterSecondAccept.at(-1)?.id).not.toBe(opened[0]?.id);
    });

    it('the master who gave the job up loses the conversation; the new one has it', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();

      expect((await send(orderId, master.accessToken, 'Yoldayam.')).status).toBe(201);

      const redispatched = await post(`/orders/${orderId}/transitions`, master.accessToken).send({
        to: 'SEARCHING',
        reason: 'Gələ bilmirəm.',
      });
      expect(redispatched.status).toBe(200);

      const replacement = await seedMaster();
      await accept(orderId, replacement);

      // The previous master is no longer party to the order at all.
      expect((await get(`/orders/${orderId}/conversation`, master.accessToken)).status).toBe(404);

      // The customer's conversation is the new one, and it is empty: the
      // previous master's message did not follow the job to its replacement.
      const conversation = await get(`/orders/${orderId}/conversation`, customerToken);
      expect(conversation.status).toBe(200);

      const history = await get(`/orders/${orderId}/messages`, customerToken);
      expect((history.body as CursorPage<Message>).items).toHaveLength(0);

      expect((await get(`/orders/${orderId}/conversation`, replacement.accessToken)).status).toBe(
        200,
      );
    });
  });

  /**
   * Guarantees the application relies on and does not implement. Driven
   * straight against Postgres, because there is deliberately no endpoint that
   * can reach any of them.
   */
  describe('what the database enforces (issue #177)', () => {
    it('a message body cannot be rewritten, and a message cannot be deleted', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      const sent = await send(orderId, customerToken, 'Birinci mərtəbə, sol qapı.');
      expect(sent.status).toBe(201);
      const messageId = (sent.body as Message).id;

      await expect(
        pool.query('update messages set body = $2 where id = $1', [messageId, 'başqa söz']),
      ).rejects.toThrow(/write-once/);

      await expect(pool.query('delete from messages where id = $1', [messageId])).rejects.toThrow(
        /write-once/,
      );

      // And the row is untouched by either attempt.
      const { rows } = await pool.query<{ body: string }>(
        'select body from messages where id = $1',
        [messageId],
      );
      expect(rows[0]?.body).toBe('Birinci mərtəbə, sol qapı.');
    });

    it('a read receipt is stamped once and cannot be moved', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();
      const sent = await send(orderId, customerToken, 'Salam.');
      const messageId = (sent.body as Message).id;

      const read = await post(`/orders/${orderId}/messages/read`, master.accessToken).send({
        throughMessageId: messageId,
      });
      expect(read.status).toBe(200);

      await expect(
        pool.query("update messages set read_at = read_at + interval '1 hour' where id = $1", [
          messageId,
        ]),
      ).rejects.toThrow(/set once/);

      await expect(
        pool.query('update messages set read_at = null where id = $1', [messageId]),
      ).rejects.toThrow(/set once/);
    });

    it('two open conversations on one order are impossible', async () => {
      const { orderId, master } = await acceptedOrder();

      await expect(
        pool.query(`insert into conversations (id, order_id, master_id) values ($1, $2, $3)`, [
          randomUUID(),
          orderId,
          master.masterId,
        ]),
      ).rejects.toThrow(/conversations_one_open_per_order/);
    });

    it('the history page is served by its index rather than a sequential scan', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      for (let index = 0; index < 5; index += 1) {
        expect((await send(orderId, customerToken, `mesaj ${String(index)}`)).status).toBe(201);
      }

      const conversationId = (await conversationRows(orderId))[0]?.id;
      expect(conversationId).toBeDefined();

      // Postgres will happily choose a sequential scan on a tiny table, and
      // saying otherwise would make this assertion a lie about small data
      // rather than a check on the index. Disabling the alternative is what
      // makes the question "can this index serve the query" instead of "is it
      // cheaper today".
      const client = await pool.connect();
      try {
        await client.query('set enable_seqscan = off');
        // And the bitmap path, which serves the filter but not the order: it
        // produces an unordered heap scan and then sorts, which is exactly the
        // cost the third index column exists to remove.
        await client.query('set enable_bitmapscan = off');
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          `explain select * from messages
             where conversation_id = $1
             order by created_at desc, id desc
             limit 30`,
          [conversationId],
        );
        const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
        expect(plan).toContain('messages_conversation_created_idx');
        expect(plan).not.toContain('Sort');
      } finally {
        await client.query('reset enable_seqscan');
        await client.query('reset enable_bitmapscan');
        client.release();
      }
    });
  });

  describe('reading and writing (issue #178)', () => {
    it('each party sees what the other wrote, and their own unread count', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();

      expect((await send(orderId, customerToken, 'Qapı kodu 1204.')).status).toBe(201);
      expect((await send(orderId, master.accessToken, 'On dəqiqəyə oradayam.')).status).toBe(201);

      const asCustomer = await get(`/orders/${orderId}/messages`, customerToken);
      expect(asCustomer.status).toBe(200);
      const customerItems = (asCustomer.body as CursorPage<Message>).items;
      expect(customerItems.map((item) => item.body)).toEqual([
        'On dəqiqəyə oradayam.',
        'Qapı kodu 1204.',
      ]);
      expect(customerItems.map((item) => item.senderKind)).toEqual(['master', 'customer']);

      // Each side's unread count is its own, and neither is told the other's.
      const customerConversation = await get(`/orders/${orderId}/conversation`, customerToken);
      expect((customerConversation.body as Conversation).unreadCount).toBe(1);
      expect((customerConversation.body as Conversation).writable).toBe(true);

      const masterConversation = await get(`/orders/${orderId}/conversation`, master.accessToken);
      expect((masterConversation.body as Conversation).unreadCount).toBe(1);
    });

    it('a read receipt clears the reader s badge and reaches the sender, once', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();

      const first = await send(orderId, customerToken, 'Birinci.');
      const second = await send(orderId, customerToken, 'İkinci.');
      expect(second.status).toBe(201);

      // The master reads only as far as the first message.
      const read = await post(`/orders/${orderId}/messages/read`, master.accessToken).send({
        throughMessageId: (first.body as Message).id,
      });
      expect(read.status).toBe(200);
      expect((read.body as Conversation).unreadCount).toBe(1);

      // The customer is told their first message was read and their second
      // was not. Neither receipt is reported back to the master who made them.
      const asCustomer = await get(`/orders/${orderId}/messages`, customerToken);
      const byId = new Map(
        (asCustomer.body as CursorPage<Message>).items.map((item) => [item.id, item]),
      );
      expect(byId.get((first.body as Message).id)?.readAt).not.toBeNull();
      expect(byId.get((second.body as Message).id)?.readAt).toBeNull();

      const asMaster = await get(`/orders/${orderId}/messages`, master.accessToken);
      for (const item of (asMaster.body as CursorPage<Message>).items) {
        expect(item.readAt).toBeNull();
      }

      // A repeated receipt is a no-op rather than a re-stamp, which the
      // write-once trigger would otherwise refuse.
      const again = await post(`/orders/${orderId}/messages/read`, master.accessToken).send({
        throughMessageId: (first.body as Message).id,
      });
      expect(again.status).toBe(200);
      expect((again.body as Conversation).unreadCount).toBe(1);
    });

    it('a receipt naming a message from another conversation is a 404', async () => {
      const mine = await acceptedOrder();
      const theirs = await acceptedOrder();

      const foreign = await send(theirs.orderId, theirs.customerToken, 'Başqa sifariş.');

      const response = await post(
        `/orders/${mine.orderId}/messages/read`,
        mine.master.accessToken,
      ).send({ throughMessageId: (foreign.body as Message).id });
      expect(response.status).toBe(404);
    });

    /**
     * The failure offset pagination would produce, driven deliberately: the
     * other party writes between two pages. Under `OFFSET` the second page
     * would repeat the row the first page ended on.
     */
    it('paging back through a conversation being appended to returns each message once', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();

      const written: string[] = [];
      for (let index = 0; index < 9; index += 1) {
        const body = `mesaj ${String(index)}`;
        expect((await send(orderId, customerToken, body)).status).toBe(201);
        written.push(body);
      }

      const firstPage = await get(`/orders/${orderId}/messages?limit=4`, customerToken);
      expect(firstPage.status).toBe(200);
      const first = firstPage.body as CursorPage<Message>;
      expect(first.items).toHaveLength(4);
      expect(first.nextCursor).not.toBeNull();

      // The other party writes while the customer is mid-scroll.
      expect((await send(orderId, master.accessToken, 'araya girdim')).status).toBe(201);

      const seen: string[] = first.items.map((item) => item.body);
      let cursor = first.nextCursor;
      while (cursor !== null) {
        const page = await get(
          `/orders/${orderId}/messages?limit=4&cursor=${encodeURIComponent(cursor)}`,
          customerToken,
        );
        expect(page.status).toBe(200);
        const body = page.body as CursorPage<Message>;
        seen.push(...body.items.map((item) => item.body));
        cursor = body.nextCursor;
      }

      // Every message the customer wrote appears exactly once. The one that
      // arrived mid-scroll is newer than the cursor, so it is legitimately
      // absent — it would be picked up by a refetch, never by paging back.
      expect(new Set(seen).size).toBe(seen.length);
      for (const body of written) {
        expect(seen).toContain(body);
      }
      expect(seen).not.toContain('araya girdim');
    });

    it('a malformed cursor starts from the newest message rather than failing', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      expect((await send(orderId, customerToken, 'tək mesaj')).status).toBe(201);

      const response = await get(`/orders/${orderId}/messages?cursor=not-a-cursor`, customerToken);
      expect(response.status).toBe(200);
      expect((response.body as CursorPage<Message>).items).toHaveLength(1);
    });
  });

  describe('who may not (issue #178)', () => {
    it('refuses every caller who is not a party to the order, with 404 rather than 403', async () => {
      const { orderId } = await acceptedOrder();

      const stranger = await seedOrder(); // a different customer, with their own order
      const otherMaster = await seedMaster();

      const callers: { name: string; token: string | undefined }[] = [
        { name: 'another customer', token: stranger.customerToken },
        { name: 'an unassigned master', token: otherMaster.accessToken },
        { name: 'nobody', token: undefined },
      ];

      for (const caller of callers) {
        const read = await get(`/orders/${orderId}/conversation`, caller.token);
        const history = await get(`/orders/${orderId}/messages`, caller.token);
        const written = await post(`/orders/${orderId}/messages`, caller.token).send({
          body: 'icazəsiz',
        });

        // 401 for the unauthenticated caller (the guard answers first), 404
        // for everyone who is authenticated but not party to this order —
        // never 403, which would confirm the order exists.
        const expected = caller.token === undefined ? 401 : 404;
        expect({ caller: caller.name, status: read.status }).toEqual({
          caller: caller.name,
          status: expected,
        });
        expect(history.status).toBe(expected);
        expect(written.status).toBe(expected);
      }
    });

    it('a master with no conversation on an order cannot write to it by guessing the id', async () => {
      const { orderId } = await acceptedOrder();
      const outsider = await seedMaster();

      const response = await send(orderId, outsider.accessToken, 'salam');
      expect(response.status).toBe(404);

      const { rows } = await pool.query<{ count: string }>(
        `select count(*)::text as count from messages
          where conversation_id in (select id from conversations where order_id = $1)`,
        [orderId],
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('an order that has finished can be read but not added to', async () => {
      const { orderId, customerToken, master } = await acceptedOrder();
      expect((await send(orderId, customerToken, 'İş başlasın.')).status).toBe(201);

      for (const to of ['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED']) {
        const advanced = await post(`/orders/${orderId}/transitions`, master.accessToken).send({
          to,
        });
        expect({ to, status: advanced.status }).toEqual({ to, status: 200 });
      }

      const conversation = await get(`/orders/${orderId}/conversation`, customerToken);
      expect(conversation.status).toBe(200);
      expect((conversation.body as Conversation).writable).toBe(false);

      const history = await get(`/orders/${orderId}/messages`, customerToken);
      expect(history.status).toBe(200);
      expect((history.body as CursorPage<Message>).items).toHaveLength(1);

      const refused = await send(orderId, customerToken, 'bir söz də');
      expect(refused.status).toBe(409);
      expect((refused.body as ErrorEnvelope).error.code).toBe('CONVERSATION_NOT_WRITABLE');

      // Reading is not writing: the badge on a finished job must still clear.
      const read = await post(`/orders/${orderId}/messages/read`, master.accessToken).send({
        throughMessageId: (history.body as CursorPage<Message>).items[0]?.id,
      });
      expect(read.status).toBe(200);
      expect((read.body as Conversation).unreadCount).toBe(0);
    });

    it('a cancelled order is read-only too', async () => {
      const { orderId, customerToken } = await acceptedOrder();
      expect((await send(orderId, customerToken, 'Hələlik lazım deyil.')).status).toBe(201);

      const cancelled = await post(`/orders/${orderId}/transitions`, customerToken).send({
        to: 'CANCELLED',
        reason: 'Özüm düzəltdim.',
      });
      expect(cancelled.status).toBe(200);

      expect((await send(orderId, customerToken, 'yenə')).status).toBe(409);
      expect((await get(`/orders/${orderId}/messages`, customerToken)).status).toBe(200);
    });
  });

  describe('validation and budget (issue #178)', () => {
    it('refuses an empty, blank, oversized or unknown-field body', async () => {
      const { orderId, customerToken } = await acceptedOrder();

      const cases: { name: string; payload: unknown }[] = [
        { name: 'empty', payload: { body: '' } },
        { name: 'blank', payload: { body: '    ' } },
        { name: 'oversized', payload: { body: 'ə'.repeat(MAX_MESSAGE_BODY_LENGTH + 1) } },
        { name: 'missing', payload: {} },
        { name: 'unknown field', payload: { body: 'salam', senderKind: 'master' } },
        { name: 'wrong type', payload: { body: 42 } },
      ];

      for (const testCase of cases) {
        const response = await post(`/orders/${orderId}/messages`, customerToken).send(
          testCase.payload as object,
        );
        expect({ name: testCase.name, status: response.status }).toEqual({
          name: testCase.name,
          status: 422,
        });
      }

      const { rows } = await pool.query<{ count: string }>(
        `select count(*)::text as count from messages
          where conversation_id in (select id from conversations where order_id = $1)`,
        [orderId],
      );
      expect(rows[0]?.count).toBe('0');
    });

    /**
     * The request schema trims and the column's CHECK measures the trimmed
     * string. A body that is exactly at the bound with whitespace around it
     * therefore has to be accepted, not turned into a 500 by Postgres — which
     * is what would happen if the two bounds ever stopped agreeing.
     */
    it('accepts a body at exactly the bound, with surrounding whitespace', async () => {
      const { orderId, customerToken } = await acceptedOrder();

      const response = await send(
        orderId,
        customerToken,
        `  ${'ə'.repeat(MAX_MESSAGE_BODY_LENGTH)}  `,
      );
      expect(response.status).toBe(201);
      expect((response.body as Message).body).toHaveLength(MAX_MESSAGE_BODY_LENGTH);
    });

    it('a limit outside the allowed range is refused rather than silently clamped', async () => {
      const { orderId, customerToken } = await acceptedOrder();

      expect((await get(`/orders/${orderId}/messages?limit=0`, customerToken)).status).toBe(422);
      expect((await get(`/orders/${orderId}/messages?limit=500`, customerToken)).status).toBe(422);
    });

    it('spends the send budget and then refuses, without losing an accepted message', async () => {
      const { orderId, customerToken } = await acceptedOrder();

      let refusedAt: number | null = null;
      for (let index = 0; index < SEND_BUDGET + 2; index += 1) {
        const response = await send(orderId, customerToken, `mesaj ${String(index)}`);
        if (response.status === 429) {
          refusedAt = index;
          expect((response.body as ErrorEnvelope).error.code).toBe('RATE_LIMITED');
          break;
        }
        expect(response.status).toBe(201);
      }

      expect(refusedAt).not.toBeNull();

      // Everything the API said it accepted is in the transcript, and the
      // refusal wrote nothing.
      const { rows } = await pool.query<{ count: string }>(
        `select count(*)::text as count from messages
          where conversation_id in (select id from conversations where order_id = $1)`,
        [orderId],
      );
      expect(rows[0]?.count).toBe(String(refusedAt));
    });
  });
});
