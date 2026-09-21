import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { parseEnv } from '../src/infra/config/parse-env';
import { runMigrations } from '../src/infra/database/migrate';
import { PUSH_SENDER } from '../src/infra/push/push-sender.types';
import type { StubPushSender } from '../src/infra/push/stub-push-sender';
import { DevicesService } from '../src/modules/devices/devices.service';
import { PushReceiptsService } from '../src/modules/notifications/push-receipts.service';
import { PushTicketsRepository } from '../src/modules/notifications/push-tickets.repository';
import { UsersRepository } from '../src/modules/users/users.repository';
import type { ThrowawayDatabase } from './support/throwaway-database';
import { createThrowawayDatabase } from './support/throwaway-database';

/**
 * The push-receipt sweep against real Postgres and real Redis, through the
 * real `AppModule` graph (issue #142).
 *
 * **What only this layer can prove** is that the sweep is idempotent and
 * bounded. Both are properties of statements against a database: retiring an
 * already-retired device has to write nothing, and a run has to stop at its
 * ceiling with the rest of the backlog still waiting. A unit test over a
 * mocked repository would assert the mock.
 *
 * The receipts come from `StubPushSender`, which is the "fake receipt source"
 * the issue asks for — it answers about the very ids it issued, which is what
 * lets a test drive send → ticket → receipt end to end without a network.
 */

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+99471${String(phoneCounter).padStart(7, '0')}`;
}

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `ExponentPushToken[${String(tokenCounter).padStart(22, 'r')}]`;
}

interface Registered {
  readonly userId: string;
  readonly deviceId: string;
  readonly pushToken: string;
}

interface Revocation {
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
}

describe('the push receipt sweep (issue #142)', () => {
  let app: NestFastifyApplication;
  let database: ThrowawayDatabase;
  let pool: Pool;
  let users: UsersRepository;
  let devices: DevicesService;
  let tickets: PushTicketsRepository;
  let sweeper: PushReceiptsService;
  let push: StubPushSender;

  const saved = new Map<string, string | undefined>();

  function set(name: string, value: string): void {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  async function registerDevice(): Promise<Registered> {
    const created = await users.create({ phoneE164: nextPhone(), roles: [] });
    const pushToken = nextToken();
    const device = await devices.register(
      { userId: created.user.id, sessionId: randomUUID(), roles: [], status: 'active' },
      { expoPushToken: pushToken, platform: 'android' },
    );
    return { userId: created.user.id, deviceId: device.id, pushToken };
  }

  /**
   * A ticket old enough for the sweep to look at.
   *
   * `created_at` is pushed back rather than the clock being moved: the
   * min-age predicate is the thing under test, and a fixture that sidestepped
   * it would let a sweep that ignored the predicate pass.
   */
  async function ticketAged(
    deviceId: string,
    receiptId: string,
    ageMinutes: number,
  ): Promise<void> {
    await tickets.record([{ deviceId, receiptId }]);
    await pool.query(
      `update push_tickets set created_at = now() - make_interval(mins => $2) where receipt_id = $1`,
      [receiptId, ageMinutes],
    );
  }

  async function ticketCount(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      'select count(*) as count from push_tickets',
    );
    return Number(rows[0]?.count ?? '0');
  }

  async function revocationOf(deviceId: string): Promise<Revocation | undefined> {
    const { rows } = await pool.query<Revocation>(
      'select revoked_at, revoked_reason from devices where id = $1',
      [deviceId],
    );
    return rows[0];
  }

  beforeAll(async () => {
    const baseUrl = parseEnv(process.env).database.url;
    database = await createThrowawayDatabase(baseUrl);
    await runMigrations(database.url);

    set('DATABASE_URL', database.url);
    /**
     * The scheduler is switched off and the sweep is driven directly.
     *
     * What matters here is what one run does, and a five-minute scheduler
     * would either never fire inside a test or, turned down far enough to
     * fire, race every assertion with a second run. That the scheduler exists
     * and is upserted is `RecurringWorkService`'s own subject.
     */
    set('PUSH_RECEIPT_SWEEP_INTERVAL_SECONDS', '0');
    set('PUSH_RECEIPT_MIN_AGE_SECONDS', '900');
    set('PUSH_RECEIPT_RETENTION_HOURS', '24');
    set('PUSH_RECEIPT_MAX_PER_RUN', '5');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    users = app.get(UsersRepository);
    devices = app.get(DevicesService);
    tickets = app.get(PushTicketsRepository);
    sweeper = app.get(PushReceiptsService);
    push = app.get<StubPushSender>(PUSH_SENDER);

    pool = new Pool({ connectionString: database.url });
    pool.on('error', () => undefined);
  }, 180_000);

  beforeEach(async () => {
    await pool.query('delete from push_tickets');
    push.reset();
  });

  afterEach(() => {
    push.reset();
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await database?.drop();
  });

  describe('what each receipt is worth', () => {
    it('retires exactly one device when Expo says it is not registered', async () => {
      const device = await registerDevice();
      push.receiptOutcomes.set('r-gone', { status: 'unreachable' });
      await ticketAged(device.deviceId, 'r-gone', 20);

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ examined: 1, resolved: 1, retired: 1 });
      expect(await revocationOf(device.deviceId)).toMatchObject({ revoked_reason: 'unreachable' });
      expect(await ticketCount()).toBe(0);
    });

    it('excludes a retired device from the next send', async () => {
      const device = await registerDevice();
      push.receiptOutcomes.set('r-gone', { status: 'unreachable' });
      await ticketAged(device.deviceId, 'r-gone', 20);
      await sweeper.sweep();

      expect(await devices.addressableFor(device.userId)).toEqual([]);
    });

    it('leaves the device alone when delivery succeeded', async () => {
      const device = await registerDevice();
      await ticketAged(device.deviceId, 'r-ok', 20);

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ resolved: 1, retired: 0 });
      expect(await revocationOf(device.deviceId)).toMatchObject({ revoked_at: null });
    });

    it.each([
      ['transient', 'MessageRateExceeded'],
      ['credentials', 'InvalidCredentials'],
      ['sender-error', 'MessageTooBig'],
      ['unknown', 'SomethingExpoAddedLater'],
    ] as const)('retires nothing for a %s receipt', async (status, code) => {
      const device = await registerDevice();
      push.receiptOutcomes.set('r-x', { status, code, message: 'no' });
      await ticketAged(device.deviceId, 'r-x', 20);

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ resolved: 1, retired: 0 });
      expect(await revocationOf(device.deviceId)).toMatchObject({ revoked_at: null });
      // Resolved either way: the answer exists, so the row has done its job.
      expect(await ticketCount()).toBe(0);
    });
  });

  describe('a receipt that is not ready', () => {
    /**
     * Expo omits a receipt it has not produced. Reading the gap as a verdict
     * would delete the worklist row before its answer existed — the one
     * mistake that loses a dead token permanently.
     */
    it('leaves the ticket on the worklist', async () => {
      const device = await registerDevice();
      push.pendingReceiptIds.add('r-pending');
      await ticketAged(device.deviceId, 'r-pending', 20);

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ examined: 1, resolved: 0, retired: 0 });
      expect(await ticketCount()).toBe(1);
    });

    it('resolves it on a later run once the answer exists', async () => {
      const device = await registerDevice();
      push.pendingReceiptIds.add('r-later');
      await ticketAged(device.deviceId, 'r-later', 20);
      await sweeper.sweep();

      push.pendingReceiptIds.delete('r-later');
      push.receiptOutcomes.set('r-later', { status: 'unreachable' });
      const second = await sweeper.sweep();

      expect(second).toMatchObject({ resolved: 1, retired: 1 });
      expect(await revocationOf(device.deviceId)).toMatchObject({ revoked_reason: 'unreachable' });
    });
  });

  describe('when Expo may not be asked yet', () => {
    it('ignores a ticket younger than the recommended wait', async () => {
      const device = await registerDevice();
      await ticketAged(device.deviceId, 'r-young', 1);

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ examined: 0, resolved: 0 });
      expect(await ticketCount()).toBe(1);
    });
  });

  describe('retention', () => {
    it('drops a ticket past the window in which Expo would still answer', async () => {
      const device = await registerDevice();
      await ticketAged(device.deviceId, 'r-ancient', 25 * 60);

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ expired: 1, examined: 0 });
      expect(await ticketCount()).toBe(0);
      // Dropping a question nobody can answer is not a verdict on the device.
      expect(await revocationOf(device.deviceId)).toMatchObject({ revoked_at: null });
    });
  });

  describe('idempotency', () => {
    /**
     * The sweep re-reads tickets after a retry or a redeploy, so every action
     * it takes has to be a no-op the second time — and in particular the
     * recorded reason and timestamp of an already-retired device must survive.
     */
    it('changes nothing when the same run happens twice', async () => {
      const device = await registerDevice();
      push.receiptOutcomes.set('r-twice', { status: 'unreachable' });
      await ticketAged(device.deviceId, 'r-twice', 20);

      await sweeper.sweep();
      const firstRevocation = await revocationOf(device.deviceId);
      const second = await sweeper.sweep();

      expect(second).toMatchObject({ examined: 0, resolved: 0, retired: 0 });
      expect(await revocationOf(device.deviceId)).toEqual(firstRevocation);
    });

    it('does not re-retire a device a user had already unregistered', async () => {
      const device = await registerDevice();
      await pool.query(
        `update devices set revoked_at = now(), revoked_reason = 'unregistered' where id = $1`,
        [device.deviceId],
      );
      push.receiptOutcomes.set('r-late', { status: 'unreachable' });
      await ticketAged(device.deviceId, 'r-late', 20);

      const result = await sweeper.sweep();

      expect(result).toMatchObject({ resolved: 1, retired: 0 });
      // The reason the user's own sign-out recorded is the true one; a late
      // ticket about a push already in flight must not overwrite it.
      expect(await revocationOf(device.deviceId)).toMatchObject({
        revoked_reason: 'unregistered',
      });
    });
  });

  describe('bounds', () => {
    it('stops at its ceiling and leaves the rest for the next run', async () => {
      const device = await registerDevice();
      for (let i = 0; i < 8; i += 1) {
        await ticketAged(device.deviceId, `r-bulk-${String(i)}`, 20 + i);
      }

      const first = await sweeper.sweep();

      // PUSH_RECEIPT_MAX_PER_RUN is 5 in this suite.
      expect(first.examined).toBe(5);
      expect(await ticketCount()).toBe(3);

      const second = await sweeper.sweep();
      expect(second.examined).toBe(3);
      expect(await ticketCount()).toBe(0);
    });
  });

  describe('when the provider cannot be reached', () => {
    /**
     * The error escapes so BullMQ retries the job. The vendor client does not
     * retry this endpoint — only sends get its `promise-retry` — so the
     * queue's backoff is the only one a failure here will ever get, and
     * leaving every row in place is what makes coming back free.
     */
    it('leaves every ticket alone and lets the failure escape', async () => {
      const device = await registerDevice();
      await ticketAged(device.deviceId, 'r-unreachable-provider', 20);
      push.failReceiptsWith = new Error('socket hang up');

      await expect(sweeper.sweep()).rejects.toThrow('socket hang up');

      expect(await ticketCount()).toBe(1);
      expect(await revocationOf(device.deviceId)).toMatchObject({ revoked_at: null });
    });
  });
});
