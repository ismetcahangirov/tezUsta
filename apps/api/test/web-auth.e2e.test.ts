import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { MasterSubscription, SubscriptionCheckout, WebSession } from '@tezusta/types';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { ErrorEnvelope } from '../src/common/errors/error-envelope.types';
import { BILLING_PROVIDER } from '../src/infra/billing/billing.types';
import type { StubBillingProvider } from '../src/infra/billing/stub-billing.provider';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import type { EmailSender, OutboundEmail } from '../src/infra/email/email-sender.types';
import { EMAIL_SENDER } from '../src/infra/email/email-sender.types';
import { StubEmailSender } from '../src/infra/email/stub-email-sender';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The master's web subscription page's sign-in, over real HTTP
 * ([ADR-0061](docs/decisions/ADR-0061-master-web-subscription-page.md)).
 *
 * What is asserted is the boundary the ADR draws:
 *
 * - only an active master is ever mailed a code, and every address gets the same answer;
 * - a verified code opens a `web` session, in httpOnly cookies, never a body token;
 * - the web cookie reaches the `@WebSurface()` routes with the CSRF header,
 *   and nothing else;
 * - an app token and a web token are never each other;
 * - and the whole purchase works from the web session: sign in, check out,
 *   the provider's webhook, and the app reads the subscription active.
 */

const CSRF = { 'x-tezusta-web': '1' };

let emailCounter = 0;
function nextEmail(): string {
  emailCounter += 1;
  return `user-${String(emailCounter)}@example.com`;
}

class CapturingEmailSender implements EmailSender {
  readonly sent: OutboundEmail[] = [];

  constructor(private readonly inner: EmailSender) {}

  async send(message: OutboundEmail): Promise<void> {
    this.sent.push(message);
    await this.inner.send(message);
  }

  to(email: string): OutboundEmail[] {
    return this.sent.filter((message) => message.to === email);
  }

  lastCodeFor(email: string): string {
    const message = this.to(email).at(-1);
    const match = message === undefined ? null : /\d{4,12}/.exec(message.text);
    if (match === null) {
      throw new Error(`No code was mailed to ${email}.`);
    }
    return match[0];
  }
}

interface Master {
  readonly email: string;
  readonly userId: string;
  readonly masterId: string;
  /** The app's bearer token, for the app-side assertions. */
  readonly appToken: string;
}

/** The two session cookies a successful web sign-in sets, as a `Cookie` header. */
interface WebCookies {
  readonly header: string;
  readonly setCookie: readonly string[];
}

