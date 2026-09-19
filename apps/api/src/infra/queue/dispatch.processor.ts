import { Inject, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { DeferredJobHandlerRegistry } from './deferred-job-handler.registry';
import { DISPATCH_QUEUE } from './queue.constants';
import type { DeferredJobPayload } from './queue.types';

/**
 * The consumer half: it runs whatever the registry says `job.name` means.
 *
 * `autorun: false` is the flag half of the worker extraction. The `Worker`
 * object is built by `@nestjs/bullmq`'s explorer at `onModuleInit` either
 * way — so `queue.module.ts` always has something to drain — but it fetches
 * nothing until {@link onApplicationBootstrap} calls `run()`, and it only
 * does that when `QUEUE_WORKER_MODE=in-process`. Set `off` and this replica
 * produces jobs and consumes none, which is precisely what an API replica
 * does once a separate worker deployment exists.
 *
 * Concurrency comes from config for the reason `DATABASE_POOL_MAX` exists: a
 * worker running twenty dispatch ticks at once wants twenty Postgres
 * connections at once, and the pool it shares with the HTTP server is not
 * sized for that.
 */
@Processor(DISPATCH_QUEUE, { autorun: false })
export class DispatchProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(DispatchProcessor.name);

  constructor(
    private readonly handlers: DeferredJobHandlerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    if (this.config.queue.workerMode === 'off') {
      this.logger.log(
        `QUEUE_WORKER_MODE=off — this replica produces "${DISPATCH_QUEUE}" jobs and consumes none`,
      );
      return;
    }

    this.worker.concurrency = this.config.queue.workerConcurrency;
    // Not awaited: `run()` resolves only when the worker stops, so awaiting it
    // would hang bootstrap forever. A rejection is still handled — without the
    // catch it would be an unhandled rejection, which CLAUDE.md §12's
    // non-blocking rule does not excuse.
    void this.worker.run().catch((error: unknown) => {
      this.logger.error(
        `The "${DISPATCH_QUEUE}" worker stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.logger.log(
      `Consuming "${DISPATCH_QUEUE}" with concurrency ${String(this.config.queue.workerConcurrency)}`,
    );
  }

  /**
   * Throwing is the contract with BullMQ — it is how a job asks to be
   * retried — so nothing is swallowed here. The log line exists because a
   * job failure is otherwise silent until someone reads the failed set, and
   * it deliberately carries the job's NAME and ID only: a payload can carry
   * an order id, and `docs/engineering/security.md` keeps identifiers out of
   * logs that nothing needs them in.
   */
  async process(job: Job<DeferredJobPayload>): Promise<void> {
    const handler = this.handlers.resolve(job.name);

    try {
      await handler(job.data);
    } catch (error) {
      this.logger.warn(
        `Deferred job "${job.name}" (${job.id ?? 'no id'}) failed on attempt ${String(
          job.attemptsMade + 1,
        )}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
