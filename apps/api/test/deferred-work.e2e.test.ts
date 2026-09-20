// Tighten the retry policy BEFORE anything imports the config module: the
// shipped defaults are 3 attempts with a 5s exponential backoff, which is
// right for production and would make the retry assertion below a 15-second
// test. `parseEnv` reads `process.env` once, when `APP_CONFIG` is first
// resolved, so setting these at module scope is what makes them apply.
process.env.QUEUE_JOB_ATTEMPTS = '2';
process.env.QUEUE_JOB_BACKOFF_MS = '100';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import type { AppConfig } from '../src/infra/config/app-config.types';
import { APP_CONFIG } from '../src/infra/config/config.tokens';
import { parseEnv } from '../src/infra/config/parse-env';
import { DeferredJobHandlerRegistry } from '../src/infra/queue/deferred-job-handler.registry';
import { DeferredWorkService } from '../src/infra/queue/deferred-work.service';
import { DISPATCH_QUEUE, MAINTENANCE_QUEUE } from '../src/infra/queue/queue.constants';
import { createQueueReadinessCheck } from '../src/infra/queue/queue.module';
import { RecurringWorkService } from '../src/infra/queue/recurring-work.service';
import { createBullmqRedisClient } from '../src/infra/redis/bullmq-connection.provider';
import type { ReadinessReport } from '../src/modules/health/health.types';

/** Polls `condition` rather than sleeping a fixed amount — a fixed sleep is
 * either flaky or slow, and against a real Redis it is usually both. */
