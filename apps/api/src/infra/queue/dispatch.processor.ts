import { Inject } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { DeferredJobHandlerRegistry } from './deferred-job-handler.registry';
import { DeferredQueueProcessor } from './deferred-queue.processor';
import { DISPATCH_QUEUE } from './queue.constants';

/**
 * The consumer half of the dispatch queue: it runs whatever the registry says
 * `job.name` means. Everything it does is {@link DeferredQueueProcessor}'s —
 * this class exists to name the queue and to carry the decorator the
 * `@nestjs/bullmq` explorer reads.
 */
@Processor(DISPATCH_QUEUE, { autorun: false })
export class DispatchProcessor extends DeferredQueueProcessor {
  constructor(handlers: DeferredJobHandlerRegistry, @Inject(APP_CONFIG) config: AppConfig) {
    super(DISPATCH_QUEUE, handlers, config);
  }
}
