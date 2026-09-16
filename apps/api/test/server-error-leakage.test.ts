import { Controller, Get, InternalServerErrorException, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { Public } from '../src/modules/auth/public.decorator';

/**
 * The message on a 5xx is written for us, not for a user. `HttpException`
 * hands its own message to the filter, so without an explicit rule a line like
 * this one reaches the client verbatim and describes our topology to anyone
 * who can provoke the error.
 */
const INTERNAL_DETAIL = 'connection pool exhausted on db-primary 10.0.0.5:5432';

@Controller('__test-only')
class ServerErrorController {
  // `@Public()` for the same reason as `health.e2e.test.ts`'s throwing route:
  // AppModule's global `AuthenticationGuard` protects every undecorated route,
  // so without this the request is a 401 and never reaches the 5xx path this
  // file exists to test.
  @Public()
  @Get('server-error')
  explode(): never {
    throw new InternalServerErrorException(INTERNAL_DETAIL);
  }
}

@Module({ controllers: [ServerErrorController] })
class ServerErrorModule {}

describe('a 5xx HttpException', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ServerErrorModule],
    }).compile();

    // Deliberately NOT re-registering the filter/interceptor here: AppModule
    // provides them (APP_FILTER / APP_INTERCEPTOR), and this test is only
    // meaningful if it exercises that wiring rather than its own.
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers with the generic envelope and never echoes its own message', async () => {
    const res = await request(app.getHttpServer()).get('/__test-only/server-error');

    expect(res.status).toBe(500);

    const body = res.body as ErrorEnvelope;
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.requestId).toEqual(expect.any(String));

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(INTERNAL_DETAIL);
    expect(raw).not.toContain('10.0.0.5');
    expect(raw).not.toContain('db-primary');
  });
});
