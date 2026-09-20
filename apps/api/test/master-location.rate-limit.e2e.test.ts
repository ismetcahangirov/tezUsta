import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { expectLoggerIsListening, spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The location-reporting budget, in its own file (issue #98) — the same split
 * `orders.rate-limit.e2e.test.ts` makes, and for the same reason: in
 * `master-location.e2e.test.ts` the number is an obstacle, and here it is the
 * subject.
 *
 * **What this budget defends is unusual and worth naming.** It is not a bill
 * and not a credential: `docs/architecture/realtime-architecture.md` says
 * location updates are "a budget, not a stream" and that the server decides
 * the interval. Without an enforced limit that sentence is advice an app can
 * ignore with one bad `setInterval`, and every ignored report writes another
 * row of somebody's movements into the most sensitive table in the schema.
 * So this suite is as much a privacy test as a throttling one.
 *
 * The per-IP half of every policy is shared by every process talking to this
 * Redis from `127.0.0.1` — including the other location suite, and including a
 * previous run of this one. What keeps this suite's counters its own is the
 * per-file `RATE_LIMIT_KEY_SECRET` that `setup-env.ts` generates (issue #108),
 * not anything this file does.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99458${String(phoneCounter).padStart(7, '0')}`;
}

const REPORTS_ALLOWED_PER_HOUR = 3;
const BAKU = { latitude: 40.409264, longitude: 49.867092 };

describe('master location reporting is rate limited (issue #98)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let usersRepo: UsersRepository;
  let sessionsService: SessionsService;
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

  /** A verified master who is switched on — the only state that may report. */
  async function signInAsWorkingMaster(): Promise<{ accessToken: string; phoneE164: string }> {
    const phoneE164 = nextPhone();
    const created = await usersRepo.create({ phoneE164, roles: [] });
    const pair = await sessionsService.startSession({ userId: created.user.id });

    const profile = await post('/masters', pair.accessToken).send({ displayName: 'Usta Rəşad' });
    expect(profile.status).toBe(201);
    await pool.query(`update masters set verification_status = 'active' where id = $1`, [
      (profile.body as { id: string }).id,
    ]);

    const online = await post('/masters/me/availability', pair.accessToken).send({
      isAvailable: true,
    });
    expect(online.status).toBe(200);

    return { accessToken: pair.accessToken, phoneE164 };
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    set('DATABASE_URL', database.url);
    set('MASTER_LOCATION_RATE_LIMIT_PER_USER_HOUR', String(REPORTS_ALLOWED_PER_HOUR));
    // Well above the per-master budget, so the test below is unambiguously
    // measuring the per-master half rather than accidentally tripping the
    // other — which is the half that is deliberately loose in production,
    // because a carrier NAT hides an unknown number of masters behind one IP.
    set('MASTER_LOCATION_RATE_LIMIT_PER_IP_HOUR', '1000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Load-bearing, and it was missing until #127. `Test.createTestingModule`
      // installs Nest's `TestingLogger`, whose `log`, `warn` and `debug` are
      // empty bodies — and the rate-limit security event this suite triggers
      // is written at `warn` (`common/guards/rate-limit.guard.ts`). Without a
      // real logger the assertions below would be reading an empty array and
      // agreeing with it.
      .setLogger(new ConsoleLogger())
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepo = app.get(UsersRepository);
    sessionsService = app.get(SessionsService);
    pool = new Pool({ connectionString: database.url });
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

  it('answers 429 once the master has spent their hourly budget', async () => {
    const { accessToken } = await signInAsWorkingMaster();

    for (let attempt = 0; attempt < REPORTS_ALLOWED_PER_HOUR; attempt += 1) {
      const res = await post('/masters/me/location', accessToken).send(BAKU);
      expect(res.status).toBe(200);
    }

    const refused = await post('/masters/me/location', accessToken).send(BAKU);

    expect(refused.status).toBe(429);
    // The header only exists on a real reply, which is why this suite goes
    // over HTTP rather than calling the guard.
    expect(refused.headers['retry-after']).toBeDefined();
  });

  it("spends one master's budget without touching another's", async () => {
    const { accessToken: spent } = await signInAsWorkingMaster();
    const { accessToken: fresh } = await signInAsWorkingMaster();

    for (let attempt = 0; attempt < REPORTS_ALLOWED_PER_HOUR + 1; attempt += 1) {
      await post('/masters/me/location', spent).send(BAKU);
    }

    const res = await post('/masters/me/location', fresh).send(BAKU);

    expect(res.status).toBe(200);
  });

  describe('the refusal is logged as a security event, and carries no PII', () => {
    let sink: string[];
    let spies: MockInstance[];

    beforeEach(() => {
      sink = [];
      spies = spyOnEveryLogSink(sink);
    });

    afterEach(() => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    });

    it('writes the trigger, and never the phone number, the IP or the coordinates', async () => {
      // `docs/engineering/security.md` § Logging requires rate-limit triggers
      // to stay logged, and requires full phone numbers and precise
      // coordinates never to be. Both halves are asserted here because only
      // the first makes the second mean anything: a suite that captured
      // nothing would satisfy "no coordinate was logged" perfectly.
      expectLoggerIsListening(sink, 'master-location.rate-limit.e2e.test');

      const { accessToken, phoneE164 } = await signInAsWorkingMaster();
      for (let attempt = 0; attempt < REPORTS_ALLOWED_PER_HOUR; attempt += 1) {
        await post('/masters/me/location', accessToken).send(BAKU);
      }

      const refused = await post('/masters/me/location', accessToken).send(BAKU);
      expect(refused.status).toBe(429);

      const logged = sink.join('\n');

      // Positive control on the real line: the guard's own security event,
      // at `warn`, plus the filter's 429 line behind it.
      expect(logged).toContain('rate limit exceeded');
      expect(logged).toContain('policy=location-report');
      expect(logged).toContain('RATE_LIMITED');

      // The subject reaches the log only as its keyed digest.
      expect(logged).not.toContain(phoneE164);
      expect(logged).not.toContain(phoneE164.slice(-9));
      expect(logged).not.toContain(String(BAKU.latitude));
      expect(logged).not.toContain(String(BAKU.longitude));
    });
  });
});
