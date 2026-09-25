import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { signHs256 } from '../src/common/crypto/hs256-jwt';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { runSeed } from '../src/infra/database/seed';
import { CONSUMER_TOKEN_AUDIENCE, CONSUMER_TOKEN_ISSUER } from '../src/modules/auth/auth.types';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The order-creation budget, in its own file (issue #81).
 *
 * `orders.e2e.test.ts` raises the limit out of its own way, because there the
 * number is an obstacle rather than the subject. Here it is the subject, so
 * this suite sets it to something small and proves the guard actually answers
 * 429 through the real filter, with `Retry-After` on the reply.
 *
 * **The key space that makes the number below mean what it says is arranged
 * once, in `setup-env.ts`** (issue #108), not here. Every counter is keyed by
 * an HMAC under `RATE_LIMIT_KEY_SECRET`, and the per-IP half of a policy is
 * shared by every process talking to this Redis from `127.0.0.1` — including
 * the other orders suite, and including a previous run of this one. The setup
 * file generates a pepper per test file, so this suite's budget is its own
 * without it having to remember to ask.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99452${String(phoneCounter).padStart(7, '0')}`;
}

const ORDERS_ALLOWED_PER_HOUR = 3;

describe('order creation is rate limited (issue #81)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
  let serviceId: string;
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

  async function signInAsCustomer(): Promise<{
    accessToken: string;
    addressId: string;
    userId: string;
  }> {
    const created = await usersRepo.create({ phoneE164: nextPhone(), roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });

    const profile = await post('/customers', pair.accessToken).send({ displayName: 'Müştəri' });
    expect(profile.status).toBe(201);

    const address = await post('/addresses', pair.accessToken).send({
      formattedAddress: 'Nizami küçəsi 203',
      latitude: 40.409264,
      longitude: 49.867092,
    });
    expect(address.status).toBe(201);

    return {
      accessToken: pair.accessToken,
      addressId: (address.body as { id: string }).id,
      userId: created.user.id,
    };
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);
    await runSeed(database.url);

    set('DATABASE_URL', database.url);
    set('ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR', String(ORDERS_ALLOWED_PER_HOUR));
    // Well above the per-user budget, so the test below is unambiguously
    // measuring the per-user half rather than accidentally tripping the other.
    set('ORDER_CREATE_RATE_LIMIT_PER_IP_HOUR', '1000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);

    const { rows } = await pool.query<{ id: string }>(
      `select id from services where is_active order by id limit 1`,
    );
    const seeded = rows[0]?.id;
    if (seeded === undefined) {
      throw new Error('the seed should have provided at least one active service');
    }
    serviceId = seeded;
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

  it('answers 429 once the customer has spent their hourly budget', async () => {
    const customer = await signInAsCustomer();

    for (let attempt = 0; attempt < ORDERS_ALLOWED_PER_HOUR; attempt += 1) {
      const res = await post('/orders', customer.accessToken).send({
        serviceId,
        addressId: customer.addressId,
        description: 'Hamamda su axır, təcili usta lazımdır.',
        idempotencyKey: randomUUID(),
      });
      expect(res.status).toBe(201);
    }

    const refused = await post('/orders', customer.accessToken).send({
      serviceId,
      addressId: customer.addressId,
      description: 'Hamamda su axır, təcili usta lazımdır.',
      idempotencyKey: randomUUID(),
    });

    expect(refused.status).toBe(429);
    // The header only exists on a real reply, which is why this suite goes
    // over HTTP rather than calling the guard.
    expect(refused.headers['retry-after']).toBeDefined();
  });

  it('spends one customer’s budget without touching another’s', async () => {
    const spent = await signInAsCustomer();
    const fresh = await signInAsCustomer();

    for (let attempt = 0; attempt < ORDERS_ALLOWED_PER_HOUR + 1; attempt += 1) {
      await post('/orders', spent.accessToken).send({
        serviceId,
        addressId: spent.addressId,
        description: 'Qapının kilidi işləmir, açıla bilmir.',
        idempotencyKey: randomUUID(),
      });
    }

    const res = await post('/orders', fresh.accessToken).send({
      serviceId,
      addressId: fresh.addressId,
      description: 'Qapının kilidi işləmir, açıla bilmir.',
      idempotencyKey: randomUUID(),
    });

    expect(res.status).toBe(201);
  });

  it('never charges a forged token to the account its `sub` names (issue #271)', async () => {
    const victim = await signInAsCustomer();

    // Claims shaped exactly like a real access token's, naming the victim, so
    // the only thing wrong with them is that this server never signed them.
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: victim.userId,
      sid: randomUUID(),
      roles: ['customer'],
      iss: CONSUMER_TOKEN_ISSUER,
      aud: CONSUMER_TOKEN_AUDIENCE,
      iat: now,
      exp: now + 900,
    };
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const forgeries = [
      // Signed under a key this server does not hold.
      signHs256(claims, `not-the-access-secret-${randomUUID()}`),
      // No signature at all.
      `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`,
    ];

    // More forged requests than the victim's whole budget. Each one is
    // refused by authentication — and, the property under test, none of them
    // is counted against the victim on the way there.
    for (const forged of forgeries) {
      for (let attempt = 0; attempt < ORDERS_ALLOWED_PER_HOUR + 1; attempt += 1) {
        const res = await post('/orders', forged).send({
          serviceId,
          addressId: victim.addressId,
          description: 'Kombi işləmir, evdə isti su yoxdur.',
          idempotencyKey: randomUUID(),
        });
        expect(res.status).toBe(401);
      }
    }

    // The victim still has every order of their budget, and a valid token is
    // still counted against its own user: the one after the budget is refused.
    for (let attempt = 0; attempt < ORDERS_ALLOWED_PER_HOUR; attempt += 1) {
      const res = await post('/orders', victim.accessToken).send({
        serviceId,
        addressId: victim.addressId,
        description: 'Kombi işləmir, evdə isti su yoxdur.',
        idempotencyKey: randomUUID(),
      });
      expect(res.status).toBe(201);
    }

    const refused = await post('/orders', victim.accessToken).send({
      serviceId,
      addressId: victim.addressId,
      description: 'Kombi işləmir, evdə isti su yoxdur.',
      idempotencyKey: randomUUID(),
    });
    expect(refused.status).toBe(429);
  });
});
