import { createHash, createHmac, randomUUID } from 'node:crypto';

import { ConsoleLogger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { DATABASE_CONNECTION } from '../src/infra/database/database.tokens';
import type { Database } from '../src/infra/database/database.types';
import { runMigrations } from '../src/infra/database/migrate';
import { otpChallenges } from '../src/infra/database/schema/otp-challenges';
import { sessions } from '../src/infra/database/schema/sessions';
import { users } from '../src/infra/database/schema/users';
import type { RateLimitConfig } from '../src/infra/rate-limit/rate-limit.config';
import { RATE_LIMIT_CONFIG } from '../src/infra/rate-limit/rate-limit.tokens';
import { RateLimiterService } from '../src/infra/rate-limit/rate-limiter.service';
import type { OutboundSms, SmsSender } from '../src/infra/sms/sms-sender.types';
import { SMS_SENDER } from '../src/infra/sms/sms-sender.types';
import { StubSmsSender } from '../src/infra/sms/stub-sms-sender';
import { OtpService } from '../src/modules/auth/otp.service';
import { TokenService } from '../src/modules/auth/token.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import { spyOnEveryLogSink } from './support/log-sink';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * Phone + OTP sign-in (issue #29), end to end: real HTTP through the real
 * `AppModule` wiring, against a real Postgres and the shared Redis.
 *
 * Almost every claim ADR-0008 makes is a claim about *concurrency, storage or
 * indistinguishability*, and none of those survive being tested against a
 * stubbed repository. "The same code cannot be redeemed twice, including
 * concurrently" is a statement about what PostgreSQL does with two overlapping
 * `UPDATE`s; "codes are stored hashed" is a statement about the bytes in a
 * row; "responses are identical for known and unknown numbers" is a statement
 * about what leaves the server. So this file drives the endpoints and then
 * reads the database.
 *
 * The one thing it cannot exercise is delivery: **the SMS provider is still an
 * open decision** (CLAUDE.md §1, ADR-0008), and until one is chosen nobody can
 * actually sign in. The stub sender is what makes everything above the
 * provider testable today.
 */

/**
 * Captures each message while still handing it to the real {@link
 * StubSmsSender}, rather than replacing it.
 *
 * The test has to learn the code somehow — it is never returned by the API and
 * never logged — and reading it from the provider boundary is the only place
 * it legitimately exists in the clear. Wrapping rather than substituting keeps
 * the production sender in the path, so its `NODE_ENV=test` silence is part of
 * what the logging assertions below are testing rather than something this
 * fake quietly removed.
 */
class CapturingSmsSender implements SmsSender {
  readonly sent: OutboundSms[] = [];

  constructor(private readonly inner: SmsSender) {}

  async send(message: OutboundSms): Promise<void> {
    this.sent.push(message);
    await this.inner.send(message);
  }

  /** The code from the most recent message to this number. */
  lastCodeFor(phoneE164: string): string {
    const message = [...this.sent].reverse().find((sent) => sent.to === phoneE164);
    if (message === undefined) {
      throw new Error(`No SMS was sent to ${phoneE164}.`);
    }
    const match = /\d{4,12}/.exec(message.body);
    if (match === null) {
      throw new Error('The SMS body carried no code.');
    }
    return match[0];
  }
}

/**
 * Real policy names, test-sized numbers, and a pepper generated for this run —
 * the same approach `auth.rate-limit.e2e.test.ts` takes, and for the same two
 * reasons: an hour-long window would not finish, and because every Redis key
 * is an HMAC under this pepper, this suite cannot collide with another
 * checkout running against the same shared Redis container.
 *
 * The per-IP budgets are deliberately unreachable. Every request in this file
 * comes from loopback, so a per-IP limit would fire partway through the suite
 * and turn unrelated assertions into 429s; the per-identifier dimension is
 * what these tests are about, and `auth.rate-limit.e2e.test.ts` already covers
 * the IP one.
 */
const REQUEST_LIMIT = 3;
const VERIFY_LIMIT = 8;
const WINDOW_MS = 10_000;
const UNREACHABLE = 1_000_000;

const testRateLimits: RateLimitConfig = {
  keySecret: `otp-e2e-pepper-${randomUUID()}`,
  policies: {
    'otp-request': {
      perIdentifier: REQUEST_LIMIT,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'sign-in': {
      perIdentifier: VERIFY_LIMIT,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    refresh: {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    geocode: {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'document-upload': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'price-range': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'order-creation': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'order-transition': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'offer-response': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'offer-feed': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'location-report': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'device-registration': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
    'message-send': {
      perIdentifier: UNREACHABLE,
      perIp: UNREACHABLE,
      windowMs: WINDOW_MS,
      backoffCeilingMs: WINDOW_MS,
    },
  },
};

/** ADR-0008's cap, and the schema's default — asserted rather than assumed. */
const MAX_ATTEMPTS = 5;

let app: NestFastifyApplication;
let database: ThrowawayDatabase;
let originalDatabaseUrl: string | undefined;
let db: Database;
let sms: CapturingSmsSender;
let limiter: RateLimiterService;
let tokens: TokenService;
let usersRepo: UsersRepository;
let otpService: OtpService;

/** `users.phone_e164` is unique among live rows, so every test takes a fresh number. */
let phoneCounter = 0;
const usedPhones = new Set<string>();

function nextPhone(): string {
  phoneCounter += 1;
  // `+994 50 …` — a real Azerbaijani mobile prefix, nine national digits, so
  // it survives `normaliseAzerbaijaniPhone` exactly as a user's would.
  const phone = `+99450${String(phoneCounter).padStart(7, '0')}`;
  usedPhones.add(phone);
  return phone;
}

function postRequest(phone: string) {
  usedPhones.add(phone);
  return request(app.getHttpServer()).post('/auth/otp/request').send({ phone });
}

function postVerify(phone: string, code: string, extra: Record<string, unknown> = {}) {
  usedPhones.add(phone);
  return request(app.getHttpServer())
    .post('/auth/otp/verify')
    .send({ phone, code, ...extra });
}

/** Requests a code for a fresh number and returns both halves. */
async function issueCode(): Promise<{ phone: string; code: string }> {
  const phone = nextPhone();
  const response = await postRequest(phone);
  expect(response.status).toBe(200);
  return { phone, code: sms.lastCodeFor(phone) };
}

function wrongCodeFor(code: string): string {
  // Same length, different value — so a rejection is about the code being
  // wrong and not about it failing the Zod shape check, which would make every
  // assertion below pass for the wrong reason.
  return code === '0'.repeat(code.length) ? '1'.repeat(code.length) : '0'.repeat(code.length);
}

beforeAll(async () => {
  const baseUrl = parseEnv(process.env).database.url;
  database = await createThrowawayDatabase(baseUrl);
  await runMigrations(database.url);

  // The application reads its connection string from the environment through
  // `ConfigModule`, so pointing DATABASE_URL at the throwaway database is how
  // the real `AppModule` graph ends up talking to an isolated one — the same
  // reasoning as `auth.guards.e2e.test.ts`.
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RATE_LIMIT_CONFIG)
    .useValue(testRateLimits)
    .overrideProvider(SMS_SENDER)
    .useValue(new CapturingSmsSender(new StubSmsSender('test')))
    // NOT cosmetic. `Test.createTestingModule` installs Nest's `TestingLogger`
    // via `Logger.overrideLogger`, and that class overrides `log`, `warn`,
    // `debug` and `verbose` with EMPTY bodies. Without this line the
    // "no OTP code appears in any log" test below would pass against a logger
    // that discards everything, and would pass identically if the service
    // printed every code it ever generated. `auth.guards.e2e.test.ts` learned
    // this the same way.
    .setLogger(new ConsoleLogger())
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  db = app.get<Database>(DATABASE_CONNECTION);
  sms = app.get<CapturingSmsSender>(SMS_SENDER);
  limiter = app.get(RateLimiterService);
  tokens = app.get(TokenService);
  usersRepo = app.get(UsersRepository);
  otpService = app.get(OtpService);
});

afterAll(async () => {
  // This Redis is shared with other work — never FLUSHDB. Delete exactly the
  // keys this suite created: one per phone number per policy, and one attempt
  // counter per challenge row.
  const challenges = await db.select({ id: otpChallenges.id }).from(otpChallenges);
  await Promise.all([
    ...[...usedPhones].flatMap((phone) => [
      limiter.reset('otp-request', 'identifier', phone),
      limiter.reset('sign-in', 'identifier', phone),
    ]),
    ...challenges.map((challenge) => limiter.clearAttempts('otp-verify', challenge.id)),
  ]);

  // Closes the pool via DatabaseModule's onModuleDestroy, without which DROP
  // DATABASE blocks behind this process's own open session.
  await app.close();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  await database.drop();
});

describe('a new phone number can sign in', () => {
  it('issues a code, verifies it, and returns a usable token pair', async () => {
    const { phone, code } = await issueCode();

    const verified = await postVerify(phone, code, { deviceId: 'pixel-7' });

    expect(verified.status).toBe(200);
    const pair = verified.body as {
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresAt: string;
      refreshTokenExpiresAt: string;
    };

    // Not merely "a string came back": the token has to verify against the
    // service that issued it, or sign-in returned something no request could
    // ever use.
    const claims = tokens.verifyAccessToken(pair.accessToken);
    expect(claims.sub).toMatch(/^[0-9a-f-]{36}$/);
    // No role grant. Choosing customer or master is a separate decision on a
    // separate endpoint (`users.repository.ts` documents the role-less user as
    // a real state).
    expect(claims.roles).toEqual([]);

    // The refresh token is opaque, `<uuid>.<secret>`, and its shape is what
    // the refresh endpoint will parse.
    expect(tokens.parseRefreshToken(pair.refreshToken)).not.toBeNull();
    expect(new Date(pair.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());

    // The account was created by verification, not by the request — and the
    // session points at it, with the device the client named.
    const [account] = await db.select().from(users).where(eq(users.phoneE164, phone));
    expect(account?.id).toBe(claims.sub);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, claims.sid));
    expect(session?.userId).toBe(claims.sub);
    expect(session?.deviceId).toBe('pixel-7');
  });

  it('signs an existing account in without creating a second one', async () => {
    const phone = nextPhone();
    const existing = await usersRepo.create({ phoneE164: phone, roles: ['master'] });

    await postRequest(phone);
    const verified = await postVerify(phone, sms.lastCodeFor(phone));

    expect(verified.status).toBe(200);
    const claims = tokens.verifyAccessToken((verified.body as { accessToken: string }).accessToken);
    expect(claims.sub).toBe(existing.user.id);
    // The role set comes from the database at session start, never from the
    // sign-in request — a caller cannot ask to be signed in as a master.
    expect(claims.roles).toEqual(['master']);

    const rows = await db.select().from(users).where(eq(users.phoneE164, phone));
    expect(rows).toHaveLength(1);
  });

  it('treats two spellings of one number as one number', async () => {
    const phone = nextPhone();
    const national = `0${phone.slice('+994'.length)}`;

    await postRequest(phone);
    const code = sms.lastCodeFor(phone);

    // Requested as +994…, verified as 0… — normalisation happens on both
    // sides or the code simply never matches (ADR-0008: E.164 before storage
    // AND comparison).
    const verified = await postVerify(national, code);
    expect(verified.status).toBe(200);

    const rows = await db.select().from(users).where(eq(users.phoneE164, phone));
    expect(rows).toHaveLength(1);
  });
});

describe('the request endpoint is not a user-enumeration oracle', () => {
  it('answers byte-identically for a number with an account and one without', async () => {
    const known = nextPhone();
    await usersRepo.create({ phoneE164: known, roles: ['customer'] });
    const unknown = nextPhone();

    const knownResponse = await postRequest(known);
    const unknownResponse = await postRequest(unknown);

    expect(knownResponse.status).toBe(unknownResponse.status);
    // Compared as raw text, not as parsed objects: an extra field, a different
    // key order, or a number formatted differently would all be a signal, and
    // `toEqual` on the parsed bodies would hide two of the three. A success
    // envelope carries no requestId, so there is nothing to exclude.
    expect(knownResponse.text).toBe(unknownResponse.text);
    expect(knownResponse.body).toEqual({ expiresInSeconds: 300 });

    // Both really did send a code — an "identical" pair of responses where one
    // silently sent nothing would be worse than a distinguishable one.
    expect(sms.lastCodeFor(known)).toMatch(/^\d{6}$/);
    expect(sms.lastCodeFor(unknown)).toMatch(/^\d{6}$/);
  });

  it('creates no account for a number that only ever requested a code', async () => {
    const phone = nextPhone();

    await postRequest(phone);

    // If requesting a code created the account, this endpoint would be an
    // account-creation vector anyone could fire at any number in Azerbaijan,
    // and "does this number have an account?" would be answerable by asking.
    const rows = await db.select().from(users).where(eq(users.phoneE164, phone));
    expect(rows).toHaveLength(0);
  });

  it('rejects a number that is not a valid Azerbaijani one, without saying why', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: '+1 555 0100' });

    expect(response.status).toBe(422);
    const envelope = response.body as ErrorEnvelope;
    expect(envelope.error.code).toBe('VALIDATION_FAILED');
    // The normaliser distinguishes `not_azerbaijani` from `wrong_length` from
    // `not_a_valid_number` for the server log. None of that vocabulary may
    // reach a client: it is a free description of the numbering plan.
    const raw = JSON.stringify(response.body);
    for (const reason of ['not_azerbaijani', 'wrong_length', 'not_a_valid_number']) {
      expect(raw).not.toContain(reason);
    }
  });
});

