import { randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { and, eq, isNull } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { emailChanges } from '../src/infra/database/schema/email-changes';
import { sessions } from '../src/infra/database/schema/sessions';
import { users } from '../src/infra/database/schema/users';
import type { EmailSender, OutboundEmail } from '../src/infra/email/email-sender.types';
import { EMAIL_SENDER } from '../src/infra/email/email-sender.types';
import { StubEmailSender } from '../src/infra/email/stub-email-sender';
import type {
  RateLimitConfig,
  RateLimitPolicy,
  RateLimitPolicyName,
} from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { RateLimiterService } from '../src/infra/rate-limit/rate-limiter.service';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The self-serve change of sign-in address (#514, ADR-0074 § 1), end to end:
 * real HTTP through `AppModule`, a real Postgres and the shared Redis.
 *
 * What it pins down is what only the database can show: that both codes are
 * needed together, that the move and the revocation of every session commit
 * as one, that two confirms of one pair move the account once, and that the
 * live-address unique index decides a race for one new address.
 */

/** Captures each message while still handing it to the real stub, as `auth.otp.e2e.test.ts` does. */
class CapturingEmailSender implements EmailSender {
  readonly sent: OutboundEmail[] = [];

  constructor(private readonly inner: EmailSender) {}

  async send(message: OutboundEmail): Promise<void> {
    this.sent.push(message);
    await this.inner.send(message);
  }

  lastTo(email: string): OutboundEmail {
    const message = [...this.sent].reverse().find((sent) => sent.to === email);
    if (message === undefined) {
      throw new Error(`No email was sent to ${email}.`);
    }
    return message;
  }

  lastCodeFor(email: string): string {
    const match = /\d{4,12}/.exec(this.lastTo(email).text);
    if (match === null) {
      throw new Error('The email body carried no code.');
    }
    return match[0];
  }

  countTo(email: string): number {
    return this.sent.filter((sent) => sent.to === email).length;
  }
}

const WINDOW_MS = 10_000;
const UNREACHABLE = 1_000_000;
/** Per-user starts allowed in a window: small enough to reach in one test. */
const START_LIMIT = 4;

/**
 * Every policy unreachable except the two these routes spend, keyed by a
 * pepper made for this run so the shared Redis cannot collide with another
 * checkout. A policy missing here would fail every request loudly, not quietly.
 */
const POLICY_NAMES: readonly RateLimitPolicyName[] = [
  'otp-request',
  'sign-in',
  'refresh',
  'geocode',
  'document-upload',
  'order-creation',
  'order-transition',
  'order-search-read',
  'price-range',
  'location-report',
  'offer-response',
  'offer-feed',
  'device-registration',
  'message-send',
  'review-submit',
  'report-submit',
  'portfolio-upload',
  'portfolio-write',
  'subscription-checkout',
  'profile-read',
  'admin-setup',
  'admin-sign-in',
];

function policy(perIdentifier: number): RateLimitPolicy {
  return { perIdentifier, perIp: UNREACHABLE, windowMs: WINDOW_MS, backoffCeilingMs: WINDOW_MS };
}

const testRateLimits: RateLimitConfig = {
  keySecret: `email-change-e2e-pepper-${randomUUID()}`,
  policies: {
    ...(Object.fromEntries(POLICY_NAMES.map((name) => [name, policy(UNREACHABLE)])) as Record<
      RateLimitPolicyName,
      RateLimitPolicy
    >),
    'otp-request': policy(START_LIMIT),
  },
};

/** ADR-0072's cap, which the pair inherits. */
const MAX_ATTEMPTS = 5;

let app: NestFastifyApplication;
let database: ThrowawayDatabase;
let originalDatabaseUrl: string | undefined;
let db: Database;
let mail: CapturingEmailSender;
let limiter: RateLimiterService;
let usersRepo: UsersRepository;
let sessionsService: SessionsService;

let counter = 0;
function nextEmail(): string {
  counter += 1;
  return `change-${String(counter)}@example.com`;
}

interface SignedIn {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
}

/** A fresh account with a live session, opened directly rather than through a code. */
async function signedInUser(): Promise<SignedIn> {
  const email = nextEmail();
  const { user } = await usersRepo.create({ email, roles: ['customer'] });
  const pair = await sessionsService.startSession({ userId: user.id });
  return { userId: user.id, email, accessToken: pair.accessToken };
}

function start(actor: SignedIn, newEmail: string) {
  return request(app.getHttpServer())
    .post('/me/email-change')
    .set('authorization', `Bearer ${actor.accessToken}`)
    .send({ newEmail });
}

function confirm(actor: SignedIn, currentCode: string, newCode: string) {
  return request(app.getHttpServer())
    .post('/me/email-change/confirm')
    .set('authorization', `Bearer ${actor.accessToken}`)
    .send({ currentCode, newCode });
}

function wrong(code: string): string {
  return code === '0'.repeat(code.length) ? '1'.repeat(code.length) : '0'.repeat(code.length);
}

async function liveSessions(userId: string): Promise<number> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  return rows.length;
}

async function emailOf(userId: string): Promise<string | undefined> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return row?.email;
}

