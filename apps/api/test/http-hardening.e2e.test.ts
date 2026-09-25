import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { AppConfig } from '../src/infra/config/app-config.types';
import { APP_CONFIG } from '../src/infra/config/config.tokens';
import {
  createFastifyAdapter,
  DEFAULT_BODY_LIMIT_BYTES,
} from '../src/infra/http/fastify-adapter-options';
import { SecurityHeadersHook } from '../src/common/security/security-headers.hook';
import { Public } from '../src/modules/auth/public.decorator';

/**
 * Issue #275. `main.ts`'s `new FastifyAdapter()` carried no options: no
 * security response headers on any response, an unreviewed implicit body
 * limit, and nothing that would ever refuse a future `trustProxy: true`.
 * These assertions are against the shipped wiring — `AppModule` plus the same
 * `createFastifyAdapter()` `main.ts` calls — not a copy built for this file.
 */

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

function expectSecurityHeaders(res: request.Response): void {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    expect(res.headers[header]).toBe(value);
  }
}

@Controller('__test-only-hardening')
class HardeningDebugController {
  @Public()
  @Get('ok')
  ok(): { readonly ok: true } {
    return { ok: true };
  }

  // No `@Public()`: the global `AuthenticationGuard` (issue #27) rejects this
  // with a 401 before the handler ever runs, which is what exercises the
  // headers on a rejected request rather than a successful one.
  @Get('protected')
  protectedRoute(): never {
    throw new Error('unreachable: the guard rejects this before the handler runs');
  }

  @Public()
  @Post('echo')
  echo(): { readonly received: true } {
    return { received: true };
  }
}

@Module({ controllers: [HardeningDebugController] })
class HardeningDebugModule {}

describe('HTTP hardening: security headers and body limit (issue #275)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, HardeningDebugModule],
    }).compile();

    // `createFastifyAdapter()`, not `new FastifyAdapter()`: the point of this
    // suite is to exercise the same adapter options `main.ts` builds, not
    // Fastify's own unreviewed defaults.
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter());
    await app.init();
    // Fastify routes are not guaranteed registered until the underlying
    // instance is ready — without this, supertest hits them intermittently
    // with a 404.
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets the security headers on a 200', async () => {
    const res = await request(app.getHttpServer()).get('/__test-only-hardening/ok');

    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  it('sets the security headers on a 401', async () => {
    const res = await request(app.getHttpServer()).get('/__test-only-hardening/protected');

    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
  });

  it('sets the security headers on a 404 for an unmatched route', async () => {
    const res = await request(app.getHttpServer()).get('/no-such-route-275-http-hardening');

    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it('does not set Strict-Transport-Security outside production', async () => {
    const res = await request(app.getHttpServer()).get('/__test-only-hardening/ok');

    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('answers 413 for a body over the configured limit, and still carries the headers', async () => {
    const oversized = 'a'.repeat(DEFAULT_BODY_LIMIT_BYTES + 1024);

    const res = await request(app.getHttpServer())
      .post('/__test-only-hardening/echo')
      .set('content-type', 'application/json')
      .send(oversized);

    expect(res.status).toBe(413);
    expectSecurityHeaders(res);
  });

  it('accepts a body at the LiveKit webhook route within its own 64 KiB limit (does not 413)', async () => {
    // No valid signature is presented, so the correct answer is 401, not 200
    // — see `call-media-webhook.controller.ts`. What this proves is that the
    // body was accepted for parsing at all: a global body limit that had
    // shrunk below the webhook's own 64 KiB, or a webhook parser broken by
    // the adapter now carrying an explicit `bodyLimit`, would both show up as
    // a 413 here instead.
    const body = JSON.stringify({
      type: 'room-finished',
      roomName: 'http-hardening-test-room',
      eventId: 'http-hardening-test-event',
      createdAt: new Date().toISOString(),
    });

    const res = await request(app.getHttpServer())
      .post('/webhooks/livekit')
      .set('content-type', 'application/webhook+json')
      .send(body);

    expect(res.status).toBe(401);
  });
});

@Controller('__test-only-hardening-prod')
class ProdPingController {
  @Get('ping')
  ping(): { readonly ok: true } {
    return { ok: true };
  }
}

@Module({
  controllers: [ProdPingController],
  providers: [
    SecurityHeadersHook,
    {
      provide: APP_CONFIG,
      useValue: {
        runtime: { nodeEnv: 'production', port: 0, host: '127.0.0.1', corsOrigins: [] },
      } satisfies Pick<AppConfig, 'runtime'>,
    },
  ],
})
class ProdSecurityModule {}

describe('SecurityHeadersHook in production (issue #275)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    // A minimal module — no `AppModule`, no database, no guards — because
    // this suite is only about one branch of `SecurityHeadersHook` itself:
    // whether `NODE_ENV=production` turns on `Strict-Transport-Security`.
    // `AppModule` reads `NODE_ENV` at boot for the rest of its configuration
    // too, so flipping it for a whole `Test.createTestingModule({ imports:
    // [AppModule] })` would mean re-validating every production-only rule
    // `env.schema.ts` enforces just to test one header.
    const moduleRef = await Test.createTestingModule({
      imports: [ProdSecurityModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets Strict-Transport-Security when the app config reports production', async () => {
    const res = await request(app.getHttpServer()).get('/__test-only-hardening-prod/ping');

    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expectSecurityHeaders(res);
  });
});
