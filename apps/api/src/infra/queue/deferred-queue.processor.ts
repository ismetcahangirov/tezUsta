import { Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

import type { AppConfig } from '../config/app-config.types';
import { describeDatabaseFailure } from '../database/database-error';
import type { DeferredJobHandlerRegistry } from './deferred-job-handler.registry';
import { PermanentJobError } from './queue.types';
import type { DeferredJobPayload } from './queue.types';

/**
 * Who consumes a queue and how many jobs at once. Every queue but `media`
 * takes both from `QUEUE_WORKER_*`; `media` has its own pair (#305), because
 * image work is CPU-bound and is the first thing to move off the API.
 */
export interface WorkerSettings {
  readonly mode: 'in-process' | 'off';
  readonly concurrency: number;
  /** Named in the log line, so an operator knows which variable to change. */
  readonly modeVariable: string;
}

/**
 * Everything a queue's consumer does that has nothing to do with which queue
 * it is: honour its worker mode (`QUEUE_WORKER_MODE`, or `MEDIA_WORKER_MODE`
 * for the `media` queue), apply the configured concurrency, run
 * whatever the registry says `job.name` means, and log a failure on its way
 * past rather than swallowing it.
 *
 * Extracted when the second queue arrived (#57, #69, #92) rather than
 * copied: a duplicated `onApplicationBootstrap` is how one queue quietly
 * keeps consuming after `QUEUE_WORKER_MODE=off` is set, and the flag is only
 * worth anything if it is impossible to half-implement.
 *
 * A subclass supplies the queue name and carries the `@Processor` decorator —
 * the decorator is what `@nestjs/bullmq`'s explorer reads to build
 * `this.worker`, and metadata on an abstract base would not tell it which
 * queue a given concrete processor serves.
 */
export abstract class DeferredQueueProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly deferredLogger: Logger;

  private readonly settings: WorkerSettings;

  protected constructor(
    private readonly queueName: string,
    private readonly handlers: DeferredJobHandlerRegistry,
    appConfig: AppConfig,
    settings?: WorkerSettings,
  ) {
    super();
    this.deferredLogger = new Logger(`${queueName}-worker`);
    this.settings = settings ?? {
      mode: appConfig.queue.workerMode,
      concurrency: appConfig.queue.workerConcurrency,
      modeVariable: 'QUEUE_WORKER_MODE',
    };
  }

  /**
   * `autorun: false` on every subclass is the flag half of the worker
   * extraction. The `Worker` object is built by the explorer at
   * `onModuleInit` either way — so `queue.module.ts` always has something to
   * drain — but it fetches nothing until this hook calls `run()`, and it only
   * does that when `QUEUE_WORKER_MODE=in-process`. Set `off` and this replica
   * produces jobs and consumes none, which is precisely what an API replica
   * does once a separate worker deployment exists.
   *
   * Concurrency comes from config for the reason `DATABASE_POOL_MAX` exists:
   * a worker running twenty jobs at once wants twenty Postgres connections at
   * once, and the pool it shares with the HTTP server is not sized for that.
   */
  onApplicationBootstrap(): void {
    if (this.settings.mode === 'off') {
      this.deferredLogger.log(
        `${this.settings.modeVariable}=off — this replica produces "${this.queueName}" jobs and consumes none`,
      );
      return;
    }

    this.worker.concurrency = this.settings.concurrency;
    // Not awaited: `run()` resolves only when the worker stops, so awaiting it
    // would hang bootstrap forever. A rejection is still handled — without the
    // catch it would be an unhandled rejection, which CLAUDE.md §12's
    // non-blocking rule does not excuse.
    void this.worker.run().catch((error: unknown) => {
      this.deferredLogger.error(
        `The "${this.queueName}" worker stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.deferredLogger.log(
      `Consuming "${this.queueName}" with concurrency ${String(this.settings.concurrency)}`,
    );
  }

  /**
   * Throwing is the contract with BullMQ — it is how a job asks to be
   * retried — so nothing is swallowed here. The log lines exist because a
   * job failure is otherwise silent until someone reads the failed set, and
   * they deliberately carry the job's NAME and ID only: a payload can carry
   * an order id, and `docs/engineering/security.md` keeps identifiers out of
   * logs that nothing needs them in.
   *
   * **Two levels** (#426). An attempt that will be retried is a `warn`. The
   * last one — every attempt spent, or a {@link PermanentJobError} that is
   * not retried at all — is one `error`: the job now sits in the failed set
   * and nothing will run it again, so a push never sent or a deadline never
   * kept is something a person needs to hear about. `error` is the channel
   * the reconcilers already alert on.
   *
   * **A failed query's message is never written** (#424 finding 5): it
   * carries the query's bound parameters, which for some jobs are a point.
   * `describeDatabaseFailure` keeps the statement and drops them.
   */
  async process(job: Job<DeferredJobPayload>): Promise<void> {
    const handler = this.handlers.resolve(job.name);
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    try {
      await handler(job.data, { attempt, maxAttempts });
    } catch (error) {
      const reason =
        describeDatabaseFailure(error) ?? (error instanceof Error ? error.message : String(error));
      const permanent = error instanceof PermanentJobError;
      this.deferredLogger.warn(
        `Deferred job "${job.name}" (${job.id ?? 'no id'}) failed on attempt ${String(attempt)}: ${reason}`,
      );
      if (permanent || attempt >= maxAttempts) {
        this.deferredLogger.error(
          `Deferred job "${job.name}" (${job.id ?? 'no id'}) on "${this.queueName}" failed for good ` +
            `after ${String(attempt)}/${String(maxAttempts)} attempts${permanent ? ' (permanent)' : ''}; ` +
            `it is in the failed set and will not run again: ${
              error instanceof Error ? error.name : 'unknown error'
            }`,
        );
      }
      if (error instanceof PermanentJobError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }
}
