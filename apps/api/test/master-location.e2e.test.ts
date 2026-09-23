import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { MasterLocationReceipt } from '@tezusta/types';
import type Redis from 'ioredis';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { presenceKey } from '../src/infra/presence/master-presence.service';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import type { UserRoleName } from '../src/infra/database/schema/users';
import { REDIS_CLIENT } from '../src/infra/redis/redis.tokens';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * `POST /masters/me/location` over real HTTP, through the real `AppModule`
 * graph, against a real PostGIS database (issue #98).
 *
 * What only this layer can prove, and why each of them needs a database:
 *
 * - **The coordinate survives the round trip in the right order.** Every bound
 *   check in the system passes for a swapped Baku pair (≈40.4 and ≈49.9 are
 *   inside each other's range), so the only thing that catches a swap is
 *   asking Postgres which number came back from `ST_X`.
 * - **The SRID is real.** Drizzle's column config is ignored by the generator;
 *   the typmod exists only because `0015_master_locations.sql` writes it by
 *   hand, and `ST_SRID` is what proves the hand-edit reached the database.
 * - **The GiST index answers the query the product depends on.** ADR-0018
 *   measured 824 ms versus 2.0 ms between the wrong index and the right one,
 *   and the wrong one produces no error — only a sequential scan.
 * - **The append-only triggers fire**, including the deliberately narrow
 *   retention exception, which cannot be tested anywhere but against the
 *   trigger itself.
 * - **The retention prune actually deletes**, which is a promise about a table
 *   rather than about a function.
 *
 * `PRESENCE_*` are pinned to the schema's own floor before the app boots, the
 * same trick and for the same reason as `master-availability.e2e.test.ts`:
 * `ConfigModule` reads `process.env` exactly once, at instantiation.
 */

/** `users.phone_e164` is unique among live rows — see `master-profile.e2e.test.ts`. */
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99457${String(phoneCounter).padStart(7, '0')}`;
}

/**
 * The exact Redis key `MasterPresenceService` writes — imported, not guessed,
 * so the key layout and this run's namespace (#125) have one definition
 * between the application and this suite.
 */
function keyFor(masterId: string): string {
  return presenceKey(parseEnv(process.env).redis.keyPrefix, masterId);
}

const PRESENCE_TTL_SECONDS = 30;
const PRESENCE_HEARTBEAT_SECONDS = 10;

/**
 * The app's pool is pinned small for this suite, and one test depends on it.
 *
 * "The retention permission does not survive the request" is a claim about one
 * pooled connection being borrowed again, so proving it means knowing which
 * connection the next statement gets. With `max` at two, holding one client
 * leaves the app exactly one to work with, and the checkout afterwards can only
 * be that same one — which the test then confirms with `pg_backend_pid()`.
 *
 * Two rather than one because the suite should not depend on no code path ever
 * wanting a second connection; two rather than the default ten because the
 * whole suite would otherwise open nine spare backends on a Postgres several
 * other suites are using at the same time.
 */
const APP_POOL_MAX = 2;

/**
 * A real position in Baku, and a distinctive one: both halves carry six
 * decimals that appear nowhere else in the repository, so the "no coordinate
 * in any log" assertion is searching for something that could only have come
 * from this request.
 */
const BAKU = { latitude: 40.372613, longitude: 49.842717 };

interface PositionRow {
  readonly srid: number;
  readonly x: number;
  readonly y: number;
  readonly recorded_at: Date;
}

describe('master location reporting over HTTP (issue #98)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let redis: Redis;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  interface SignedIn {
    readonly userId: string;
    readonly accessToken: string;
  }

  interface SignedInMaster extends SignedIn {
    readonly masterId: string;
  }

  function post(path: string, accessToken?: string) {
    const pending = request(app.getHttpServer()).post(path);
    return accessToken === undefined
      ? pending
      : pending.set('authorization', `Bearer ${accessToken}`);
  }

  async function signIn(roles: readonly UserRoleName[] = []): Promise<SignedIn> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles });
    const pair = await sessionsService.startSession({ userId: created.user.id });
    return { userId: created.user.id, accessToken: pair.accessToken };
  }

  /** Signs in a fresh user and creates a master profile — still `pending_verification`. */
  async function signInAsMaster(): Promise<SignedInMaster> {
    const caller = await signIn();
    const res = await post('/masters', caller.accessToken).send({ displayName: 'Usta Elçin' });
    expect(res.status).toBe(201);
    return { ...caller, masterId: (res.body as { id: string }).id };
  }

  /**
   * A master the admin has verified. Pushed with raw SQL rather than through
   * the admin endpoints, which are somebody else's suite to own here.
   */
  async function signInAsActiveMaster(): Promise<SignedInMaster> {
    const master = await signInAsMaster();
    await pool.query(`update masters set verification_status = 'active' where id = $1`, [
      master.masterId,
    ]);
    return master;
  }

  /** Verified, and switched on — the only state in which a position may be written. */
  async function signInAsWorkingMaster(): Promise<SignedInMaster> {
    const master = await signInAsActiveMaster();
    const online = await post('/masters/me/availability', master.accessToken).send({
      isAvailable: true,
    });
    expect(online.status).toBe(200);
    return master;
  }

  async function positionsOf(masterId: string): Promise<PositionRow[]> {
    const { rows } = await pool.query<PositionRow>(
      `select ST_SRID(position) as srid,
              ST_X(position) as x,
              ST_Y(position) as y,
              recorded_at
         from master_locations
        where master_id = $1
        order by recorded_at desc`,
      [masterId],
    );
    return rows;
  }

  /** Which Postgres backend a checked-out client is actually talking to. */
  async function backendPid(client: PoolClient): Promise<number> {
    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = rows[0]?.pid;
    if (pid === undefined) {
      throw new Error('pg_backend_pid() returned no row.');
    }
    return pid;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    set('DATABASE_URL', database.url);
    set('DATABASE_POOL_MAX', String(APP_POOL_MAX));
    // The schema's own floor: the smallest pair satisfying "TTL at least twice
    // the heartbeat".
    set('PRESENCE_TTL_SECONDS', String(PRESENCE_TTL_SECONDS));
    set('PRESENCE_HEARTBEAT_SECONDS', String(PRESENCE_HEARTBEAT_SECONDS));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // NOT cosmetic, and the reason `geocoding.e2e.test.ts` gives at length:
      // `Test.createTestingModule` installs Nest's `TestingLogger`, which
      // overrides `log`, `warn`, `debug` and `verbose` with EMPTY bodies, so
      // only `error` reaches a sink. The "coordinates never reach a log"
      // suite below needs the application's real logger, or it asserts
      // against one that discards three levels regardless of content — and
      // since issue #56 an expected 422 is logged at `warn`, which is
      // precisely the level that would have gone missing.
      .setLogger(new ConsoleLogger())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    redis = app.get(REDIS_CLIENT);
    pool = new Pool({ connectionString: database.url });
    // No `error` listener would mean a terminated backend surfaces as an
    // unhandled rejection — see the same note in `master-profile.e2e.test.ts`.
    pool.on('error', () => undefined);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database.drop();
  });

  describe('who may report a position', () => {
    it('refuses an unauthenticated request', async () => {
      const res = await post('/masters/me/location').send(BAKU);
      expect(res.status).toBe(401);
    });

    it("refuses a customer's token with 403, before any row could be written", async () => {
      // A customer's access token is a valid token. The role gate is the only
      // thing between it and a table of other people's movements, and it runs
      // before the service ever looks for a master profile.
      const customer = await signIn();

      const res = await post('/masters/me/location', customer.accessToken).send(BAKU);

      expect(res.status).toBe(403);
      expect((res.body as ErrorEnvelope).error.code).toBe('FORBIDDEN');
    });

    it('refuses an offline master, naming the situation rather than 200-ing silently', async () => {
      // The master turned themselves off — possibly on another device. An app
      // still reporting after that is an app whose user believes it stopped.
      const master = await signInAsActiveMaster();

      const res = await post('/masters/me/location', master.accessToken).send(BAKU);

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.code).toBe('CONFLICT');
      expect(await positionsOf(master.masterId)).toHaveLength(0);
    });

    it('refuses a master whose verification_status is not active, and writes nothing', async () => {
      // `is_available` is forced directly, because the availability endpoint
      // would never have let an unverified master switch it on. That is the
      // point: eligibility is re-read from the database on every report rather
      // than inferred from the fact that somebody is online.
      const master = await signInAsMaster();
      await pool.query(`update masters set is_available = true where id = $1`, [master.masterId]);

      const res = await post('/masters/me/location', master.accessToken).send(BAKU);

      expect(res.status).toBe(409);
      const body = res.body as ErrorEnvelope;
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details?.verificationStatus).toBe('pending_verification');
      expect(await positionsOf(master.masterId)).toHaveLength(0);
    });

    it('drops a master suspended mid-shift on their next report', async () => {
      const master = await signInAsWorkingMaster();
      await pool.query(
        `update masters set verification_status = 'suspended', suspended_at = now() where id = $1`,
        [master.masterId],
      );

      const res = await post('/masters/me/location', master.accessToken).send(BAKU);

      expect(res.status).toBe(409);
      expect((res.body as ErrorEnvelope).error.details?.verificationStatus).toBe('suspended');
      // Presence gone and intent cleared, so the suspension bites within one
      // report rather than waiting for dispatch to notice.
      expect(await redis.get(keyFor(master.masterId))).toBeNull();
      const { rows } = await pool.query<{ is_available: boolean }>(
        'select is_available from masters where id = $1',
        [master.masterId],
      );
      expect(rows[0]?.is_available).toBe(false);
      expect(await positionsOf(master.masterId)).toHaveLength(0);
    });
  });

  describe('recording a position', () => {
    it('stores the point in SRID 4326 with longitude and latitude the right way round', async () => {
      const master = await signInAsWorkingMaster();

      const res = await post('/masters/me/location', master.accessToken).send(BAKU);

      expect(res.status).toBe(200);
      const rows = await positionsOf(master.masterId);
      expect(rows).toHaveLength(1);
      // The three assertions a swap or a lost typmod would each break, and
      // which nothing else in the system would notice.
      expect(rows[0]?.srid).toBe(4326);
      expect(rows[0]?.x).toBeCloseTo(BAKU.longitude, 6);
      expect(rows[0]?.y).toBeCloseTo(BAKU.latitude, 6);
    });

    it('answers with the server-stamped time and the whole presence state, and no coordinate', async () => {
      const master = await signInAsWorkingMaster();

      const res = await post('/masters/me/location', master.accessToken).send(BAKU);

      expect(res.status).toBe(200);
      const body = res.body as MasterLocationReceipt;
      expect(Object.keys(body).sort()).toEqual(['engagedOrderId', 'presence', 'recordedAt']);
      // No job, so nothing to name.
      expect(body.engagedOrderId).toBeNull();
      expect(Date.parse(body.recordedAt)).not.toBeNaN();
      expect(body.presence).toEqual({
        isAvailable: true,
        isLive: true,
        expiresInSeconds: expect.any(Number),
        heartbeatSeconds: PRESENCE_HEARTBEAT_SECONDS,
      });
      // Nothing echoes the position back: the app already knows where it is,
      // and a reply carrying it would put it in one more proxy and crash log.
      expect(JSON.stringify(body)).not.toContain('49.84');
    });

    it('refreshes presence without a separate heartbeat call', async () => {
      const master = await signInAsWorkingMaster();
      // Drop the key the availability toggle wrote, so the only thing that can
      // bring it back is the report itself.
      await redis.del(keyFor(master.masterId));

      const res = await post('/masters/me/location', master.accessToken).send(BAKU);

      expect(res.status).toBe(200);
      expect((res.body as MasterLocationReceipt).presence.isLive).toBe(true);
      const ttl = await redis.ttl(keyFor(master.masterId));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL_SECONDS);
    });

    it('appends rather than overwriting: two reports leave two rows, newest first', async () => {
      const master = await signInAsWorkingMaster();

      await post('/masters/me/location', master.accessToken).send(BAKU);
      await post('/masters/me/location', master.accessToken).send({
        latitude: BAKU.latitude + 0.001,
        longitude: BAKU.longitude + 0.001,
      });

      const rows = await positionsOf(master.masterId);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.y).toBeCloseTo(BAKU.latitude + 0.001, 6);
    });

    it('is 404 for a caller holding the master role with no live profile', async () => {
      // The role gate passes; there is simply no row. 404 rather than 403, the
      // same answer `GET /masters/me` gives for the same situation.
      const orphan = await signIn(['master']);

      const res = await post('/masters/me/location', orphan.accessToken).send(BAKU);

      expect(res.status).toBe(404);
      expect((res.body as ErrorEnvelope).error.code).toBe('NOT_FOUND');
    });
  });

  describe('validation at the boundary', () => {
    it.each([
      ['a latitude off the planet', { latitude: 95, longitude: 49.8 }],
      ['a longitude off the planet', { latitude: 40.4, longitude: 200 }],
      ['a stringified coordinate', { latitude: '40.4', longitude: '49.8' }],
      ['an unknown field', { ...BAKU, accuracy: 12 }],
      ['half a coordinate', { latitude: 40.4 }],
    ])('answers 422 for %s, and writes nothing', async (_case, body) => {
      const master = await signInAsWorkingMaster();

      const res = await post('/masters/me/location', master.accessToken).send(body);

      expect(res.status).toBe(422);
      expect((res.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
      expect(await positionsOf(master.masterId)).toHaveLength(0);
    });

    it('refuses an off-planet coordinate in the database too, not only in Zod', async () => {
      // The CHECK is the half a seed script, a migration or an admin tool
      // cannot route around. Zod protects the request path; this protects the
      // table.
      const master = await signInAsActiveMaster();

      await expect(
        pool.query(
          `insert into master_locations (id, master_id, position)
           values (gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint(200, 100), 4326))`,
          [master.masterId],
        ),
      ).rejects.toThrow(/master_locations_position_on_earth/);
    });
  });

  describe('the table is append-only', () => {
    it('raises on UPDATE', async () => {
      const master = await signInAsWorkingMaster();
      await post('/masters/me/location', master.accessToken).send(BAKU);

      await expect(
        pool.query(
          `update master_locations set position = ST_SetSRID(ST_MakePoint(0, 0), 4326)
            where master_id = $1`,
          [master.masterId],
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('raises on DELETE', async () => {
      const master = await signInAsWorkingMaster();
      await post('/masters/me/location', master.accessToken).send(BAKU);

      await expect(
        pool.query('delete from master_locations where master_id = $1', [master.masterId]),
      ).rejects.toThrow(/append-only/);

      expect(await positionsOf(master.masterId)).toHaveLength(1);
    });

    it('raises on TRUNCATE, which bypasses row-level triggers entirely', async () => {
      await expect(pool.query('truncate master_locations')).rejects.toThrow(/append-only/);
    });
  });

  describe('retention', () => {
    it("prunes this master's expired rows on the next report, and keeps the fresh ones", async () => {
      const master = await signInAsWorkingMaster();

      // Two rows planted behind the retention window (60 minutes by default)
      // and one inside it. Planted directly because there is no way to make
      // the clock move an hour inside a test suite, and because this is
      // exactly the shape a master who has been working all day leaves behind.
      await pool.query(
        `insert into master_locations (id, master_id, position, recorded_at)
         values (gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint(49.8, 40.4), 4326), now() - interval '3 hours'),
                (gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint(49.8, 40.4), 4326), now() - interval '90 minutes'),
                (gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint(49.8, 40.4), 4326), now() - interval '5 minutes')`,
        [master.masterId],
      );
      expect(await positionsOf(master.masterId)).toHaveLength(3);

      const res = await post('/masters/me/location', master.accessToken).send(BAKU);
      expect(res.status).toBe(200);

      // The two expired rows are gone; the recent one and the new one remain.
      const rows = await positionsOf(master.masterId);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => Date.now() - row.recorded_at.getTime() < 3_600_000)).toBe(true);
    });

    it("prunes only the reporting master's trail, never anybody else's", async () => {
      // A sweep of the whole table on every report would put one master's
      // request in contention with every other master's — the shape that looks
      // fine in development and locks up a fleet.
      const bystander = await signInAsActiveMaster();
      await pool.query(
        `insert into master_locations (id, master_id, position, recorded_at)
         values (gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint(49.8, 40.4), 4326), now() - interval '5 hours')`,
        [bystander.masterId],
      );

      const reporter = await signInAsWorkingMaster();
      await post('/masters/me/location', reporter.accessToken).send(BAKU);

      expect(await positionsOf(bystander.masterId)).toHaveLength(1);
    });

    it('leaves the retention permission behind on the very connection that pruned', async () => {
      // `SET LOCAL` reverts at commit. If it did not, a POOLED connection would
      // carry permission to delete from an append-only table into whatever
      // request borrowed it next — and that hazard lives on one specific
      // connection, so it can only be observed there. The suite's own `pool` is
      // a different pool that never ran the `SET LOCAL`; a DELETE through it
      // would prove only that the setting is not on globally, which is not the
      // claim.
      //
      // Reuse is made certain rather than likely. Every connection of the app's
      // pool but one is checked out and held for the duration, so the report
      // below has exactly one connection it can possibly borrow, and the
      // checkout afterwards can only get that same one back. `pg_backend_pid()`
      // is compared across the two checkouts so the pinning is proven rather
      // than argued.
      const db = app.get<Database>(DATABASE_CONNECTION);
      const appPool = db.$client;
      const held: PoolClient[] = [];

      try {
        for (let i = 0; i < APP_POOL_MAX - 1; i += 1) {
          held.push(await appPool.connect());
        }

        const pinned = await appPool.connect();
        const pinnedPid = await backendPid(pinned);
        pinned.release();

        const master = await signInAsWorkingMaster();
        // An expired row, so the prune really deletes something on that
        // connection instead of matching nothing and proving nothing.
        await pool.query(
          `insert into master_locations (id, master_id, position, recorded_at)
           values (gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint(49.8, 40.4), 4326), now() - interval '3 hours')`,
          [master.masterId],
        );

        const reported = await post('/masters/me/location', master.accessToken).send(BAKU);
        expect(reported.status).toBe(200);
        expect(await positionsOf(master.masterId)).toHaveLength(1);

        const reused = await appPool.connect();
        try {
          expect(await backendPid(reused)).toBe(pinnedPid);
          await expect(
            reused.query('delete from master_locations where master_id = $1', [master.masterId]),
          ).rejects.toThrow(/append-only/);
        } finally {
          reused.release();
        }

        // Still there: the refusal was a refusal, not a partial delete.
        expect(await positionsOf(master.masterId)).toHaveLength(1);
      } finally {
        for (const client of held) {
          client.release();
        }
      }
    });

    it('opens the hatch as far as the cutoff and no further', async () => {
      // The setting carries a cutoff, not an on/off flag, and this is the
      // difference. With a flag, anything holding the permission could have run
      // an unqualified `DELETE FROM master_locations` and erased every master's
      // CURRENT position — the row dispatch reads. Retention never needs that:
      // it only ever needs to forget rows past a cutoff.
      //
      // Both halves are asserted on one connection under one setting, because
      // either alone is satisfiable by a trigger that is simply stricter or
      // simply laxer than this one.
      const master = await signInAsWorkingMaster();
      await post('/masters/me/location', master.accessToken).send(BAKU);
      await pool.query(
        `insert into master_locations (id, master_id, position, recorded_at)
         values (gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint(49.8, 40.4), 4326), now() - interval '3 hours')`,
        [master.masterId],
      );

      const client = await pool.connect();
      try {
        await client.query('begin');
        // The cutoff in exactly the form `pruneTrail` publishes it.
        await client.query(
          `select set_config('tezusta.location_retention',
                             (now() - make_interval(mins => 60))::text, true)`,
        );

        // Open: the expired row goes.
        const pruned = await client.query(
          `delete from master_locations
            where master_id = $1 and recorded_at < now() - make_interval(mins => 60)`,
          [master.masterId],
        );
        expect(pruned.rowCount).toBe(1);

        // And open only that far: the row still inside the window does not.
        await expect(
          client.query('delete from master_locations where master_id = $1', [master.masterId]),
        ).rejects.toThrow(/append-only/);
      } finally {
        await client.query('rollback');
        client.release();
      }

      expect(await positionsOf(master.masterId)).toHaveLength(2);
    });

    it('refuses an unqualified whole-table DELETE while retention is permitted', async () => {
      // The hazard the cutoff closes, stated as its own test: the statement
      // that would have wiped the table is refused by the trigger, not by
      // anybody remembering to add a `WHERE`.
      const master = await signInAsWorkingMaster();
      await post('/masters/me/location', master.accessToken).send(BAKU);

      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('tezusta.location_retention',
                             (now() - make_interval(mins => 60))::text, true)`,
        );

        await expect(client.query('delete from master_locations')).rejects.toThrow(/append-only/);
      } finally {
        await client.query('rollback');
        client.release();
      }

      expect(await positionsOf(master.masterId)).toHaveLength(1);
    });
  });

  describe('the index the product depends on (ADR-0018)', () => {
    it('answers ST_DWithin on the geography cast with master_locations_position_idx', async () => {
      const master = await signInAsWorkingMaster();
      await post('/masters/me/location', master.accessToken).send(BAKU);

      const client = await pool.connect();
      try {
        await client.query('begin');
        // Forces the planner away from a sequential scan so a table with a
        // handful of rows cannot "win" on cost alone. This proves the index
        // CAN answer the query — which is the thing ADR-0018 is about, since
        // an index on the bare geometry column simply cannot, and says nothing
        // when it fails to.
        await client.query('set local enable_seqscan = off');
        const plan = await client.query<{ 'QUERY PLAN': string }>(
          `explain select master_id from master_locations
            where ST_DWithin(position::geography,
                             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                             3000)`,
          [BAKU.longitude, BAKU.latitude],
        );
        const planText = plan.rows.map((row) => row['QUERY PLAN']).join('\n');

        expect(planText).toContain('master_locations_position_idx');
        expect(planText).not.toContain('Seq Scan');
      } finally {
        await client.query('rollback');
        client.release();
      }
    });
  });

  describe('coordinates never reach a log', () => {
    it('logs neither half of a reported position, on the happy path or the rejected one', async () => {
      const master = await signInAsWorkingMaster();

      const sink: string[] = [];
      const spies: MockInstance[] = spyOnEveryLogSink(sink);
      try {
        const accepted = await post('/masters/me/location', master.accessToken).send(BAKU);
        expect(accepted.status).toBe(200);

        // The rejected path too — and it is the more dangerous of the two: a
        // validation failure is exactly where an error handler is tempted to
        // print the body that caused it.
        const rejected = await post('/masters/me/location', master.accessToken).send({
          latitude: 95.123456,
          longitude: 199.654321,
        });
        expect(rejected.status).toBe(422);

        const logged = sink.join('\n');
        // Positive control and assertion in one: the rejection above *is*
        // logged, so a sink that captured nothing fails here rather than
        // passing the real assertions vacuously.
        expect(logged).toContain('VALIDATION_FAILED');
        for (const fragment of ['40.372613', '49.842717', '95.123456', '199.654321']) {
          expect(logged).not.toContain(fragment);
        }
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    });
  });
});
