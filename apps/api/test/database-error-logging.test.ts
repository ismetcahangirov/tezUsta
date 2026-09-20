import { ConsoleLogger, Controller, Get, Inject, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { uuidV7 } from '../src/common/ids/uuid-v7';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { DatabaseModule } from '../src/infra/database/database.module';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { users } from '../src/infra/database/schema/users';
import { Public } from '../src/modules/auth/public.decorator';
import { expectLoggerIsListening, spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Issue #63: a failed query used to write its own SQL **and every bound
 * parameter** into the server log, because `AllExceptionsFilter` logged
 * `exception.stack` and `drizzle-orm` builds a query error's message by
 * interpolating them. On the authentication path those parameters are phone
 * numbers, which CLAUDE.md §11 forbids logging outright.
 *
 * The number below is the recognisable value: it is bound as a parameter, it
 * is quoted back by PostgreSQL in the error's `detail` (`Key
 * (phone_e164)=(...) already exists.`), and it therefore has to be absent from
 * the log through two independent routes, not one.
 *
 * A unique violation on `users` is the vehicle because it is the failure that
 * actually happens on this path, and because it is the one whose `detail`
 * carries a value — the exact case the fix had to decide about rather than
 * inherit.
 */
const RECOGNISABLE_PHONE = '+994507654321';

/** SQLSTATE `unique_violation`, which the log must still name. */
const EXPECTED_SQLSTATE = '23505';

@Controller('__test-only')
class DuplicateInsertController {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  // `@Public()` for the same reason as `server-error-leakage.test.ts`:
  // AppModule guards every undecorated route, and a 401 would never reach the
  // filter this file is about.
  @Public()
  @Get('duplicate-insert')
  async explode(): Promise<never> {
    const row = { phoneE164: RECOGNISABLE_PHONE, status: 'active' as const };

    await this.db.insert(users).values({ id: uuidV7(), ...row });
    // `users_phone_e164_live_unique` — the second insert raises 23505, and
    // nothing catches it, so it travels the same route a genuine bug would.
    await this.db.insert(users).values({ id: uuidV7(), ...row });

    throw new Error('Unreachable: the second insert must violate the unique index.');
  }
}

// `DatabaseModule` imported rather than the connection re-provided: the point
// is to fail on the same pool the application uses, through the same query
// layer, so that what the filter receives is what it receives in production.
@Module({ imports: [DatabaseModule], controllers: [DuplicateInsertController] })
class DuplicateInsertModule {}

describe('a failed query never writes its parameters to the log (issue #63)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let originalDatabaseUrl: string | undefined;

  let sink: string[];
  let spies: MockInstance[];

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DuplicateInsertModule],
    })
      // Nest's `TestingLogger` has empty bodies for most levels, so without a
      // real one this suite would pass against a logger that prints nothing —
      // and would pass identically if the filter printed every phone number it
      // ever saw. `auth.otp.e2e.test.ts` carries the same note.
      .setLogger(new ConsoleLogger())
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    await database.drop();
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

  it('positive control: the harness captures what a Nest logger writes', () => {
    // Without this, every assertion below would also hold for a suite that
    // captured nothing at all.
    //
    // It used to write the canary at `error`, which is the one level Nest's
    // `TestingLogger` does NOT stub — so it stayed green in exactly the
    // configuration it existed to detect, and deleting the `.setLogger` call
    // above would not have failed it. The shared helper writes at `log`
    // instead (#127).
    expectLoggerIsListening(sink, 'database-error-logging.test');
  });

  it('logs the SQLSTATE, the constraint and the statement — and no bound value', async () => {
    const res = await request(app.getHttpServer()).get('/__test-only/duplicate-insert');

    expect(res.status).toBe(500);

    const logged = sink.join('\n');

    // The failure is still diagnosable. Asserting this first matters: without
    // it, "log nothing at all" would satisfy every remaining expectation.
    expect(logged).toContain(EXPECTED_SQLSTATE);
    expect(logged).toContain('users_phone_e164_live_unique');
    expect(logged).toContain('insert into "users"');

    // And it is correlated, so an on-call engineer can tie the line to the
    // request that produced it (issue #47).
    const body = res.body as ErrorEnvelope;
    expect(logged).toContain(body.error.requestId);

    // The three routes the number could have taken into the log:
    // the bound parameter, Drizzle's interpolated message, and the driver's
    // `detail`.
    expect(logged).not.toContain(RECOGNISABLE_PHONE);
    expect(logged).not.toContain('Failed query');
    expect(logged).not.toContain('already exists');
  });

  it('answers the client with the unchanged generic envelope', async () => {
    const res = await request(app.getHttpServer()).get('/__test-only/duplicate-insert');

    expect(res.status).toBe(500);

    const body = res.body as ErrorEnvelope;
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).not.toContain(RECOGNISABLE_PHONE);
    expect(JSON.stringify(res.body)).not.toContain('users');
  });
});