describe('codes are stored hashed, never in the clear', () => {
  it('leaves the code in no column of the row it created', async () => {
    const { phone, code } = await issueCode();

    const [row] = await db.select().from(otpChallenges).where(eq(otpChallenges.phoneE164, phone));
    expect(row).toBeDefined();

    // Every column, stringified — not just `code_hash`. The failure this
    // guards against is somebody adding a `code` or `last_sent_body` column
    // later for debugging, which a targeted assertion would never notice.
    for (const [column, value] of Object.entries(row ?? {})) {
      expect(`${column}=${String(value)}`).not.toContain(code);
    }

    // And the digest is a digest: hex, SHA-256 width, and not the code padded
    // or encoded.
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(row?.codeHash ?? '', 'hex').toString('utf8')).not.toContain(code);
  });

  it('keys the digest, so a dump cannot be inverted by enumerating 10^6 codes', async () => {
    const { phone, code } = await issueCode();
    const [row] = await db.select().from(otpChallenges).where(eq(otpChallenges.phoneE164, phone));
    const id = row?.id ?? '';

    // The attack this test is about takes seconds, not centuries: a six-digit
    // code is ~20 bits, so anyone holding the table and an UNKEYED digest just
    // hashes all 10^6 candidates and reads off the live codes. Both unkeyed
    // spellings are computed here and both must be wrong.
    expect(row?.codeHash).not.toBe(createHash('sha256').update(code).digest('hex'));
    expect(row?.codeHash).not.toBe(createHash('sha256').update(`${id}|${code}`).digest('hex'));

    // And it must be the keyed digest — asserted positively, so a future
    // "simplification" to a bare hash fails here rather than passing both
    // negatives above by being something else again. The challenge id is part
    // of the input so two rows carrying the same code still hash differently.
    const pepper = process.env.OTP_CODE_PEPPER ?? '';
    expect(pepper).not.toBe('');
    expect(row?.codeHash).toBe(createHmac('sha256', pepper).update(`${id}|${code}`).digest('hex'));
  });
});

