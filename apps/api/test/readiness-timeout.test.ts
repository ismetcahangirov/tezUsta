import type { OnModuleInit } from '@nestjs/common';
import { Injectable, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { HealthModule } from '../src/modules/health/health.module';
import type { ReadinessReport } from '../src/modules/health/health.types';
import { ReadinessCheckRegistry } from '../src/modules/health/readiness-check.registry';

/**
 * This test waits out a fixed window to prove something does NOT happen (or
 * that a timer fires), so most of its time is the wait itself, and it runs at
 * two to four seconds even alone. Its own ceiling rather than the global 5 s
 * (#356): a hang still fails; a busy machine adding a second does not.
 */
const WAITS_FOR_THE_PROBE_TIMEOUT_MS = 15_000;

/**
 * A dependency that has been black-holed does not refuse a connection — it
 * accepts the socket and never answers. A readiness check written against it
 * therefore never settles, and a probe that never settles is worse than one
 * that fails: the load balancer keeps the instance in rotation and it serves
 * errors to users. This check reproduces that shape exactly.
 */
@Injectable()
class HangingReadinessCheck implements OnModuleInit {
  constructor(private readonly registry: ReadinessCheckRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'black-holed-dependency',
      check: () => new Promise<void>(() => undefined),
    });
  }
}

@Module({
  imports: [HealthModule],
  providers: [HangingReadinessCheck],
})
class HangingCheckModule {}

describe('GET /health/ready with a dependency that never answers', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, HangingCheckModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it(
    'still answers, reporting the dependency down instead of hanging',
    async () => {
      const res = await request(app.getHttpServer()).get('/health/ready');

      expect(res.status).toBe(503);
      const body = res.body as ReadinessReport;
      expect(body.checks['black-holed-dependency']).toEqual({ status: 'down' });
    },
    WAITS_FOR_THE_PROBE_TIMEOUT_MS,
  );
});