beforeAll(async () => {
  const baseUrl = parseEnv(process.env).database.url;
  database = await createThrowawayDatabase(baseUrl);
  await runMigrations(database.url);

  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RATE_LIMIT_CONFIG)
    .useValue(testRateLimits)
    .overrideProvider(EMAIL_SENDER)
    .useValue(new CapturingEmailSender(new StubEmailSender('test')))
    // Not cosmetic: without a real logger the "no code in any log" test
    // would pass against Nest's TestingLogger, which discards everything.
    .setLogger(new ConsoleLogger())
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  db = app.get<Database>(DATABASE_CONNECTION);
  mail = app.get<CapturingEmailSender>(EMAIL_SENDER);
  limiter = app.get(RateLimiterService);
  usersRepo = app.get(UsersRepository);
  sessionsService = app.get(SessionsService);
});

afterAll(async () => {
  // Shared Redis: delete exactly the keys this suite made, never FLUSHDB.
  const userRows = await db.select({ id: users.id }).from(users);
  const changeRows = await db.select({ id: emailChanges.id }).from(emailChanges);
  await Promise.all([
    ...userRows.flatMap((row) => [
      limiter.reset('otp-request', 'identifier', row.id),
      limiter.reset('sign-in', 'identifier', row.id),
    ]),
    ...changeRows.map((row) => limiter.clearAttempts('email-change-verify', row.id)),
  ]);

  await app.close();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  await database.drop();
});

describe('a signed-in user changes their address with both codes', () => {
  it('moves the account, revokes every session, and tells the old address', async () => {
    const actor = await signedInUser();
    // A second device, so "every session" is more than the one that asked.
    await sessionsService.startSession({ userId: actor.userId });
    expect(await liveSessions(actor.userId)).toBe(2);
    const newEmail = nextEmail();

    const started = await start(actor, newEmail);
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ expiresInSeconds: expect.any(Number) as number });

    const confirmed = await confirm(
      actor,
      mail.lastCodeFor(actor.email),
      mail.lastCodeFor(newEmail),
    );
    expect(confirmed.status).toBe(204);

    expect(await emailOf(actor.userId)).toBe(newEmail);
    expect(await liveSessions(actor.userId)).toBe(0);
    const revoked = await db
      .select({ reason: sessions.revokedReason })
      .from(sessions)
      .where(eq(sessions.userId, actor.userId));
    expect(revoked.map((row) => row.reason)).toEqual(['email_change', 'email_change']);

    // The completed row is the record of the change.
    const [record] = await db
      .select()
      .from(emailChanges)
      .where(eq(emailChanges.userId, actor.userId));
    expect(record).toMatchObject({ oldEmail: actor.email, newEmail });
    expect(record?.completedAt).toBeInstanceOf(Date);

    // The notice: to the old address, after the change, with no code and no link.
    const notice = mail.lastTo(actor.email);
    expect(notice.subject).not.toMatch(/\d{4,12}/);
    expect(notice.text).not.toMatch(/\d{4,12}/);
    expect(notice.text).not.toMatch(/https?:/);
    expect(notice.text).not.toContain(newEmail);

    // The old session is dead: the same token no longer opens the route.
    const after = await start(actor, nextEmail());
    expect(after.status).toBe(401);
  });

  it('never stores either code in the clear', async () => {
    const actor = await signedInUser();
    const newEmail = nextEmail();
    await start(actor, newEmail);

    const [row] = await db.select().from(emailChanges).where(eq(emailChanges.userId, actor.userId));
    const currentCode = mail.lastCodeFor(actor.email);
    const newCode = mail.lastCodeFor(newEmail);
    for (const stored of [row?.currentCodeHash, row?.newCodeHash]) {
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      expect(stored).not.toContain(currentCode);
      expect(stored).not.toContain(newCode);
    }
  });
});