describe('a new code invalidates the previous one', () => {
  it('refuses the first code once a second has been requested', async () => {
    const phone = nextPhone();
    await postRequest(phone);
    const firstCode = sms.lastCodeFor(phone);

    await postRequest(phone);
    const secondCode = sms.lastCodeFor(phone);
    expect(secondCode).not.toBe(firstCode);

    // ADR-0008: "a new code invalidates the previous one — prevents a pool of
    // valid codes". Without this, every request would add another usable
    // credential to the same number.
    const stale = await postVerify(phone, firstCode);
    expect(stale.status).toBe(401);

    const fresh = await postVerify(phone, secondCode);
    expect(fresh.status).toBe(200);

    // And the reason is recorded, so support can tell "you asked for a second
    // code" apart from "somebody spent your attempts".
    const rows = await db.select().from(otpChallenges).where(eq(otpChallenges.phoneE164, phone));
    const superseded = rows.filter((row) => row.invalidatedReason === 'superseded');
    expect(superseded).toHaveLength(1);
  });

  it('leaves exactly one live challenge when two requests for one number overlap', async () => {
    const phone = nextPhone();

    // A double-tapped button. The partial unique index is what makes this lose
    // rather than quietly leave two redeemable codes; the request path retries
    // the loser's transaction, which then supersedes the winner's row.
    const [first, second] = await Promise.all([postRequest(phone), postRequest(phone)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await db.select().from(otpChallenges).where(eq(otpChallenges.phoneE164, phone));
    const live = rows.filter((row) => row.consumedAt === null && row.invalidatedAt === null);
    expect(rows).toHaveLength(2);
    expect(live).toHaveLength(1);
  });
});

describe('a code is redeemable once, and only while it lives', () => {
  it('rejects a code whose TTL has passed', async () => {
    const phone = nextPhone();
    usedPhones.add(phone);

    // Issued ten minutes ago, so it is past the five-minute ceiling by the
    // time it is presented. Driving the service with an explicit `now` rather
    // than rewriting `expires_at` afterwards keeps the row exactly as the
    // application would have written it — including the TTL arithmetic that is
    // the thing under test.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await otpService.request({ phoneE164: phone }, tenMinutesAgo);

    const expired = await postVerify(phone, sms.lastCodeFor(phone));

    expect(expired.status).toBe(401);
    const [row] = await db.select().from(otpChallenges).where(eq(otpChallenges.phoneE164, phone));
    expect(row?.consumedAt).toBeNull();
  });

  it('refuses a code that has already been redeemed', async () => {
    const { phone, code } = await issueCode();

    const first = await postVerify(phone, code);
    expect(first.status).toBe(200);

    const replay = await postVerify(phone, code);
    expect(replay.status).toBe(401);
  });

  it('answers a wrong code, an expired code and an unknown number with the same bytes', async () => {
    const { phone, code } = await issueCode();
    const neverRequested = nextPhone();

    const wrong = await postVerify(phone, wrongCodeFor(code));
    const unknown = await postVerify(neverRequested, code);

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    // "No code was ever requested for that number" versus "your guess was
    // wrong" is the enumeration oracle in its second form: it answers *"has
    // this number started signing in?"* to anyone who asks.
    expect(envelopeWithoutRequestId(wrong.body)).toEqual(envelopeWithoutRequestId(unknown.body));
  });
});

describe('the attempt cap bounds guessing one code', () => {
  it('counts each wrong guess and invalidates the code at the cap', async () => {
    const { phone, code } = await issueCode();
    const wrong = wrongCodeFor(code);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const refused = await postVerify(phone, wrong);
      expect(refused.status).toBe(401);
    }

    // ADR-0008: "max 5 attempts per code, then invalidate". The code is now
    // destroyed, so even the CORRECT one is refused — which is the whole
    // point: an attacker who exhausts the cap must not be able to keep going
    // by finally getting it right.
    const withTheRealCode = await postVerify(phone, code);
    expect(withTheRealCode.status).toBe(401);

    const [row] = await db.select().from(otpChallenges).where(eq(otpChallenges.phoneE164, phone));
    expect(row?.invalidatedReason).toBe('attempts_exhausted');
    expect(row?.consumedAt).toBeNull();
  });

  it('accepts the correct code on the last permitted attempt', async () => {
    const { phone, code } = await issueCode();
    const wrong = wrongCodeFor(code);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await postVerify(phone, wrong);
    }

    // Four wrong, then right on the fifth: the cap is five attempts, not four
    // plus a lockout. Getting this off by one would lock out every user who
    // mistyped as often as the policy allows.
    const verified = await postVerify(phone, code);
    expect(verified.status).toBe(200);
  });

  it('gives a newly requested code its own attempt budget', async () => {
    const phone = nextPhone();
    await postRequest(phone);
    const firstCode = sms.lastCodeFor(phone);
    const wrong = wrongCodeFor(firstCode);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await postVerify(phone, wrong);
    }

    // The counter is keyed by challenge id, not by phone number, so a spent
    // budget cannot be carried over. Otherwise an attacker could lock a victim
    // out permanently by burning the cap on every code they request.
    await postRequest(phone);
    const secondCode = sms.lastCodeFor(phone);
    const verified = await postVerify(phone, secondCode);

    expect(verified.status).toBe(200);
  });
});

