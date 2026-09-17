import { Controller, Get, Module, Req } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyRequest } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { Public } from '../src/modules/auth/public.decorator';

/**
 * Issue #47. `RequestIdInterceptor` covered everything that reached a
 * controller and nothing else: Nest answers an unmatched route through
 * `registerNotFoundHandler` and an adapter-layer failure through
 * `registerExceptionHandler`, and both build a filter chain but no interceptor
 * chain. A 404 therefore carried no `x-request-id` header at all and an
 * envelope that said `"requestId": "unknown"` — no correlation exactly where a
 * scanner, a misrouted client or a stale mobile route lands.
 *
 * These assertions are about the *mechanism*, not about any endpoint: what they
 * prove is that the id is assigned before routing decides anything, so they are
 * written against a route that does not exist as much as against one that does.
 */

const UNMATCHED_PATH = '/no-such-route-exists-here';

@Controller('__request-id')
class RequestIdEchoController {
  // Public for the same reason as in `health.e2e.test.ts`: AppModule protects
  // every route that does not say otherwise (issue #27), and a 401 here would
  // test the guard instead of the hook.
  @Public()
  @Get('echo')
  echo(@Req() req: FastifyRequest): { requestId: string } {
    // Read straight off the request, which is what every log line and the
    // exception filter read. If the hook did not run, this is `undefined` and
    // the comparison against the response header below fails.
    return { requestId: req.requestId };
  }
}

@Module({ controllers: [RequestIdEchoController] })
class RequestIdEchoModule {}

describe('request id correlation (issue #47)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, RequestIdEchoModule],
    }).compile();

    // Nothing is registered onto `app` here on purpose. The filter, the pipe
    // and the request-id hook are all AppModule providers, so this is the
    // shipped wiring — a test that installed its own would prove nothing about
    // what runs in production.
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an unmatched route with a request id in both the header and the envelope', async () => {
    const res = await request(app.getHttpServer()).get(UNMATCHED_PATH);

    expect(res.status).toBe(404);

    const headerId = res.headers['x-request-id'];
    expect(typeof headerId).toBe('string');
    expect(String(headerId).length).toBeGreaterThan(0);

    const body = res.body as ErrorEnvelope;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(headerId);
    expect(body.error.requestId).not.toBe('unknown');
  });

  it('no longer echoes the requested path back in the 404 body', async () => {
    const probe = '/etc/passwd-<script>alert(1)</script>';

    const res = await request(app.getHttpServer()).get(probe);

    expect(res.status).toBe(404);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('passwd');
    expect(raw).not.toContain('script');
    expect(raw).not.toContain('Cannot GET');
  });

  it('honours a well-formed inbound x-request-id on the unmatched-route path too', async () => {
    const inboundId = 'client-generated-id-456';

    const res = await request(app.getHttpServer())
      .get(UNMATCHED_PATH)
      .set('x-request-id', inboundId);

    expect(res.headers['x-request-id']).toBe(inboundId);
    expect((res.body as ErrorEnvelope).error.requestId).toBe(inboundId);
  });

  it('replaces a malformed inbound x-request-id on the unmatched-route path too', async () => {
    const spoofed = 'not-safe: <script>alert(1)</script> X-Injected: evil';

    const res = await request(app.getHttpServer()).get(UNMATCHED_PATH).set('x-request-id', spoofed);

    const headerId = res.headers['x-request-id'];
    expect(headerId).toBeDefined();
    expect(headerId).not.toBe(spoofed);
    expect((res.body as ErrorEnvelope).error.requestId).toBe(headerId);
    // The spoofed value must not survive into the body either — it is the
    // string an attacker chose, and the envelope is served from our origin.
    expect(JSON.stringify(res.body)).not.toContain('X-Injected');
  });

  it('assigns exactly one id to a request that reaches a controller', async () => {
    const res = await request(app.getHttpServer()).get('/__request-id/echo');

    expect(res.status).toBe(200);
    const body = res.body as { requestId: string };
    // The guard chain, the handler and the response header all agree: one
    // request, one id. A second assignment anywhere would show up here as a
    // header that does not match what the handler saw.
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });

  it('gives two concurrent requests two different ids', async () => {
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).get('/__request-id/echo'),
      request(app.getHttpServer()).get('/__request-id/echo'),
    ]);

    const firstId = (first.body as { requestId: string }).requestId;
    const secondId = (second.body as { requestId: string }).requestId;

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
  });
});