describe('the codes are refused unless both are right', () => {
  it('refuses one wrong code, or the codes swapped, and changes nothing', async () => {
    const actor = await signedInUser();
    const newEmail = nextEmail();
    await start(actor, newEmail);
    const currentCode = mail.lastCodeFor(actor.email);
    const newCode = mail.lastCodeFor(newEmail);

    for (const [a, b] of [
      [currentCode, wrong(newCode)],
      [wrong(currentCode), newCode],
      [newCode, currentCode],
    ] as const) {
      // The swapped pair is only a real test when the two draws differ.
      if (a === currentCode && b === newCode) {
        continue;
      }
      const refused = await confirm(actor, a, b);
      expect(refused.status).toBe(422);
      expect((refused.body as ErrorEnvelope).error.code).toBe('EMAIL_CHANGE_CODE_INVALID');
    }

    expect(await emailOf(actor.userId)).toBe(actor.email);
    expect(await liveSessions(actor.userId)).toBe(1);
  });

  it('refuses a confirm with no change pending', async () => {
    const actor = await signedInUser();
    const refused = await confirm(actor, '123456', '654321');
    expect(refused.status).toBe(422);
    expect((refused.body as ErrorEnvelope).error.code).toBe('EMAIL_CHANGE_CODE_INVALID');
  });

  it('invalidates the pair once the attempt cap is spent, even for the right codes', async () => {
    const actor = await signedInUser();
    const newEmail = nextEmail();
    await start(actor, newEmail);
    const currentCode = mail.lastCodeFor(actor.email);
    const newCode = mail.lastCodeFor(newEmail);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      expect((await confirm(actor, currentCode, wrong(newCode))).status).toBe(422);
    }
    expect((await confirm(actor, currentCode, newCode)).status).toBe(422);

    const [row] = await db.select().from(emailChanges).where(eq(emailChanges.userId, actor.userId));
    expect(row?.invalidatedReason).toBe('attempts_exhausted');
    expect(await emailOf(actor.userId)).toBe(actor.email);
  });

  it('a new start replaces the pending pair, whose codes stop working', async () => {
    const actor = await signedInUser();
    const firstNew = nextEmail();
    await start(actor, firstNew);
    const staleCurrent = mail.lastCodeFor(actor.email);
    const staleNew = mail.lastCodeFor(firstNew);

    const secondNew = nextEmail();
    expect((await start(actor, secondNew)).status).toBe(200);

    expect((await confirm(actor, staleCurrent, staleNew)).status).toBe(422);
    expect(
      (await confirm(actor, mail.lastCodeFor(actor.email), mail.lastCodeFor(secondNew))).status,
    ).toBe(204);
    expect(await emailOf(actor.userId)).toBe(secondNew);
  });
});