describe('one code can be redeemed exactly once, including concurrently', () => {
  it('lets exactly one of several simultaneous verifications through', async () => {
    const { phone, code } = await issueCode();

    // The race ADR-0008 names: "successful verification consumes the code
    // atomically — prevents a race redeeming one code twice". Asserted as
    // EXACTLY one success, never "at least one": two sessions from one code is
    // the failure, and a test that accepted it would pass on a
    // read-then-write implementation that is wrong in exactly the way this
    // exists to catch.
    const responses = await Promise.all([
      postVerify(phone, code),
      postVerify(phone, code),
      postVerify(phone, code),
      postVerify(phone, code),
    ]);

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 401)).toHaveLength(3);

    // One winner, one account, one session — not four.
    const [account] = await db.select().from(users).where(eq(users.phoneE164, phone));
    expect(account).toBeDefined();
    const openedSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, account?.id ?? ''));
    expect(openedSessions).toHaveLength(1);

    const [row] = await db.select().from(otpChallenges).where(eq(otpChallenges.phoneE164, phone));
    expect(row?.consumedAt).not.toBeNull();
    // The losers must not have rewritten the row as invalidated: it was used,
    // and the audit trail has to say so.
    expect(row?.invalidatedAt).toBeNull();
  });
});

describe('no OTP code ever reaches a log', () => {
  it('logs the issue and the verification without the code, and without the full number', async () => {
    const sink: string[] = [];
    let spies: MockInstance[] = [];
    const phone = nextPhone();

    try {
      spies = spyOnEveryLogSink(sink);
      await postRequest(phone);
      const code = sms.lastCodeFor(phone);
      // A wrong guess and then the right one, so the log lines from every
      // branch of the flow — issue, refusal, success — are in the sink.
      await postVerify(phone, wrongCodeFor(code));
      await postVerify(phone, code);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }

    // Read back outside the spied region — the captured SMS is what the test
    // knows, and console is a real sink again by now.
    const issuedCode = sms.lastCodeFor(phone);
    const logged = sink.join('\n');

    // Positive control FIRST. A suite that passes because nothing was captured
    // is asserting nothing at all — and with Nest's `TestingLogger` installed
    // that is exactly what would happen (see `.setLogger` in `beforeAll`).
    expect(logged).toContain('otp code issued');
    expect(logged).toContain('otp verified');

    // ADR-0008: "codes never appear in logs, traces, or errors". The stub
    // sender is the documented exception and prints nothing under
    // NODE_ENV=test, which is the environment this suite runs in.
    expect(logged).not.toContain(issuedCode);
    // `docs/engineering/security.md` forbids a full phone number in a log; the
    // masked form is what makes a support conversation possible without one.
    expect(logged).not.toContain(phone);
    expect(logged).toContain(`+994*******${phone.slice(-2)}`);
  });

  it('keeps the code out of the response body on both endpoints', async () => {
    const { phone, code } = await issueCode();

    const requested = await postRequest(phone);
    const reissued = sms.lastCodeFor(phone);
    const verified = await postVerify(phone, reissued);

    expect(JSON.stringify(requested.body)).not.toContain(code);
    expect(JSON.stringify(requested.body)).not.toContain(reissued);
    expect(JSON.stringify(verified.body)).not.toContain(reissued);
  });
});

