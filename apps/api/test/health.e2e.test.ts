import { Controller, Get, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';
import { Public } from '../src/modules/auth/public.decorator';
import type { ReadinessReport } from '../src/modules/health/health.types';

// A route that throws, used only to exercise the global exception filter's
// "unexpected error" path. It never ships in production source — it is
// registered into this test's own Nest module, alongside AppModule.
const THROWN_MESSAGE = 'boom-from-debug-route-should-never-reach-the-client';

@Controller('__test-only')
class ThrowingController {
  // `@Public()` because AppModule's global `AuthenticationGuard` (issue #27)
  // protects every route that does not say otherwise — including this one, and
  // including routes registered by a test's own module. Without it this route
  // answers 401 before the handler runs, and the assertions below would be
  // testing the guard rather than the exception filter they exist for. That the
  // default is "protected" is asserted directly in `auth.guards.e2e.test.ts`.
  @Public()
  @Get('explode')
  explode(): never {
    throw new Error(THROWN_MESSAGE);
  }
}

@Module({ controllers: [ThrowingController] })
class DebugModule {}

describe('API bootstrap wiring (health, error envelope, request id)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DebugModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // No request-id registration here: `RequestIdHook` is an `AppModule`
    // provider and installs Fastify's `onRequest` hook itself (issue #47), so
    // this test exercises the shipped wiring rather than its own copy of it.
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(new ZodValidationPipe());

    await app.init();
    // Fastify routes are not guaranteed registered until the underlying
    // instance is ready — without this, supertest hits them intermittently
    // with a 404.
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 on GET /health/live without checking any dependency', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports a postgres and a redis check on GET /health/ready (issue #22)', async () => {
    // This is EPIC 1's acceptance criterion in test form: "the API boots and
    // /health/ready reports Postgres and Redis reachable". It asserts `up`
    // rather than merely "some status", because the whole point of the probe
    // is the difference. Like every other integration test here it requires a
    // real Postgres and Redis — `docker compose up -d` locally, service
    // containers in CI. If they are not there this fails loudly, which is the
    // intent: a readiness test that tolerates a missing dependency tests
    // nothing (docs/engineering/testing-strategy.md).
    // `database.readiness.test.ts` covers the down path.
    const res = await request(app.getHttpServer()).get('/health/ready');
    const body = res.body as ReadinessReport;

    // `queue` joined the set in issue #102: `QueueModule` registers the BullMQ
    // connection the same way this module's comment describes, and the assertion
    // stays exhaustive on purpose — a check that silently stops being registered
    // is exactly the regression this list exists to catch.
    expect(Object.keys(body.checks).sort()).toEqual(['postgres', 'queue', 'redis']);
    expect(body.checks.postgres).toEqual({ status: 'up' });
    expect(body.checks.redis).toEqual({ status: 'up' });
    expect(body.checks.queue).toEqual({ status: 'up' });
    expect(res.status).toBe(200);
  });

  it('returns a generic 500 envelope for an unexpected error, with no internal detail leaked', async () => {
    const res = await request(app.getHttpServer()).get('/__test-only/explode');

    expect(res.status).toBe(500);
    const body = res.body as ErrorEnvelope;
    expect(body.error.code).toBe('INTERNAL_ERROR');

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(THROWN_MESSAGE);
    expect(raw.toLowerCase()).not.toContain('.ts:');
    expect(raw.toLowerCase()).not.toContain('at object.');
  });

  it('sets the x-request-id response header and echoes the same id in the error envelope', async () => {
    const res = await request(app.getHttpServer()).get('/__test-only/explode');

    const headerId = res.headers['x-request-id'];
    expect(typeof headerId).toBe('string');
    expect(String(headerId).length).toBeGreaterThan(0);
    const body = res.body as ErrorEnvelope;
    expect(body.error.requestId).toBe(headerId);
  });

  it('accepts and echoes back a well-formed inbound x-request-id', async () => {
    const inboundId = 'client-generated-id-123';

    const res = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-request-id', inboundId);

    expect(res.headers['x-request-id']).toBe(inboundId);
  });

  it('rejects a malformed/spoofed inbound x-request-id and replaces it with a fresh one', async () => {
    const spoofed = 'not-safe: <script>alert(1)</script> X-Injected: evil';

    const res = await request(app.getHttpServer()).get('/health/live').set('x-request-id', spoofed);

    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).not.toBe(spoofed);
  });
});