describe('what a start refuses, and what it does not ask', () => {
  it('refuses the address the account already has', async () => {
    const actor = await signedInUser();
    const refused = await start(actor, `  ${actor.email.toUpperCase()} `);
    expect(refused.status).toBe(422);
    expect((refused.body as ErrorEnvelope).error.code).toBe('EMAIL_CHANGE_SAME_ADDRESS');
  });

  it('refuses something that is not an address', async () => {
    const actor = await signedInUser();
    const refused = await start(actor, 'not an address');
    expect(refused.status).toBe(422);
    expect((refused.body as ErrorEnvelope).error.code).toBe('VALIDATION_FAILED');
  });

  it('answers a start for a taken address exactly like any other, and refuses only at confirm', async () => {
    const actor = await signedInUser();
    const other = await signedInUser();

    const started = await start(actor, other.email);
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ expiresInSeconds: expect.any(Number) as number });

    const refused = await confirm(
      actor,
      mail.lastCodeFor(actor.email),
      mail.lastCodeFor(other.email),
    );
    expect(refused.status).toBe(409);
    expect((refused.body as ErrorEnvelope).error.code).toBe('EMAIL_ADDRESS_TAKEN');

    // Rolled back: the address, the sessions and the pending pair are as they were.
    expect(await emailOf(actor.userId)).toBe(actor.email);
    expect(await liveSessions(actor.userId)).toBe(1);
    const [row] = await db.select().from(emailChanges).where(eq(emailChanges.userId, actor.userId));
    expect(row?.completedAt).toBeNull();
  });

  it('refuses a signed-out caller', async () => {
    const response = await request(app.getHttpServer())
      .post('/me/email-change')
      .send({ newEmail: nextEmail() });
    expect(response.status).toBe(401);
  });

  it('limits how often one account may start a change', async () => {
    const actor = await signedInUser();
    const statuses: number[] = [];
    for (let index = 0; index <= START_LIMIT; index += 1) {
      statuses.push((await start(actor, nextEmail())).status);
    }
    expect(statuses.slice(0, START_LIMIT).every((status) => status === 200)).toBe(true);
    expect(statuses[START_LIMIT]).toBe(429);
  });
});

describe('concurrency', () => {
  it('two confirms of one pair move the account once', async () => {
    const actor = await signedInUser();
    const newEmail = nextEmail();
    await start(actor, newEmail);
    const currentCode = mail.lastCodeFor(actor.email);
    const newCode = mail.lastCodeFor(newEmail);
    const noticesBefore = mail.countTo(actor.email);

    const results = await Promise.all([
      confirm(actor, currentCode, newCode),
      confirm(actor, currentCode, newCode),
    ]);

    // The loser is refused either way: 422 when it reached the codes after the
    // winner completed the pair, or 401 when the winner had already revoked
    // the session it was sent on. Both mean "not moved twice".
    const statuses = results.map((result) => result.status).sort();
    expect(statuses[0]).toBe(204);
    expect([401, 422]).toContain(statuses[1]);
    expect(await emailOf(actor.userId)).toBe(newEmail);
    // One notice, not two.
    expect(mail.countTo(actor.email) - noticesBefore).toBe(1);
  });

  it('two accounts racing for one new address: exactly one gets it', async () => {
    const first = await signedInUser();
    const second = await signedInUser();
    const contested = nextEmail();

    await start(first, contested);
    const firstCurrent = mail.lastCodeFor(first.email);
    const firstNew = mail.lastCodeFor(contested);
    await start(second, contested);
    const secondCurrent = mail.lastCodeFor(second.email);
    const secondNew = mail.lastCodeFor(contested);

    const results = await Promise.all([
      confirm(first, firstCurrent, firstNew),
      confirm(second, secondCurrent, secondNew),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([204, 409]);
    const holders = await db.select({ id: users.id }).from(users).where(eq(users.email, contested));
    expect(holders).toHaveLength(1);
  });
});

describe('logging', () => {
  it('never writes either code to any log', async () => {
    const lines: string[] = [];
    const spies = spyOnEveryLogSink(lines);
    try {
      const actor = await signedInUser();
      const newEmail = nextEmail();
      await start(actor, newEmail);
      const currentCode = mail.lastCodeFor(actor.email);
      const newCode = mail.lastCodeFor(newEmail);
      await confirm(actor, currentCode, wrong(newCode));
      await confirm(actor, currentCode, newCode);

      const everything = lines.join('\n');
      expect(everything).toContain('email change completed');
      expect(everything).not.toContain(currentCode);
      expect(everything).not.toContain(newCode);
      expect(everything).not.toContain(newEmail);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