describe('both endpoints are rate limited over real HTTP', () => {
  it('answers 429 once one number has asked for too many codes', async () => {
    const phone = nextPhone();

    for (let index = 0; index < REQUEST_LIMIT; index += 1) {
      const allowed = await postRequest(phone);
      expect(allowed.status).toBe(200);
    }

    // ADR-0008 calls this a FINANCIAL control: every allowed request spends an
    // SMS, so an unthrottled endpoint spends TezUsta's budget. "Do not ship an
    // OTP endpoint without rate limiting, not even in staging."
    const refused = await postRequest(phone);
    expect(refused.status).toBe(429);
    expect((refused.body as ErrorEnvelope).error.code).toBe('RATE_LIMITED');
    expect(refused.headers['retry-after']).toBeDefined();
  });

  it('counts a differently-spelled number against the same budget', async () => {
    const phone = nextPhone();
    const national = `0${phone.slice('+994'.length)}`;

    for (let index = 0; index < REQUEST_LIMIT; index += 1) {
      expect((await postRequest(phone)).status).toBe(200);
    }

    // The guard normalises before it counts. Otherwise the limit is bypassed
    // with a space bar, and the budget is per *spelling* rather than per
    // person.
    const refused = await postRequest(national);
    expect(refused.status).toBe(429);
  });

  it('answers 429 once one number has guessed too many times', async () => {
    const phone = nextPhone();
    await postRequest(phone);
    const code = sms.lastCodeFor(phone);
    const wrong = wrongCodeFor(code);

    // The per-code attempt cap invalidates the code at five; this limit is the
    // other control, and it is what stops a caller simply asking for a new
    // code and guessing five more times, forever.
    for (let index = 0; index < VERIFY_LIMIT; index += 1) {
      const answered = await postVerify(phone, wrong);
      expect(answered.status).toBe(401);
    }

    const refused = await postVerify(phone, wrong);
    expect(refused.status).toBe(429);
    expect((refused.body as ErrorEnvelope).error.code).toBe('RATE_LIMITED');
  });
});

/**
 * The error envelope minus its `requestId`, which is fresh per request by
 * design and is therefore the one field that legitimately differs between two
 * responses that must otherwise be indistinguishable.
 */
function envelopeWithoutRequestId(body: unknown): unknown {
  const { error } = body as ErrorEnvelope;
  const { requestId: _requestId, ...rest } = error;
  return rest;
}