describe('the web subscription page sign-in (ADR-0061)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let mail: CapturingEmailSender;
  let stub: StubBillingProvider;
  let usersRepo: UsersRepository;
  let sessions: SessionsService;

  const saved = new Map<string, string | undefined>();
  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  function http() {
    return request(app.getHttpServer());
  }

  async function seedMaster(verification = 'active'): Promise<Master> {
    const email = nextEmail();
    const created = await usersRepo.create({ email, roles: [] });
    const appToken = (await sessions.startSession({ userId: created.user.id })).accessToken;
    const profile = await http()
      .post('/masters')
      .set('authorization', `Bearer ${appToken}`)
      .send({ displayName: 'Usta Rauf' });
    expect(profile.status).toBe(201);
    const masterId = (profile.body as { id: string }).id;
    await pool.query('update masters set verification_status = $2 where id = $1', [
      masterId,
      verification,
    ]);
    return { email, userId: created.user.id, masterId, appToken };
  }

  async function seedCustomer(): Promise<string> {
    const email = nextEmail();
    await usersRepo.create({ email, roles: ['customer'] });
    return email;
  }

  function requestCode(email: string) {
    return http().post('/web/auth/otp/request').send({ email });
  }

  function verify(email: string, code: string, headers: Record<string, string> = CSRF) {
    return http().post('/web/auth/otp/verify').set(headers).send({ email, code });
  }

  function cookiesOf(response: request.Response): WebCookies {
    const raw = response.headers['set-cookie'] as unknown;
    const setCookie = Array.isArray(raw) ? (raw as string[]) : [];
    const header = setCookie.map((line) => line.split(';')[0]).join('; ');
    return { header, setCookie };
  }

  async function signInOnWeb(master: Master): Promise<WebCookies> {
    expect((await requestCode(master.email)).status).toBe(200);
    const response = await verify(master.email, mail.lastCodeFor(master.email));
    expect(response.status).toBe(200);
    return cookiesOf(response);
  }

  function withWeb(method: 'get' | 'post' | 'delete', path: string, cookies: WebCookies) {
    return http()[method](path).set('cookie', cookies.header).set(CSRF);
  }

  function codeOf(response: request.Response): string {
    return (response.body as ErrorEnvelope).error.code;
  }

  beforeAll(async () => {
    database = await createThrowawayDatabase(parseEnv(process.env).database.url);
    await runMigrations(database.url);
    set('DATABASE_URL', database.url);
    // The per-IP halves of the budgets are somebody else's subject; every
    // request here comes from one test address.
    set('OTP_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('SIGNIN_RATE_LIMIT_PER_IP_HOUR', '9000');
    set('REFRESH_RATE_LIMIT_PER_IP_HOUR', '9000');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(new CapturingEmailSender(new StubEmailSender('test')))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    mail = app.get<CapturingEmailSender>(EMAIL_SENDER);
    stub = app.get<StubBillingProvider>(BILLING_PROVIDER);
    usersRepo = app.get(UsersRepository);
    sessions = app.get(SessionsService);
    pool = new Pool({ connectionString: database.url });

    const adminId = randomUUID();
    await pool.query(
      `insert into admin_users (id, email, display_name) values ($1, 'web@tezusta.az', 'Admin')`,
      [adminId],
    );
    for (const [period, minor] of [
      ['monthly', 1500],
      ['yearly', 15000],
    ] as const) {
      await pool.query(
        `insert into subscription_prices (id, billing_period, price_minor, effective_from, created_by_admin_id)
         values ($1, $2, $3, now() - interval '1 second', $4)`,
        [randomUUID(), period, minor, adminId],
      );
    }
  }, 120_000);

  beforeEach(async () => {
    await pool.query('update subscription_settings set purchases_open = true where id = 1');
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
    await database.drop();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  describe('who is mailed a code', () => {
    it('mails an active master, and gives every other address the same answer and no email', async () => {
      const master = await seedMaster();
      const customer = await seedCustomer();
      const stranger = nextEmail();

      const answers = [];
      for (const email of [master.email, customer, stranger]) {
        const response = await requestCode(email);
        expect(response.status).toBe(200);
        answers.push(response.body as unknown);
      }

      expect(answers[1]).toStrictEqual(answers[0]);
      expect(answers[2]).toStrictEqual(answers[0]);
      expect(mail.to(master.email)).toHaveLength(1);
      expect(mail.to(customer)).toHaveLength(0);
      expect(mail.to(stranger)).toHaveLength(0);
    });

    it('creates no account for an address it has never seen', async () => {
      const stranger = nextEmail();
      await requestCode(stranger);
      const refused = await verify(stranger, '000000');

      expect(refused.status).toBe(401);
      const { rows } = await pool.query('select 1 from users where email = $1', [stranger]);
      expect(rows).toHaveLength(0);
    });

    it('refuses a customer exactly as it refuses a wrong code, even with a code the app sent', async () => {
      const master = await seedMaster();
      await requestCode(master.email);
      const wrong = await verify(master.email, '000000');

      const customer = await seedCustomer();
      // A code the app path issued for the customer's own sign-in.
      expect((await http().post('/auth/otp/request').send({ email: customer })).status).toBe(200);
      const refused = await verify(customer, mail.lastCodeFor(customer));

      expect(refused.status).toBe(wrong.status);
      expect(codeOf(refused)).toBe(codeOf(wrong));
      // Not consumed: the customer can still sign in to the app with it.
      const app = await http()
        .post('/auth/otp/verify')
        .send({ email: customer, code: mail.lastCodeFor(customer) });
      expect(app.status).toBe(200);
    });
  });

  describe('the web session', () => {
    it('is two httpOnly, SameSite=Strict cookies and no token in the body, on a web session row', async () => {
      const master = await seedMaster();
      await requestCode(master.email);
      const response = await verify(master.email, mail.lastCodeFor(master.email));

      expect(response.status).toBe(200);
      const body = response.body as WebSession;
      expect(Object.keys(body)).toStrictEqual(['sessionExpiresAt']);
      const hours = (Date.parse(body.sessionExpiresAt) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(11.9);
      expect(hours).toBeLessThanOrEqual(12);

      const { setCookie } = cookiesOf(response);
      expect(setCookie.map((line) => line.split('=')[0]).sort()).toStrictEqual([
        'tz_web_at',
        'tz_web_rt',
      ]);
      for (const line of setCookie) {
        expect(line).toContain('HttpOnly');
        expect(line).toContain('SameSite=Strict');
      }

      const { rows } = await pool.query<{ surface: string }>(
        'select surface from sessions where user_id = $1 order by created_at desc limit 1',
        [master.userId],
      );
      expect(rows[0]?.surface).toBe('web');
    });

    it('refuses a sign-in without the CSRF header, and consumes nothing', async () => {
      const master = await seedMaster();
      await requestCode(master.email);
      const code = mail.lastCodeFor(master.email);

      expect((await verify(master.email, code, {})).status).toBe(403);
      expect((await verify(master.email, code)).status).toBe(200);
    });

    it('reaches the subscription routes, with the CSRF header and only with it', async () => {
      const master = await seedMaster();
      const cookies = await signInOnWeb(master);

      expect((await withWeb('get', '/subscription', cookies)).status).toBe(200);
      expect((await withWeb('get', '/masters/me/subscription/auto-renewal', cookies)).status).toBe(
        200,
      );

      const noHeader = await http().get('/subscription').set('cookie', cookies.header);
      expect(noHeader.status).toBe(401);
    });

    it('reaches nothing else', async () => {
      const master = await seedMaster();
      const cookies = await signInOnWeb(master);

      for (const path of ['/orders', '/masters/me', '/auth/sessions', '/masters/me/jobs/current']) {
        const response = await withWeb('get', path, cookies);
        expect({ path, status: response.status }).toStrictEqual({ path, status: 401 });
      }
    });

    it('is never an app token, and an app token is never a web cookie', async () => {
      const master = await seedMaster();
      const cookies = await signInOnWeb(master);
      const webToken = /tz_web_at=([^;]+)/.exec(cookies.header)?.[1] ?? '';

      const asBearer = await http().get('/subscription').set('authorization', `Bearer ${webToken}`);
      expect(asBearer.status).toBe(401);

      const asCookie = await http()
        .get('/subscription')
        .set('cookie', `tz_web_at=${master.appToken}`)
        .set(CSRF);
      expect(asCookie.status).toBe(401);

      // The app's own bearer token still works on the same route.
      const app = await http()
        .get('/subscription')
        .set('authorization', `Bearer ${master.appToken}`);
      expect(app.status).toBe(200);
    });

    it('rotates on refresh, refuses a web refresh token at the app refresh, and ends on sign-out', async () => {
      const master = await seedMaster();
      const cookies = await signInOnWeb(master);
      const refreshToken = /tz_web_rt=([^;]+)/.exec(cookies.header)?.[1] ?? '';

      const atApp = await http().post('/auth/refresh').send({ refreshToken });
      expect(atApp.status).toBe(401);

      const refreshed = await withWeb('post', '/web/auth/refresh', cookies);
      expect(refreshed.status).toBe(200);
      const next = cookiesOf(refreshed);
      expect(next.setCookie).toHaveLength(2);

      expect((await withWeb('post', '/web/auth/sign-out', next)).status).toBe(204);
      expect((await withWeb('get', '/subscription', next)).status).toBe(401);
      expect((await withWeb('post', '/web/auth/refresh', next)).status).toBe(401);
    });

    it('is listed among the master’s sessions in the app, and ends with "sign out everywhere"', async () => {
      const master = await seedMaster();
      const cookies = await signInOnWeb(master);

      const listed = await http()
        .get('/auth/sessions')
        .set('authorization', `Bearer ${master.appToken}`);
      expect(listed.status).toBe(200);
      expect((listed.body as unknown[]).length).toBeGreaterThanOrEqual(2);

      expect(
        (await http().post('/auth/logout-all').set('authorization', `Bearer ${master.appToken}`))
          .status,
      ).toBe(204);
      expect((await withWeb('get', '/subscription', cookies)).status).toBe(401);
    });
  });

  describe('buying from the web', () => {
    it('signs in, checks out, and the app reads the subscription active once the provider confirms', async () => {
      const master = await seedMaster();
      const cookies = await signInOnWeb(master);

      const started = await withWeb('post', '/masters/me/subscription/checkout', cookies).send({
        billingPeriod: 'monthly',
      });
      expect(started.status).toBe(201);
      expect((started.body as SubscriptionCheckout).checkoutUrl).toMatch(/^https:\/\//);

      const { rows } = await pool.query<{ provider_ref: string }>(
        `select provider_ref from subscription_checkouts
          where master_id = $1 order by created_at desc limit 1`,
        [master.masterId],
      );
      const delivery = stub.pay(rows[0]?.provider_ref ?? '');
      const webhook = await http()
        .post('/webhooks/billing/stub')
        .set(delivery.headers)
        .send(delivery.body.toString('utf8'));
      expect(webhook.status).toBe(200);

      const fromApp = await http()
        .get('/masters/me/subscription')
        .set('authorization', `Bearer ${master.appToken}`);
      expect(fromApp.status).toBe(200);
      expect((fromApp.body as MasterSubscription).status).toBe('active');
    });

    it('lets an unverified master sign in, but not check out', async () => {
      const master = await seedMaster('pending_verification');
      const cookies = await signInOnWeb(master);

      const refused = await withWeb('post', '/masters/me/subscription/checkout', cookies).send({
        billingPeriod: 'monthly',
      });
      // `MasterNotEligibleError`: the same refusal the app's path gives.
      expect(refused.status).toBe(409);
      expect((refused.body as ErrorEnvelope).error.details).toMatchObject({
        verificationStatus: 'pending_verification',
      });
      const { rows } = await pool.query(
        'select 1 from subscription_checkouts where master_id = $1',
        [master.masterId],
      );
      expect(rows).toHaveLength(0);
    });

    it('offers nothing while purchases are closed', async () => {
      await pool.query('update subscription_settings set purchases_open = false where id = 1');
      const master = await seedMaster();
      const cookies = await signInOnWeb(master);

      const offer = await withWeb('get', '/subscription', cookies);
      expect((offer.body as { purchasesOpen: boolean }).purchasesOpen).toBe(false);

      const refused = await withWeb('post', '/masters/me/subscription/checkout', cookies).send({
        billingPeriod: 'monthly',
      });
      expect(refused.status).toBe(409);
      expect(codeOf(refused)).toBe('SUBSCRIPTION_PURCHASES_CLOSED');
    });
  });
});