async function eventually(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition was still false after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * The delay the first test schedules with, named because the assertion
 * compares against the same number: a threshold and a delay that can drift
 * apart is how the wall-clock assertion this file used to carry became wrong
 * (issue #122).
 */
const DELAY_MS = 1000;

function defer(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Issue #102 delivers a mechanism, not a feature, so these tests are about the
 * mechanism's guarantees: a job enqueued now runs later, a failing job is
 * retried rather than lost, one run's jobs are invisible to another's, the
 * readiness probe tells the truth, and a shutdown does not drop the tick in
 * flight. Every one of them runs against the real local Redis — no fake
 * timers, because the thing under test is precisely what happens while the
 * process is not looking.
 */
describe('deferred work on BullMQ', () => {
  let app: NestFastifyApplication;
  let handlers: DeferredJobHandlerRegistry;
  let deferredWork: DeferredWorkService;
  let config: AppConfig;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    handlers = app.get(DeferredJobHandlerRegistry);
    deferredWork = app.get(DeferredWorkService);
    config = app.get<AppConfig>(APP_CONFIG);
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs a job that was enqueued with a delay, after that delay', async () => {
    let ranAt: number | undefined;
    handlers.register('delayed-tick', () => {
      ranAt = Date.now();
      return Promise.resolve();
    });

    const enqueuedAt = Date.now();
    await deferredWork.schedule('delayed-tick', { orderId: 'order-1' }, { delayMs: DELAY_MS });

    await eventually(() => ranAt !== undefined);

    // The whole assertion, and deliberately the only one (issue #122). "The
    // delay was honoured" is a statement about this job's own enqueue time,
    // so that is what it is measured against — a comparison that is true
    // however fast or slow the host is.
    //
    // What used to be here as well: a `expect(ranAt).toBeUndefined()` 300 ms
    // in, which asserts the SCHEDULER is slower than 300 ms. That is a claim
    // about the machine, not about BullMQ, and a loaded machine running a
    // full `pnpm verify` falsified it. The mechanism is still pinned — set
    // the `delayMs` above to 0 and this fails — and nothing about the host
    // can make it pass when the delay is ignored.
    expect((ranAt ?? 0) - enqueuedAt).toBeGreaterThanOrEqual(DELAY_MS);
  });

  it('hands the handler the payload it was scheduled with', async () => {
    let seen: unknown;
    handlers.register('payload-tick', (payload) => {
      seen = payload;
      return Promise.resolve();
    });

    await deferredWork.schedule('payload-tick', { orderId: 'order-2', wave: 3 }, { delayMs: 0 });

    await eventually(() => seen !== undefined);
    expect(seen).toEqual({ orderId: 'order-2', wave: 3 });
  });

  it('retries a job whose handler throws, up to the configured attempt count, and stays up', async () => {
    let attempts = 0;
    handlers.register('failing-tick', () => {
      attempts += 1;
      return Promise.reject(new Error('deliberate failure'));
    });

    await deferredWork.schedule('failing-tick', {}, { delayMs: 0 });

    // QUEUE_JOB_ATTEMPTS is 2 for this file (set at the top), so the job runs
    // twice in total and then goes to the failed set.
    await eventually(() => attempts >= config.queue.jobAttempts);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(attempts).toBe(config.queue.jobAttempts);

    // The process is still serving — a throwing job must never take the API
    // down with it.
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('collapses two schedules sharing a job id into one job, so a deadline cannot be set twice', async () => {
    let runs = 0;
    handlers.register('idempotent-tick', () => {
      runs += 1;
      return Promise.resolve();
    });

    const jobId = `deadline-${String(Date.now())}`;
    await deferredWork.schedule('idempotent-tick', {}, { delayMs: 300, jobId });
    await deferredWork.schedule('idempotent-tick', {}, { delayMs: 300, jobId });

    await eventually(() => runs > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(runs).toBe(1);
  });

  it('does not run a job that was cancelled before it came due', async () => {
    let ran = false;
    handlers.register('cancelled-tick', () => {
      ran = true;
      return Promise.resolve();
    });

    const jobId = `cancelled-${String(Date.now())}`;
    await deferredWork.schedule('cancelled-tick', {}, { delayMs: 1500, jobId });
    expect(await deferredWork.cancel(jobId)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(ran).toBe(false);
  });

  it('reports the queue connection on /health/ready', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');

    expect(res.status).toBe(200);
    const body = res.body as ReadinessReport;
    expect(body.checks.queue).toEqual({ status: 'up' });
  });

  describe('prefix isolation', () => {
    /**
     * The acceptance criterion behind `QUEUE_PREFIX`: two runs against one
     * Redis must not see each other's jobs. Asserted from the outside — a
     * queue opened under a different prefix is used to look for the job this
     * app enqueued, and must not find it.
     */
    it('makes a job enqueued under one prefix invisible under another', async () => {
      const jobId = `isolated-${String(Date.now())}`;
      handlers.register('isolated-tick', () => Promise.resolve());
      await deferredWork.schedule('isolated-tick', {}, { delayMs: 30_000, jobId });

      const connection = createBullmqRedisClient(config.redis.url);
      const ownPrefix = new Queue(DISPATCH_QUEUE, { connection, prefix: config.queue.prefix });
      const otherPrefix = new Queue(DISPATCH_QUEUE, {
        connection,
        prefix: `${config.queue.prefix}-other`,
      });

      try {
        expect(await ownPrefix.getJob(jobId)).toBeDefined();
        expect(await otherPrefix.getJob(jobId)).toBeUndefined();
        expect(await otherPrefix.getDelayedCount()).toBe(0);
      } finally {
        await ownPrefix.close();
        await otherPrefix.close();
        connection.disconnect();
      }
    });
  });
});

describe('the queue readiness check', () => {
  /**
   * Asserted against a connection pointed at a closed port rather than by
   * stopping the shared Redis container, which would make every other suite
   * flaky — the same argument `infra-resilience.test.ts` makes for the
   * reconnect strategy.
   */
  it('reports the queue as down when its Redis is unreachable', async () => {
    // 6399 is not in docker-compose.yml, so nothing is listening on it.
    const connection = createBullmqRedisClient('redis://localhost:6399');

    try {
      await expect(createQueueReadinessCheck(connection).check()).rejects.toThrow(
        /BullMQ Redis connection is/,
      );
    } finally {
      connection.disconnect();
    }
  });

  it('reports up against a connection that is actually ready', async () => {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const connection = createBullmqRedisClient(url);

    try {
      await new Promise<void>((resolve, reject) => {
        connection.once('ready', resolve);
        connection.once('error', reject);
      });
      await expect(createQueueReadinessCheck(connection).check()).resolves.toBeUndefined();
    } finally {
      connection.disconnect();
    }
  });
});

describe('shutdown', () => {
  /**
   * The guarantee a rolling deploy depends on: `SIGTERM` arrives while a tick
   * is running, and the tick is neither killed nor silently dropped. Nest
   * turns a signal into the same `app.close()` this test calls, so closing the
   * app is the honest way to assert it.
   */
  it('waits for an in-flight job before the module finishes shutting down', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = await moduleRef
      .createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      .init();

    const handlers = app.get(DeferredJobHandlerRegistry);
    const deferredWork = app.get(DeferredWorkService);

    const gate = defer();
    let started = false;
    let finished = false;

    handlers.register('slow-tick', async () => {
      started = true;
      await gate.promise;
      finished = true;
    });

    await deferredWork.schedule('slow-tick', {}, { delayMs: 0 });
    await eventually(() => started);

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });

    // Shutdown must still be waiting on the handler, not past it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(closed).toBe(false);
    expect(finished).toBe(false);

    gate.release();
    await closing;

    expect(finished).toBe(true);
  });
});

describe('QUEUE_WORKER_MODE=off', () => {
  /**
   * The flag half of extracting a separate worker deployment later
   * ([ADR-0025](docs/decisions/ADR-0025-deferred-work-on-bullmq.md)): a
   * producer-only replica must enqueue normally and consume nothing.
   *
   * It is asserted here rather than left to a manual check because the
   * guarantee lives in a single early `return` in
   * `DispatchProcessor.onApplicationBootstrap`. Without a test, a later
   * refactor could start that replica's worker again and nothing would say
   * so — and the failure mode is silent: a replica deliberately deployed as
   * a producer would quietly begin competing for jobs.
   *
   * The prefix is deliberately its own. This process already has an app with
   * a running worker on the suite's prefix, and a job nobody is meant to
   * consume would otherwise be consumed by it — the test would fail for a
   * reason that has nothing to do with the flag.
   */
  it('enqueues jobs and consumes none, on every queue', async () => {
    const base = parseEnv(process.env);
    const producerOnly: AppConfig = {
      ...base,
      queue: { ...base.queue, workerMode: 'off', prefix: `${base.queue.prefix}-producer-only` },
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(producerOnly)
      .compile();
    const app = await moduleRef
      .createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      .init();

    try {
      let ran = false;
      const registry = app.get(DeferredJobHandlerRegistry);
      registry.register('never-consumed', async () => {
        ran = true;
        return Promise.resolve();
      });

      // Both queues, because there are two workers now and the flag is only
      // worth something if it silences both. A test that covered whichever
      // queue happened to have one would pass while a `maintenance` worker
      // on a replica deployed as a producer quietly swept the database.
      let sweptOnAProducer = false;
      registry.register('never-swept', async () => {
        sweptOnAProducer = true;
        return Promise.resolve();
      });

      await app.get(DeferredWorkService).schedule('never-consumed', {}, { delayMs: 0 });
      await app.get(RecurringWorkService).runNow('never-swept');

      // Long enough that a running worker would certainly have picked it up:
      // the delay test above sees a zero-delay job run well inside 300 ms.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(ran).toBe(false);
      expect(sweptOnAProducer).toBe(false);

      // And the jobs are genuinely waiting, not lost — which is what makes
      // the assertions above statements about the workers rather than about
      // the producers having quietly failed.
      const connection = createBullmqRedisClient(producerOnly.redis.url);
      const dispatch = new Queue(DISPATCH_QUEUE, {
        connection,
        prefix: producerOnly.queue.prefix,
      });
      const maintenance = new Queue(MAINTENANCE_QUEUE, {
        connection,
        prefix: producerOnly.queue.prefix,
      });
      try {
        expect(await dispatch.getWaitingCount()).toBe(1);
        expect(await maintenance.getWaitingCount()).toBe(1);
      } finally {
        await dispatch.close();
        await maintenance.close();
        connection.disconnect();
      }
    } finally {
      await app.close();
    }
  });
});
