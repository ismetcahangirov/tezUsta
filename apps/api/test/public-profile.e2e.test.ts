import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { CursorPage, MasterPublicProfile, OrderStatus, PortfolioPost } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { AdminRepository } from '../src/modules/admin/admin.repository';
import { AdminSessionService } from '../src/modules/admin/admin-session.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

const REVIEW_WINDOW_HOURS = 168;

interface Person {
  readonly userId: string;
  readonly token: string;
  readonly profileId: string;
}

/**
 * A master's public profile and feed over HTTP (#310, ADR-0045 § 1–2): who
 * is answered, who gets the 404 a missing master gets, and that every
 * response is exactly the allow-listed fields.
 */
describe('public master profile and portfolio feed (issue #310)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let serviceId: string;
  let secondServiceId: string;
  let counter = 0;
  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  async function one<T>(query: string, params: unknown[]): Promise<T> {
    const { rows } = await pool.query(query, params);
    const row = rows[0] as T | undefined;
    if (row === undefined) {
      throw new Error(`No row from: ${query}`);
    }
    return row;
  }

  async function person(role: 'customer' | 'master', name = 'Aynur'): Promise<Person> {
    counter += 1;
    const created = await app.get(UsersRepository).create({
      phoneE164: `+99470${String(counter).padStart(7, '0')}`,
      roles: [role],
    });
    const table = role === 'customer' ? 'customers' : 'masters';
    const profile = await one<{ id: string }>(
      `insert into ${table} (id, user_id, display_name) values (gen_random_uuid(), $1, $2) returning id`,
      [created.user.id, name],
    );
    const pair = await app.get(SessionsService).startSession({ userId: created.user.id });
    return { userId: created.user.id, token: pair.accessToken, profileId: profile.id };
  }

  /** An active master offering one service, with a bio and an avatar. */
  async function activeMaster(): Promise<Person> {
    const master = await person('master', 'Usta Tural');
    await pool.query(
      `update masters
          set verification_status = 'active', bio = 'Santexnik, 12 il təcrübə',
              rating_sum = 9, rating_count = 2,
              avatar_thumb_key = 'avatars/' || $1::text || '/thumb.webp',
              avatar_display_key = 'avatars/' || $1::text || '/display.webp'
        where id = $1`,
      [master.profileId],
    );
    await pool.query(
      `insert into master_services (master_id, service_id, price_minor, is_active)
       values ($1, $2, 4500, true), ($1, $3, 9000, false)`,
      [master.profileId, serviceId, secondServiceId],
    );
    return master;
  }

  /** An order between the two, in `status`; a completed one completed `completedHoursAgo` ago. */
  async function order(
    customer: Person,
    master: Person | null,
    status: OrderStatus,
    completedHoursAgo = 1,
  ): Promise<string> {
    const address = await one<{ id: string }>(
      `insert into addresses (id, customer_id, formatted_address, position)
       values (gen_random_uuid(), $1, 'Bakı', ST_SetSRID(ST_MakePoint(49.86, 40.40), 4326)) returning id`,
      [customer.profileId],
    );
    const created = await one<{ id: string }>(
      `insert into orders (id, customer_id, address_id, service_id, master_id, status, description, idempotency_key)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 'Kran sızır.', $6) returning id`,
      [
        customer.profileId,
        address.id,
        serviceId,
        master?.profileId ?? null,
        status,
        `k-${randomUUID()}`,
      ],
    );
    if (status === 'COMPLETED') {
      await pool.query(
        `insert into order_status_history (id, order_id, from_status, to_status, actor_kind, created_at)
         values (gen_random_uuid(), $1, 'IN_PROGRESS', 'COMPLETED', 'system',
                 now() - make_interval(hours => $2))`,
        [created.id, completedHoursAgo],
      );
    }
    return created.id;
  }

  /** A post in `status` with `photos` ready photos, published `ageMinutes` ago. */
  async function post(
    master: Person,
    options: {
      status?: 'draft' | 'processing' | 'published' | 'failed' | 'deleted';
      photos?: number;
      ageMinutes?: number;
      serviceId?: string | null;
      removed?: boolean;
    } = {},
  ): Promise<string> {
    const status = options.status ?? 'published';
    const age = options.ageMinutes ?? 1;
    const created = await one<{ id: string }>(
      `insert into portfolio_posts (id, master_id, caption, service_id, status, media_count,
                                    published_at, deleted_at, created_at)
       values (gen_random_uuid(), $1, 'Hamam kranı', $2, $3::portfolio_post_status, $4,
               case when $3::text = 'published' then now() - make_interval(mins => $5) end,
               case when $3::text = 'deleted' then now() end,
               now() - make_interval(mins => $5))
       returning id`,
      [master.profileId, options.serviceId ?? null, status, options.photos ?? 1, age],
    );
    for (let position = 0; position < (options.photos ?? 1); position += 1) {
      await pool.query(
        `insert into portfolio_media (id, post_id, position, raw_storage_key, declared_content_type,
                                      verified_content_type, raw_size_bytes, status, presign_expires_at,
                                      thumb_key, display_key, width, height, bytes_total)
         values (gen_random_uuid(), $1::uuid, $2::int, 'portfolio-incoming/' || gen_random_uuid(), 'image/jpeg',
                 'image/jpeg', 1000, 'ready', now(),
                 'portfolio/' || $1::text || '-' || $2::text || '/thumb.webp',
                 'portfolio/' || $1::text || '-' || $2::text || '/display.webp', 1440, 1080, 3000)`,
        [created.id, position],
      );
    }
    if (options.removed === true) {
      const admin = await app.get(AdminRepository).createAdmin({
        email: `admin-${randomUUID()}@tezusta.az`,
        displayName: 'Nigar',
        roles: ['moderator'],
      });
      await pool.query(
        `update portfolio_posts set removed_at = now(), removed_by_admin_id = $2,
                removal_reason = 'Ev nömrəsi görünür' where id = $1`,
        [created.id, admin.id],
      );
    }
    return created.id;
  }

  function get(path: string, token?: string) {
    const pending = request(app.getHttpServer()).get(path);
    return token === undefined ? pending : pending.set('authorization', `Bearer ${token}`);
  }

  /** The error envelope minus its request id: the part a client could compare. */
  function envelope(body: unknown): unknown {
    const { error } = body as { error: Record<string, unknown> };
    const { requestId: _requestId, ...rest } = error;
    return rest;
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);
    set('DATABASE_URL', database.url);
    set('REVIEW_WINDOW_HOURS', String(REVIEW_WINDOW_HOURS));

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
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
    const services = await pool.query<{ id: string }>(
      `select id from services where is_active order by id limit 2`,
    );
    serviceId = services.rows[0]?.id ?? '';
    secondServiceId = services.rows[1]?.id ?? '';
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

  it('answers 401 without a token', async () => {
    const id = randomUUID();
    expect((await get(`/masters/${id}/profile`)).status).toBe(401);
    expect((await get(`/masters/${id}/portfolio`)).status).toBe(401);
  });

  describe('what the customer of an order with the master sees', () => {
    it('the profile, exactly the fields of ADR-0045 § 1 and nothing else', async () => {
      const master = await activeMaster();
      const customer = await person('customer');
      await order(customer, master, 'MASTER_ON_THE_WAY');
      const shown = await post(master, { photos: 2, ageMinutes: 5, serviceId });
      await post(master, { status: 'draft' });
      await post(master, { status: 'processing' });
      await post(master, { status: 'failed' });
      await post(master, { status: 'deleted' });
      await post(master, { removed: true });

      const res = await get(`/masters/${master.profileId}/profile`, customer.token);

      expect(res.status).toBe(200);
      const profile = res.body as MasterPublicProfile;
      // Allow-lists, not deny-lists: a field anyone adds later fails here.
      expect(Object.keys(profile).sort()).toEqual(
        [
          'avatarLargeUrl',
          'avatarUrl',
          'bio',
          'displayName',
          'masterId',
          'nextCursor',
          'posts',
          'rating',
          'services',
        ].sort(),
      );
      expect(Object.keys(profile.rating).sort()).toEqual(['ratingAverage', 'ratingCount']);
      expect(profile).toMatchObject({
        masterId: master.profileId,
        displayName: 'Usta Tural',
        bio: 'Santexnik, 12 il təcrübə',
        rating: { ratingAverage: 4.5, ratingCount: 2 },
        nextCursor: null,
      });
      expect(profile.avatarUrl).toMatch(/^https:\/\/.+\/avatars\/.+\/thumb\.webp$/);
      expect(profile.avatarLargeUrl).toMatch(/^https:\/\/.+\/avatars\/.+\/display\.webp$/);
      // The inactive offer is not on the profile.
      expect(profile.services).toHaveLength(1);
      expect(Object.keys(profile.services[0] ?? {}).sort()).toEqual([
        'name',
        'priceMinor',
        'serviceId',
      ]);
      expect(profile.services[0]).toMatchObject({ serviceId, priceMinor: 4500 });

      // Only the published, unremoved post.
      expect(profile.posts.map((item) => item.id)).toEqual([shown]);
      const [first] = profile.posts;
      expect(Object.keys(first ?? {}).sort()).toEqual(['caption', 'id', 'media', 'service']);
      expect(first?.service).toMatchObject({ serviceId });
      expect(Object.keys(first?.service ?? {}).sort()).toEqual(['name', 'serviceId']);
      expect(first?.media).toHaveLength(2);
      expect(Object.keys(first?.media[0] ?? {}).sort()).toEqual(
        ['displayUrl', 'height', 'id', 'thumbUrl', 'width'].sort(),
      );

      // Nothing that names a person, a place or a storage object.
      const text = JSON.stringify(profile);
      for (const forbidden of [
        '+994',
        'portfolio-incoming',
        'customerId',
        'orderId',
        'phone',
        'verification',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    });

    it.each(['ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS'] as const)(
      'while the order is %s',
      async (status) => {
        const master = await activeMaster();
        const customer = await person('customer');
        await order(customer, master, status);
        expect((await get(`/masters/${master.profileId}/profile`, customer.token)).status).toBe(
          200,
        );
      },
    );

    it('after completion, until the review window closes', async () => {
      const master = await activeMaster();
      const recent = await person('customer');
      await order(recent, master, 'COMPLETED', REVIEW_WINDOW_HOURS - 1);
      const late = await person('customer');
      await order(late, master, 'COMPLETED', REVIEW_WINDOW_HOURS + 1);

      expect((await get(`/masters/${master.profileId}/profile`, recent.token)).status).toBe(200);
      expect((await get(`/masters/${master.profileId}/profile`, late.token)).status).toBe(404);
    });

    it('follows a re-dispatch: the master who left loses the profile, the one who accepted gains it', async () => {
      const first = await activeMaster();
      const second = await activeMaster();
      const customer = await person('customer');
      const orderId = await order(customer, first, 'ACCEPTED');
      expect((await get(`/masters/${first.profileId}/profile`, customer.token)).status).toBe(200);

      // Sent back out, then accepted by someone else.
      await pool.query(`update orders set master_id = $2, status = 'ACCEPTED' where id = $1`, [
        orderId,
        second.profileId,
      ]);

      expect((await get(`/masters/${first.profileId}/profile`, customer.token)).status).toBe(404);
      expect((await get(`/masters/${second.profileId}/profile`, customer.token)).status).toBe(200);
    });

    it('keeps a completed order that went to dispute visible inside the window, and not after', async () => {
      const master = await activeMaster();
      const inside = await person('customer');
      const insideOrder = await order(inside, master, 'COMPLETED', 2);
      const outside = await person('customer');
      const outsideOrder = await order(outside, master, 'COMPLETED', REVIEW_WINDOW_HOURS + 2);
      await pool.query(`update orders set status = 'DISPUTED' where id = any($1::uuid[])`, [
        [insideOrder, outsideOrder],
      ]);

      expect((await get(`/masters/${master.profileId}/profile`, inside.token)).status).toBe(200);
      expect((await get(`/masters/${master.profileId}/profile`, outside.token)).status).toBe(404);
    });

    it('answers a customer with an old cancelled order and a current one with the same master', async () => {
      const master = await activeMaster();
      const customer = await person('customer');
      await order(customer, master, 'CANCELLED');
      await order(customer, master, 'MASTER_ARRIVED');
      expect((await get(`/masters/${master.profileId}/profile`, customer.token)).status).toBe(200);
    });

    it('drops a service the catalogue retired, from the services and from a post’s tag', async () => {
      const master = await activeMaster();
      const customer = await person('customer');
      await order(customer, master, 'ACCEPTED');
      await post(master, { serviceId });
      await pool.query(`update services set is_active = false where id = $1`, [serviceId]);
      try {
        const profile = (await get(`/masters/${master.profileId}/profile`, customer.token))
          .body as MasterPublicProfile;
        expect(profile.services).toEqual([]);
        expect(profile.posts[0]?.service).toBeNull();
      } finally {
        await pool.query(`update services set is_active = true where id = $1`, [serviceId]);
      }
    });

    it('hides a post’s tag while the master no longer offers that service, and shows it again after', async () => {
      const master = await activeMaster();
      const customer = await person('customer');
      await order(customer, master, 'ACCEPTED');
      await post(master, { serviceId });
      const path = `/masters/${master.profileId}/portfolio`;

      await pool.query(
        `update master_services set is_active = false where master_id = $1 and service_id = $2`,
        [master.profileId, serviceId],
      );
      expect(
        ((await get(path, customer.token)).body as CursorPage<PortfolioPost>).items[0]?.service,
      ).toBeNull();

      await pool.query(
        `update master_services set is_active = true where master_id = $1 and service_id = $2`,
        [master.profileId, serviceId],
      );
      expect(
        ((await get(path, customer.token)).body as CursorPage<PortfolioPost>).items[0]?.service,
      ).toMatchObject({
        serviceId,
      });
    });
  });

  describe('everyone else gets the 404 a missing master gets', () => {
    it('a customer with no order, an order still searching, or one cancelled after accept; another master', async () => {
      const master = await activeMaster();
      const missing = await get(
        `/masters/${randomUUID()}/profile`,
        (await person('customer')).token,
      );
      expect(missing.status).toBe(404);

      const stranger = await person('customer');
      const searching = await person('customer');
      await order(searching, null, 'SEARCHING');
      const cancelled = await person('customer');
      await order(cancelled, master, 'CANCELLED');
      const otherMaster = await activeMaster();

      for (const caller of [stranger, searching, cancelled, otherMaster]) {
        for (const path of [
          `/masters/${master.profileId}/profile`,
          `/masters/${master.profileId}/portfolio`,
        ]) {
          const res = await get(path, caller.token);
          expect(res.status, path).toBe(404);
          expect(envelope(res.body)).toEqual(envelope(missing.body));
        }
      }
    });

    it.each([
      ['pending verification', `verification_status = 'pending_verification'`],
      ['changes requested', `verification_status = 'changes_requested'`],
      ['rejected', `verification_status = 'rejected'`],
      ['suspended', `verification_status = 'suspended', suspended_at = now()`],
      ['deleted', `deleted_at = now()`],
    ])('a master who is %s, even to the customer on their order', async (_label, change) => {
      const master = await activeMaster();
      const customer = await person('customer');
      await order(customer, master, 'IN_PROGRESS');
      const missing = await get(`/masters/${randomUUID()}/profile`, customer.token);
      await pool.query(`update masters set ${change} where id = $1`, [master.profileId]);

      const res = await get(`/masters/${master.profileId}/profile`, customer.token);
      expect(res.status).toBe(404);
      expect(envelope(res.body)).toEqual(envelope(missing.body));
    });

    it('a master whose account is suspended', async () => {
      const master = await activeMaster();
      const customer = await person('customer');
      await order(customer, master, 'IN_PROGRESS');
      const missing = await get(`/masters/${randomUUID()}/profile`, customer.token);
      await pool.query(`update users set status = 'suspended' where id = $1`, [master.userId]);

      const res = await get(`/masters/${master.profileId}/profile`, customer.token);
      expect(res.status).toBe(404);
      expect(envelope(res.body)).toEqual(envelope(missing.body));
    });

    it('an admin token is not a signed-in user here', async () => {
      const master = await activeMaster();
      const admin = await app.get(AdminRepository).createAdmin({
        email: `admin-${randomUUID()}@tezusta.az`,
        displayName: 'Nigar',
        roles: ['super_admin'],
      });
      const token = (await app.get(AdminSessionService).start(admin.id)).accessToken;
      expect((await get(`/masters/${master.profileId}/profile`, token)).status).toBe(401);
    });
  });

  it('lets the master preview their own profile', async () => {
    const master = await activeMaster();
    expect((await get(`/masters/${master.profileId}/profile`, master.token)).status).toBe(200);
  });

  describe('the feed', () => {
    it('pages newest first, 18 by default, and stays stable when a post is published between pages', async () => {
      const master = await activeMaster();
      const customer = await person('customer');
      await order(customer, master, 'ACCEPTED');
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        // Older first, so `ids` ends newest-last.
        ids.push(await post(master, { ageMinutes: 100 - i }));
      }
      const newestFirst = [...ids].reverse();
      const path = `/masters/${master.profileId}/portfolio`;

      const profile = (await get(`/masters/${master.profileId}/profile`, customer.token))
        .body as MasterPublicProfile;
      expect(profile.posts.map((item) => item.id)).toEqual(newestFirst.slice(0, 18));
      expect(profile.nextCursor).not.toBeNull();

      const first = (await get(`${path}?limit=5`, customer.token))
        .body as CursorPage<PortfolioPost>;
      expect(first.items.map((item) => item.id)).toEqual(newestFirst.slice(0, 5));

      // A new post lands on top; the next page carries on where the first stopped.
      await post(master, { ageMinutes: 0 });
      const second = (
        await get(
          `${path}?limit=5&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
          customer.token,
        )
      ).body as CursorPage<PortfolioPost>;
      expect(second.items.map((item) => item.id)).toEqual(newestFirst.slice(5, 10));

      const rest = (
        await get(
          `${path}?limit=30&cursor=${encodeURIComponent(second.nextCursor ?? '')}`,
          customer.token,
        )
      ).body as CursorPage<PortfolioPost>;
      expect(rest.items.map((item) => item.id)).toEqual(newestFirst.slice(10));
      expect(rest.nextCursor).toBeNull();
    });

    it('splits two posts published in the same instant across pages without losing or repeating either', async () => {
      const master = await activeMaster();
      const customer = await person('customer');
      await order(customer, master, 'ACCEPTED');
      const a = await post(master, { ageMinutes: 10 });
      const b = await post(master, { ageMinutes: 10 });
      const c = await post(master, { ageMinutes: 20 });
      await pool.query(
        `update portfolio_posts set published_at = (select published_at from portfolio_posts where id = $1)
          where id = $2`,
        [a, b],
      );
      const path = `/masters/${master.profileId}/portfolio`;

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string =
          cursor === null ? '?limit=1' : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
        const page = (await get(`${path}${query}`, customer.token))
          .body as CursorPage<PortfolioPost>;
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null);

      expect(seen).toHaveLength(3);
      expect(new Set(seen)).toEqual(new Set([a, b, c]));
      expect(seen.at(-1)).toBe(c);
    });

    it('validates its query', async () => {
      const master = await activeMaster();
      const customer = await person('customer');
      await order(customer, master, 'ACCEPTED');
      const path = `/masters/${master.profileId}/portfolio`;
      for (const query of ['limit=0', 'limit=31', 'status=draft']) {
        expect((await get(`${path}?${query}`, customer.token)).status, query).toBe(422);
      }
      expect((await get('/masters/not-a-uuid/profile', customer.token)).status).toBe(422);
      await post(master);
      const first = (await get(path, customer.token)).body as CursorPage<PortfolioPost>;
      const garbage = (await get(`${path}?cursor=not-a-cursor`, customer.token))
        .body as CursorPage<PortfolioPost>;
      expect(garbage.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
      // A well-formed cursor naming another master's post is no position in this feed.
      const other = await activeMaster();
      const foreign = Buffer.from(JSON.stringify({ p: await post(other) })).toString('base64url');
      const fromForeign = (await get(`${path}?cursor=${foreign}`, customer.token))
        .body as CursorPage<PortfolioPost>;
      expect(fromForeign.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    });
  });
});
