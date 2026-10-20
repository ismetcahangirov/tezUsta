import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { OrderSearchProgress, OrderSearchWaveRealtimeEvent } from '@tezusta/types';
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
import { SEARCH_CELL_LIMIT, snapToSearchCell } from '../src/modules/orders/search-cells';
import { RealtimeIoAdapter } from '../src/modules/realtime/realtime-io.adapter';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';
import { grantTestSubscription } from './support/subscriptions';

/**
 * The search radar's server half, over a real Postgres, a real socket and the
 * live dispatch engine (issue #397,
 * [ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)).
 *
 * **This is the first surface that shows a non-party anything derived from a
 * master's position**, so the privacy claims are asserted on the wire: every
 * point is exactly a cell centre, no master id or raw coordinate appears in
 * any body or frame, the read is dead outside `SEARCHING`, and a re-dispatch
 * leaves the previous search's masters out of the picture.
 *
 * Offers reach masters through the engine wherever the claim is about the
 * engine (the happy path, the waves, the re-dispatch). The stale-position and
 * cap cases write their offers directly: a stale master is never eligible, so
 * no wave could produce that offer, and the cap needs more distinct cells than
 * a wave is worth waiting for.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99458${String(phoneCounter).padStart(7, '0')}`;
}

const SEARCH_POINT = { latitude: 40.372613, longitude: 49.842717 };

const SEARCH_WAVE_EVENT = 'order:search-wave';
const RADIUS_STEP_SECONDS = 2;
const TOTAL_TIMEOUT_SECONDS = 20;
const READ_LIMIT_PER_HOUR = 40;

const ARRIVAL_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;

interface RoomAck {
  readonly ok: boolean;
}

interface SeededMaster {
  readonly masterId: string;
  readonly accessToken: string;
  readonly at: { readonly latitude: number; readonly longitude: number };
}

interface SeededOrder {
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Every frame of one event on one socket, recorded from before the action. */
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

  all(): readonly T[] {
    return [...this.received];
  }

  stop(): void {
    this.socket.off(this.event, this.handler);
  }
}

/** A point `rows` cells north of `from`, kept inside the same column. */
function cellsNorth(from: { latitude: number; longitude: number }, rows: number) {
  return { latitude: from.latitude + rows * 0.005, longitude: from.longitude };
}

