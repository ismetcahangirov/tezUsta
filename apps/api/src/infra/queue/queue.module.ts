import { Inject, Logger, Module } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { HealthModule } from '../../modules/health/health.module';
import type { ReadinessCheck } from '../../modules/health/health.types';
import { ReadinessCheckRegistry } from '../../modules/health/readiness-check.registry';
import { BullmqConnectionModule } from '../redis/bullmq-connection.module';
import { BULLMQ_REDIS_CLIENT } from '../redis/redis.tokens';
import { DeferredJobHandlerRegistry } from './deferred-job-handler.registry';
import { DeferredWorkService } from './deferred-work.service';
import { DispatchProcessor } from './dispatch.processor';
import { MaintenanceProcessor } from './maintenance.processor';
import { DISPATCH_QUEUE, MAINTENANCE_QUEUE } from './queue.constants';
import { RecurringWorkService } from './recurring-work.service';

/**
 * The `queue` entry on `GET /health/ready`.
 *
 * Exported as a function taking the connection — rather than written inline in
 * `onModuleInit` — for the reason `redisRetryStrategy` is: a test can then
 * assert the behaviour that matters (it reports down when Redis is gone)
 * against a connection pointed at a dead port, instead of stopping the shared
 * Redis container and making every other suite flaky.
 *
 * The status guard is not decoration. This connection carries
 * `maxRetriesPerRequest: null` because BullMQ requires it, so a PING issued
 * while Redis is unreachable does not fail — ioredis parks it in the offline
 * queue and retries it forever. `HealthService`'s 2s timeout would still
 * answer the probe, but every probe would leave a command behind. Checking
 * the status first turns "Redis is gone" into an immediate, garbage-free
 * `down`.
 */
export function createQueueReadinessCheck(connection: Redis): ReadinessCheck {
  return {
    name: 'queue',
    check: async () => {
      if (connection.status !== 'ready') {
        throw new Error(`BullMQ Redis connection is "${connection.status}"`);
      }
      await connection.ping();
    },
  };
}

/**
 * The mechanism for work that happens **later, with nobody making a request**
 * — [ADR-0025](../../../../../docs/decisions/ADR-0025-deferred-work-on-bullmq.md).
 *
 * Dispatch is the first thing that needs it (widen the radius in 30 seconds,
 * give up at 3 minutes — ADR-0009, ADR-0015), but there is no dispatch logic
 * here and there should never be: this module registers a queue, a worker and
 * a handler registry, and `modules/matching` (#103) supplies what the jobs
 * mean. That split is what keeps `infra/` fanning out into `modules/` rather
 * than the reverse, the same rule `CacheModule` and `RateLimitModule` follow.
 *
 * **The worker runs in this process**, which `backend-architecture.md`
 * § Background jobs does not describe — it says "BullMQ, in a separate worker
 * process". ADR-0025 records the deviation and its trigger. The shape here is
 * chosen so the extraction is additive: a second bootstrap file that imports
 * this module and the feature modules whose handlers it must serve, plus
 * `QUEUE_WORKER_MODE=off` on the API. Nothing in this module changes.
 */
@Module({
  imports: [
    HealthModule,
    // Imported here as well as inside `forRootAsync` below, so this module's
    // own constructor can inject the client it is responsible for closing.
    BullmqConnectionModule,
    BullModule.forRootAsync({
      // The dedicated connection, never REDIS_CLIENT — a BullMQ Worker throws
      // at construction on a client whose `maxRetriesPerRequest` is set, and
      // REDIS_CLIENT's `1` is load-bearing for `/health/ready`. The long
      // version is in `infra/redis/bullmq-connection.provider.ts`.
      imports: [BullmqConnectionModule],
      inject: [APP_CONFIG, BULLMQ_REDIS_CLIENT],
      useFactory: (config: AppConfig, connection: Redis) => ({
        // Passing a client INSTANCE rather than options also means BullMQ
        // treats the connection as shared and will not disconnect it when a
        // queue or worker closes. This module owns it instead — see
        // `onModuleDestroy`.
        connection,
        prefix: config.queue.prefix,
      }),
    }),
    BullModule.registerQueue({ name: DISPATCH_QUEUE }, { name: MAINTENANCE_QUEUE }),
  ],
  providers: [
    DeferredJobHandlerRegistry,
    DeferredWorkService,
    RecurringWorkService,
    DispatchProcessor,
    MaintenanceProcessor,
  ],
  // `DeferredWorkService` and the registry, never the `Queue` or the
  // connection: a feature module that could reach the raw queue could also
  // reach around every decision this module makes about retries, ids and
  // shutdown.
  exports: [DeferredWorkService, RecurringWorkService, DeferredJobHandlerRegistry],
})
export class QueueModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueModule.name);

  constructor(
    @InjectQueue(DISPATCH_QUEUE) private readonly dispatchQueue: Queue,
    @InjectQueue(MAINTENANCE_QUEUE) private readonly maintenanceQueue: Queue,
    @Inject(BULLMQ_REDIS_CLIENT) private readonly connection: Redis,
    private readonly dispatchProcessor: DispatchProcessor,
    private readonly maintenanceProcessor: MaintenanceProcessor,
    private readonly registry: ReadinessCheckRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(createQueueReadinessCheck(this.connection));
  }

  /**
   * Drains here, in `onModuleDestroy`, rather than leaving it to
   * `@nestjs/bullmq` — which does close workers and queues, but from
   * `onApplicationShutdown`.
   *
   * The ordering is the whole point. Nest runs every `onModuleDestroy` before
   * any `onApplicationShutdown`, so doing the drain in this hook and the
   * disconnect below it, in one method, is the only arrangement that
   * guarantees the connection outlives the in-flight job. Split across the
   * two phases it would be a race between two modules' hooks, and losing it
   * means a job that finished its work and could not record that it had — so
   * it runs again on the next replica. `worker.close()` and `queue.close()`
   * are idempotent, so the vendor's later attempt is a no-op rather than a
   * conflict.
   *
   * `close()` without `force` is a **graceful** stop: it stops fetching and
   * waits for the job already in hand. That is what makes a SIGTERM during a
   * rolling deploy safe — CLAUDE.md §12's "no in-process state two replicas
   * would disagree about" is satisfied by the queue itself, but only if the
   * tick in flight is either finished or returned to the queue, never
   * silently dropped.
   */
  async onModuleDestroy(): Promise<void> {
    // Every worker first, then every queue, then the shared connection — not
    // queue-by-queue. Closing one queue while another worker is still
    // finishing a job would leave that job's completion write without a
    // connection on a bad day, which is the failure this hook exists to
    // prevent.
    await this.drain('workers', async () => {
      await this.dispatchProcessor.worker.close();
      await this.maintenanceProcessor.worker.close();
    });
    await this.drain('queues', async () => {
      await this.dispatchQueue.close();
      await this.maintenanceQueue.close();
    });
    // `disconnect()`, not `quit()`, for the reason `redis.module.ts` gives:
    // `quit()` waits for a reply and hangs shutdown when Redis is already
    // unreachable.
    this.connection.disconnect();
  }

  /**
   * A failure here must not stop the rest of the shutdown: the connection
   * below still has to be disconnected, or the process does not exit.
   */
  private async drain(what: string, close: () => Promise<void>): Promise<void> {
    try {
      await close();
    } catch (error) {
      this.logger.warn(
        `Draining the queue ${what} did not complete cleanly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
