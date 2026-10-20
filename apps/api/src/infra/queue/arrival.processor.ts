import { Inject } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { DeferredJobHandlerRegistry } from './deferred-job-handler.registry';
import { DeferredQueueProcessor } from './deferred-queue.processor';
import { ARRIVAL_QUEUE } from './queue.constants';

/**
 * The `arrival` queue's worker (#396). Same lifecycle and the same
 * `QUEUE_WORKER_MODE` / `QUEUE_WORKER_CONCURRENCY` as the other I/O queues;
 * its own budget is the point of having it.
 */
@Processor(ARRIVAL_QUEUE, { autorun: false })
export class ArrivalProcessor extends DeferredQueueProcessor {
  constructor(handlers: DeferredJobHandlerRegistry, @Inject(APP_CONFIG) config: AppConfig) {
    super(ARRIVAL_QUEUE, handlers, config);
  }
}