describe('the search radar read and its wave event (issue #397)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let presence: MasterPresenceService;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let serviceId: string;
  let url: string;

  const opened: Socket[] = [];
  const recorders: Recorder<unknown>[] = [];
  const seededMasterIds: string[] = [];
  const openOrders: SeededOrder[] = [];
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

  function readSearch(order: SeededOrder, accessToken = order.accessToken) {
    return get(`/orders/${order.orderId}/search`, accessToken);
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

  function join(socket: Socket, room: object): Promise<RoomAck> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('no ack for room:join'));
      }, ARRIVAL_TIMEOUT_MS);
      socket.emit('room:join', room, (ack: RoomAck) => {
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

  /**
   * A live, verified, available master with a position.
   *
   * `dispatchable: false` leaves out the service offer and the subscription,
   * so no wave will ever offer them anything: the tests that write their own
   * offers use it to keep the engine out of their counts.
   */
  async function seedMaster(
    at = SEARCH_POINT,
    { dispatchable = true, positionAgeSeconds = 0 } = {},
  ): Promise<SeededMaster> {
    const caller = await signIn();
    const created = await post('/masters', caller.accessToken).send({ displayName: 'Usta Anar' });
    expect(created.status).toBe(201);
    const masterId = (created.body as { id: string }).id;

    await pool.query(
      `update masters set verification_status = 'active', is_available = true where id = $1`,
      [masterId],
    );
    if (dispatchable) {
      await grantTestSubscription(pool, masterId);
      await pool.query(
        `insert into master_services (master_id, service_id, price_minor, is_active)
         values ($1, $2, 6700, true)`,
        [masterId, serviceId],
      );
    }
    await pool.query(
      `insert into master_locations (id, master_id, position, recorded_at)
       values ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326),
               now() - make_interval(secs => $5))`,
      [randomUUID(), masterId, at.longitude, at.latitude, positionAgeSeconds],
    );
    if (dispatchable) {
      await presence.refresh(masterId);
    }

    seededMasterIds.push(masterId);
    return { masterId, accessToken: caller.accessToken, at };
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
      description: 'Mətbəxdə kran sızır, su kəsilmir.',
      idempotencyKey: randomUUID(),
    });
    expect(order.status).toBe(201);

    const seeded = { orderId: (order.body as { id: string }).id, accessToken: caller.accessToken };
    openOrders.push(seeded);
    return seeded;
  }

  /** An offer the engine never made: for masters no wave can reach. */
  async function offerDirectly(orderId: string, masterId: string): Promise<void> {
    await pool.query(
      `insert into order_offers
         (id, order_id, master_id, round, radius_m, distance_m, status, expires_at)
       values ($1, $2, $3, 1, 3000, 100, 'offered', now() + interval '1 minute')`,
      [randomUUID(), orderId, masterId],
    );
  }

  async function offersOn(orderId: string): Promise<{ master_id: string; status: string }[]> {
    const { rows } = await pool.query<{ master_id: string; status: string }>(
      `select master_id::text as master_id, status from order_offers where order_id = $1`,
      [orderId],
    );
    return rows;
  }

  async function accept(orderId: string, master: SeededMaster): Promise<void> {
    const offers = await eventually(
      async () => {
        const { rows } = await pool.query<{ id: string; status: string }>(
          `select id::text as id, status from order_offers where order_id = $1 and master_id = $2`,
          [orderId, master.masterId],
        );
        return rows;
      },
      (rows) => rows[0]?.status === 'offered',
    );
    const accepted = await post(
      `/masters/me/offers/${offers[0]?.id ?? ''}/accept`,
      master.accessToken,
    ).send({});
    expect(accepted.status).toBe(200);
  }

  function transition(orderId: string, to: string, token: string) {
    return post(`/orders/${orderId}/transitions`, token).send({ to, reason: 'Test səbəbi' });
  }

  /** The body must not name a master or carry a master's own coordinate. */
  function expectNothingIdentifying(body: unknown, masters: readonly SeededMaster[]): void {
    const text = JSON.stringify(body);
    for (const master of masters) {
      expect(text).not.toContain(master.masterId);
      expect(text).not.toContain(String(master.at.latitude));
      expect(text).not.toContain(String(master.at.longitude));
    }
  }

  function expectOnlyCellCentres(progress: OrderSearchProgress): void {
    for (const cell of progress.cells) {
      expect(cell).toStrictEqual(snapToSearchCell(cell).centre);
    }
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
    set('ORDER_SEARCH_READ_RATE_LIMIT_PER_USER_HOUR', String(READ_LIMIT_PER_HOUR));
    set('ORDER_SEARCH_READ_RATE_LIMIT_PER_IP_HOUR', '9000');

    set('DISPATCH_INITIAL_RADIUS_M', '3000');
    set('DISPATCH_MAX_RADIUS_M', '4000');
    set('DISPATCH_RADIUS_STEP_SECONDS', String(RADIUS_STEP_SECONDS));
    set('DISPATCH_TOTAL_TIMEOUT_SECONDS', String(TOTAL_TIMEOUT_SECONDS));
    set('DISPATCH_MAX_MASTERS_PER_BROADCAST', '20');
    set('MAX_ORDER_REDISPATCHES', '3');

    set('REALTIME_INBOUND_MESSAGES_PER_SECOND', '50');
    set('REALTIME_INBOUND_BURST', '50');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .setLogger(new ConsoleLogger())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useWebSocketAdapter(new RealtimeIoAdapter(app));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

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

  afterEach(async () => {
    while (recorders.length > 0) {
      recorders.pop()?.stop();
    }
    while (opened.length > 0) {
      opened.pop()?.disconnect();
    }
    // A search left running would offer the next test's masters this test's
    // order; that cannot change the next test's counts, but it is noise in
    // the engine's log and load on its queue.
    while (openOrders.length > 0) {
      const order = openOrders.pop();
      if (order !== undefined) {
        await transition(order.orderId, 'CANCELLED', order.accessToken);
      }
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

  describe('GET /orders/:id/search', () => {
    it(
      'counts every master the search reached and draws two cells for three masters, two sharing one',
      async () => {
        const home = snapToSearchCell(SEARCH_POINT);
        const first = await seedMaster({ latitude: 40.3712, longitude: 49.8415 });
        // Inside `first`'s cell, by construction rather than by luck.
        const second = await seedMaster({ latitude: 40.3738, longitude: 49.8441 });
        const third = await seedMaster(cellsNorth(SEARCH_POINT, 3));
        expect(snapToSearchCell(first.at).row).toBe(snapToSearchCell(second.at).row);
        expect(snapToSearchCell(first.at).column).toBe(snapToSearchCell(second.at).column);
        expect(snapToSearchCell(third.at).row).not.toBe(home.row);

        const order = await seedOrder();
        await eventually(
          () => offersOn(order.orderId),
          (rows) => rows.length === 3,
        );

        const response = await readSearch(order);

        expect(response.status).toBe(200);
        const progress = response.body as OrderSearchProgress;
        expect(progress).toStrictEqual({
          round: expect.any(Number) as number,
          radiusM: expect.any(Number) as number,
          maxRadiusM: 4000,
          endsAt: expect.any(String) as string,
          offeredCount: 3,
          cells: [snapToSearchCell(first.at).centre, snapToSearchCell(third.at).centre],
        });
        expect(progress.round).toBeGreaterThanOrEqual(1);
        expect(progress.radiusM).toBeGreaterThanOrEqual(3000);
        expect(progress.radiusM).toBeLessThanOrEqual(4000);
        expect(Date.parse(progress.endsAt)).toBeGreaterThan(Date.now());
        expectOnlyCellCentres(progress);
        expectNothingIdentifying(progress, [first, second, third]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'counts a master whose position has gone stale but does not draw them',
      async () => {
        const order = await seedOrder();
        const fresh = await seedMaster(cellsNorth(SEARCH_POINT, 1), { dispatchable: false });
        const stale = await seedMaster(cellsNorth(SEARCH_POINT, -2), {
          dispatchable: false,
          positionAgeSeconds: 300,
        });
        await offerDirectly(order.orderId, fresh.masterId);
        await offerDirectly(order.orderId, stale.masterId);

        const progress = (await readSearch(order)).body as OrderSearchProgress;

        expect(progress.offeredCount).toBe(2);
        expect(progress.cells).toStrictEqual([snapToSearchCell(fresh.at).centre]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'counts but does not draw a reached master who has gone offline',
      async () => {
        const order = await seedOrder();
        const master = await seedMaster(cellsNorth(SEARCH_POINT, 1), { dispatchable: false });
        await offerDirectly(order.orderId, master.masterId);
        await pool.query('update masters set is_available = false where id = $1', [
          master.masterId,
        ]);

        const progress = (await readSearch(order)).body as OrderSearchProgress;

        expect(progress.offeredCount).toBe(1);
        expect(progress.cells).toStrictEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      `draws at most ${String(SEARCH_CELL_LIMIT)} cells, nearest first, and still counts everyone`,
      async () => {
        const order = await seedOrder();
        const masters: SeededMaster[] = [];
        for (let offset = -6; offset <= 6; offset += 1) {
          masters.push(
            await seedMaster(cellsNorth(SEARCH_POINT, offset * 1.2), { dispatchable: false }),
          );
        }
        for (const master of masters) {
          await offerDirectly(order.orderId, master.masterId);
        }

        const progress = (await readSearch(order)).body as OrderSearchProgress;

        expect(progress.offeredCount).toBe(13);
        expect(progress.cells).toHaveLength(SEARCH_CELL_LIMIT);
        expectOnlyCellCentres(progress);
        const distances = progress.cells.map((cell) =>
          Math.abs(cell.latitude - SEARCH_POINT.latitude),
        );
        expect([...distances].sort((a, b) => a - b)).toStrictEqual(distances);
        expectNothingIdentifying(progress, masters);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'shows only the new search after a re-dispatch',
      async () => {
        const taker = await seedMaster(cellsNorth(SEARCH_POINT, 1));
        const loser = await seedMaster(cellsNorth(SEARCH_POINT, -1));
        const order = await seedOrder();
        await eventually(
          () => offersOn(order.orderId),
          (rows) => rows.length === 2,
        );
        await accept(order.orderId, taker);
        // The loser's `lost` row has an `expires_at` that can run past the
        // new search's start; only `offered_at` keeps it out. They go offline
        // so no wave of the new search re-offers them.
        await pool.query('update masters set is_available = false where id = $1', [loser.masterId]);

        const customerSocket = await dial(order.accessToken);
        expect(await join(customerSocket, { kind: 'order', orderId: order.orderId })).toMatchObject(
          { ok: true },
        );
        const waves = record<OrderSearchWaveRealtimeEvent>(customerSocket, SEARCH_WAVE_EVENT);
        expect((await transition(order.orderId, 'SEARCHING', taker.accessToken)).status).toBe(200);
        await waves.next((wave) => wave.orderId === order.orderId);

        const response = await readSearch(order);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ offeredCount: 0, cells: [] });
        expect(await offersOn(order.orderId)).toHaveLength(2);
      },
      TEST_TIMEOUT_MS,
    );

    describe('who may read it', () => {
      it('refuses an unauthenticated caller with 401', async () => {
        const order = await seedOrder();

        expect((await get(`/orders/${order.orderId}/search`)).status).toBe(401);
      });

      it('answers 404 to another customer and to a master', async () => {
        const order = await seedOrder();
        const stranger = await seedOrder();
        const master = await seedMaster(SEARCH_POINT, { dispatchable: false });

        const asStranger = await readSearch(order, stranger.accessToken);
        const asMaster = await readSearch(order, master.accessToken);

        expect(asStranger.status).toBe(404);
        expect(asMaster.status).toBe(404);
        expect(asStranger.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
      });

      it('refuses an id that is not a uuid with 422, as every order read does', async () => {
        const order = await seedOrder();

        expect((await get('/orders/not-a-uuid/search', order.accessToken)).status).toBe(422);
      });

      it(
        'answers 409 ORDER_NOT_SEARCHING once the order is accepted or cancelled',
        async () => {
          const master = await seedMaster();
          const accepted = await seedOrder();
          await accept(accepted.orderId, master);
          const cancelled = await seedOrder();
          expect(
            (await transition(cancelled.orderId, 'CANCELLED', cancelled.accessToken)).status,
          ).toBe(200);

          for (const order of [accepted, cancelled]) {
            const response = await readSearch(order);
            expect(response.status).toBe(409);
            expect(response.body).toMatchObject({ error: { code: 'ORDER_NOT_SEARCHING' } });
          }
        },
        TEST_TIMEOUT_MS,
      );

      it(
        `answers 429 past ${String(READ_LIMIT_PER_HOUR)} reads in the window`,
        async () => {
          const order = await seedOrder();

          for (let read = 0; read < READ_LIMIT_PER_HOUR; read += 1) {
            expect((await readSearch(order)).status).not.toBe(429);
          }
          expect((await readSearch(order)).status).toBe(429);
        },
        TEST_TIMEOUT_MS,
      );
    });
  });

  describe('order:search-wave', () => {
    it(
      'arrives once per wave, carries no cell or coordinate, and reaches only the order’s room',
      async () => {
        const master = await seedMaster(cellsNorth(SEARCH_POINT, 1));
        const masterSocket = await dial(master.accessToken);
        expect(
          await join(masterSocket, { kind: 'master', masterId: master.masterId }),
        ).toMatchObject({ ok: true });
        const bystander = await seedOrder();
        const bystanderSocket = await dial(bystander.accessToken);
        expect(
          await join(bystanderSocket, { kind: 'order', orderId: bystander.orderId }),
        ).toMatchObject({ ok: true });

        const order = await seedOrder();
        const customerSocket = await dial(order.accessToken);
        expect(await join(customerSocket, { kind: 'order', orderId: order.orderId })).toMatchObject(
          { ok: true },
        );
        const waves = record<OrderSearchWaveRealtimeEvent>(customerSocket, SEARCH_WAVE_EVENT);
        const masterHears = record<OrderSearchWaveRealtimeEvent>(masterSocket, SEARCH_WAVE_EVENT);
        const bystanderHears = record<OrderSearchWaveRealtimeEvent>(
          bystanderSocket,
          SEARCH_WAVE_EVENT,
        );

        // Wave 1 fired when the order was created, before anyone could join;
        // the next ones are what the customer's radar lives on.
        const second = await waves.next((wave) => wave.orderId === order.orderId);
        const third = await waves.next(
          (wave) => wave.orderId === order.orderId && wave.round > second.round,
        );

        expect(second).toStrictEqual({
          orderId: order.orderId,
          round: expect.any(Number) as number,
          radiusM: expect.any(Number) as number,
          offeredCount: 1,
          at: expect.any(Number) as number,
        });
        expect(third.round).toBe(second.round + 1);
        expect(third.radiusM).toBeGreaterThanOrEqual(second.radiusM);
        expectNothingIdentifying(waves.all(), [master]);
        expect(masterHears.all().filter((wave) => wave.orderId === order.orderId)).toStrictEqual(
          [],
        );
        expect(bystanderHears.all().filter((wave) => wave.orderId === order.orderId)).toStrictEqual(
          [],
        );

        const rounds = waves
          .all()
          .filter((wave) => wave.orderId === order.orderId)
          .map((wave) => wave.round);
        expect(new Set(rounds).size).toBe(rounds.length);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'arrives for waves that reach nobody, never after the search ends, and then the read is 409',
      async () => {
        const order = await seedOrder();
        const customerSocket = await dial(order.accessToken);
        expect(await join(customerSocket, { kind: 'order', orderId: order.orderId })).toMatchObject(
          { ok: true },
        );
        const waves = record<OrderSearchWaveRealtimeEvent>(customerSocket, SEARCH_WAVE_EVENT);
        // Not cancelled by the shared teardown: this test is about the search
        // running out on its own.
        openOrders.splice(openOrders.indexOf(order), 1);

        await eventually(
          async () => {
            const { rows } = await pool.query<{ status: string }>(
              'select status from orders where id = $1',
              [order.orderId],
            );
            return rows[0]?.status;
          },
          (status) => status === 'NO_MASTER_FOUND',
          (TOTAL_TIMEOUT_SECONDS + 20) * 1000,
        );
        const atGiveUp = waves.all().length;
        await new Promise((resolve) => setTimeout(resolve, RADIUS_STEP_SECONDS * 2 * 1000));

        const frames = waves.all().filter((wave) => wave.orderId === order.orderId);
        const rounds = frames.map((wave) => wave.round);
        const totalWaves = TOTAL_TIMEOUT_SECONDS / RADIUS_STEP_SECONDS;
        // Every wave after the join announced itself, each once, with nobody reached.
        expect(rounds.length).toBeGreaterThanOrEqual(totalWaves - 2);
        expect(new Set(rounds).size).toBe(rounds.length);
        expect(Math.max(...rounds)).toBe(totalWaves);
        expect(frames.every((wave) => wave.offeredCount === 0)).toBe(true);
        // No skipped tick after the give-up published anything.
        expect(waves.all()).toHaveLength(atGiveUp);

        const response = await readSearch(order);
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ error: { code: 'ORDER_NOT_SEARCHING' } });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'stops arriving once a master accepts',
      async () => {
        const master = await seedMaster(cellsNorth(SEARCH_POINT, 1));
        const order = await seedOrder();
        await accept(order.orderId, master);

        const customerSocket = await dial(order.accessToken);
        expect(await join(customerSocket, { kind: 'order', orderId: order.orderId })).toMatchObject(
          { ok: true },
        );
        const waves = record<OrderSearchWaveRealtimeEvent>(customerSocket, SEARCH_WAVE_EVENT);

        await new Promise((resolve) => setTimeout(resolve, RADIUS_STEP_SECONDS * 2.5 * 1000));

        expect(waves.all().filter((wave) => wave.orderId === order.orderId)).toStrictEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
