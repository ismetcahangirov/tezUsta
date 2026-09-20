import {
  Controller,
  ConsoleLogger,
  Get,
  InternalServerErrorException,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppError } from '../src/common/errors/app-error';
import { NotFoundError } from '../src/common/errors/not-found.error';
import { RateLimitedError } from '../src/common/errors/rate-limited.error';
import { Public } from '../src/modules/auth/public.decorator';
import { spyOnEveryLogSink } from './support/log-sink';

/**
 * What `AllExceptionsFilter` writes to the log, as opposed to what it sends to
 * the client (issue #56).
 *
 * Every expected client answer — a 401 with no token, a 404 for something that
 * is not yours, a 429 from the rate limiter — used to print a full stack
 * trace, because they are all `Error`s and the filter logged every exception
 * the same way. They are not faults; they are the expected answers to ordinary
 * traffic, and the rate limiter in particular exists to produce a great many
 * of them cheaply. A stack per refusal makes a cheap refusal expensive for us
 * and buries the one 500 that matters.
 *
 * **The assertions cut both ways on purpose.** "Log less" is not the fix: the
 * unexpected 500 below must still carry its whole stack, and each expected
 * error must still carry its line, its status, its code and its request id. A
 * suite that only asserted the absence of stacks would pass just as happily
 * against a filter that logged nothing at all.
 *
 * `.setLogger(new ConsoleLogger())` is load-bearing.
 * `Test.createTestingModule` installs Nest's `TestingLogger`, whose methods are
 * empty — with it in place every assertion here would pass vacuously, which is
 * the trap issue #56 names explicitly.
 */

/** A stack frame, as `ConsoleLogger` prints one: a line beginning `    at `. */
const STACK_FRAME = /\n\s+at /;

const UNEXPECTED_DETAIL = 'pool exhausted on db-primary 10.0.0.5:5432';

@Controller('__expected-error')
class ExpectedErrorController {
  @Public()
  @Get('not-found')
  notFound(): never {
    throw new NotFoundError();
  }

  @Public()
  @Get('rate-limited')
  rateLimited(): never {
    throw new RateLimitedError(30);
  }

  @Public()
  @Get('unauthorized')
  unauthorized(): never {
    throw new UnauthorizedException('no token presented');
  }

  /** Ours, deliberate, and a fault — the case a stack exists for. */
  @Public()
  @Get('app-error-500')
  deliberateFault(): never {
    throw new AppError('INTERNAL_ERROR', 'the outbox writer is wedged', 500);
  }

  @Public()
  @Get('unexpected')
  unexpected(): never {
    throw new InternalServerErrorException(UNEXPECTED_DETAIL);
  }

  @Public()
  @Get('thrown-string')
  bug(): never {
    throw new Error('a programming bug nobody expected');
  }
}

@Module({ controllers: [ExpectedErrorController] })
class ExpectedErrorModule {}

describe('what the exception filter logs', () => {
  let app: NestFastifyApplication;
  let sink: string[];
  let spies: MockInstance[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ExpectedErrorModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // See the file comment: without this the sink stays empty and every
    // assertion below is vacuous.
    app.useLogger(new ConsoleLogger());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    sink = [];
    spies = spyOnEveryLogSink(sink);
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  /** Every line the filter wrote about this request, joined. */
  function filterOutput(requestId: string): string {
    return sink.filter((line) => line.includes(requestId)).join('\n');
  }

  async function call(path: string): Promise<{ status: number; requestId: string; log: string }> {
    const requestId = `expected-error-${path.replace(/\W+/g, '-')}-${String(Date.now())}`;
    const res = await request(app.getHttpServer())
      .get(`/__expected-error/${path}`)
      .set('x-request-id', requestId);
    return { status: res.status, requestId, log: filterOutput(requestId) };
  }

  it('is not silent — the positive control the rest of this file rests on', async () => {
    const { status, log } = await call('not-found');

    expect(status).toBe(404);
    expect(log).not.toBe('');
  });

  it.each([
    ['not-found', 404, 'NOT_FOUND'],
    ['unauthorized', 401, 'UNAUTHORIZED'],
    ['rate-limited', 429, 'RATE_LIMITED'],
  ])('logs %s without a stack trace, and still says what happened', async (path, status, code) => {
    const result = await call(path);

    expect(result.status).toBe(status);
    // The line exists, carries the request id that is also in the client's
    // envelope, and names the status and the code.
    expect(result.log).toContain(result.requestId);
    expect(result.log).toContain(String(status));
    expect(result.log).toContain(code);
    // ...and no stack.
    expect(result.log).not.toMatch(STACK_FRAME);
  });

  it('keeps the full stack for an unexpected error', async () => {
    const result = await call('unexpected');

    expect(result.status).toBe(500);
    expect(result.log).toContain(result.requestId);
    expect(result.log).toContain('INTERNAL_ERROR');
    expect(result.log).toMatch(STACK_FRAME);
  });

  it('keeps the full stack for a bug that is not an HttpException at all', async () => {
    const result = await call('thrown-string');

    expect(result.status).toBe(500);
    expect(result.log).toContain(result.requestId);
    expect(result.log).toMatch(STACK_FRAME);
  });

  it('keeps the stack for a deliberate AppError carrying a 500 — the split is expectation, not status', async () => {
    const result = await call('app-error-500');

    expect(result.status).toBe(500);
    expect(result.log).toContain(result.requestId);
    expect(result.log).toMatch(STACK_FRAME);
  });

  it('logs the framework message a 404 response deliberately withholds', async () => {
    const requestId = `expected-error-unmatched-${String(Date.now())}`;
    const res = await request(app.getHttpServer())
      .get('/__expected-error/no-such-route-here')
      .set('x-request-id', requestId);

    expect(res.status).toBe(404);
    const log = filterOutput(requestId);
    // The client is told nothing about the path (issue #47); the log keeps it,
    // which is the promise `safeHttpExceptionMessage` makes.
    expect(log).toContain('no-such-route-here');
    expect(JSON.stringify(res.body)).not.toContain('no-such-route-here');
    expect(log).not.toMatch(STACK_FRAME);
  });
});
