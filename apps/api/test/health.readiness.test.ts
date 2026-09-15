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

const SENSITIVE_DRIVER_TEXT = 'password=hunter2 host=10.0.0.5 port=5432';

// Registers a failing check purely to exercise the registry's failure path —
// this stands in for the Postgres/Redis checks issue #22 wires the same way,
// via `HealthModule`'s exported `ReadinessCheckRegistry`, without editing
// HealthModule's own source.
@Injectable()
class FailingReadinessCheck implements OnModuleInit {
  constructor(private readonly registry: ReadinessCheckRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      name: 'flaky-dependency',
      check: () => Promise.reject(new Error(SENSITIVE_DRIVER_TEXT)),
    });
  }
}

@Module({
  imports: [HealthModule],
  providers: [FailingReadinessCheck],
})
class FailingCheckModule {}

describe('GET /health/ready with a failing dependency', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, FailingCheckModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 503 with a per-dependency "down" status, never the driver error text', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(503);
    const body = res.body as ReadinessReport;
    expect(body.status).toBe('degraded');
    expect(body.checks['flaky-dependency']).toEqual({ status: 'down' });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('10.0.0.5');
  });
});
