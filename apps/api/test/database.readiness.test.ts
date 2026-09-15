import { Global, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../src/infra/config/config.tokens';
import { parseEnv } from '../src/infra/config/parse-env';
import { DatabaseModule } from '../src/infra/database/database.module';
import { HealthModule } from '../src/modules/health/health.module';
import type { ReadinessReport } from '../src/modules/health/health.types';

// Nothing listens here on a CI runner or a dev machine, so connecting fails
// fast with ECONNREFUSED instead of hanging until the health check's own 2s
// timeout — this test is about the "down" *response shape*, not about
// exercising that timeout (readiness-timeout.test.ts already covers that).
const UNREACHABLE_DATABASE_URL = 'postgresql://tezusta:tezusta@127.0.0.1:1/tezusta';

/**
 * A real `AppConfig`, built by the SAME `parseEnv` the app uses (never a
 * hand-rolled object that could drift from the real shape), with only
 * `DATABASE_URL` overridden. `test/setup-env.ts` already guarantees every
 * other variable `parseEnv` requires is present.
 */
const unreachablePostgresConfig = parseEnv({
  ...process.env,
  DATABASE_URL: UNREACHABLE_DATABASE_URL,
});

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useValue: unreachablePostgresConfig }],
  exports: [APP_CONFIG],
})
class UnreachablePostgresConfigModule {}

describe('a Postgres connection failure, surfaced through /health/ready', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // DatabaseModule only, not the full AppModule/RedisModule: isolates the
    // assertion to the `postgres` check this module registers, independent
    // of whatever Redis happens to be reachable in the environment running
    // this test.
    const moduleRef = await Test.createTestingModule({
      imports: [UnreachablePostgresConfigModule, HealthModule, DatabaseModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports 503 with postgres down, and leaks no driver/connection detail', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(503);
    const body = res.body as ReadinessReport;
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres).toEqual({ status: 'down' });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('ECONNREFUSED');
    expect(raw).not.toContain('127.0.0.1');
    expect(raw).not.toContain('tezusta:tezusta');
  });
});
