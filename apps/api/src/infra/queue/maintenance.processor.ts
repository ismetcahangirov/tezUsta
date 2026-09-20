import { Inject } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { DeferredJobHandlerRegistry } from './deferred-job-handler.registry';
import { DeferredQueueProcessor } from './deferred-queue.processor';
import { MAINTENANCE_QUEUE } from './queue.constants';

/**
 * The consumer half of the maintenance queue — the retention sweeps (#57,
 * #69, #92), and whatever else later comes due because time passed.
 *
 * Its own worker, so a sweep that takes a minute cannot occupy a slot a
 * dispatch wave needs; see {@link MAINTENANCE_QUEUE}. It shares the handler
 * registry with `DispatchProcessor`, which is safe because the registry
 * refuses a duplicate name outright rather than merging.
 */
@Processor(MAINTENANCE_QUEUE, { autorun: false })
export class MaintenanceProcessor extends DeferredQueueProcessor {
  constructor(handlers: DeferredJobHandlerRegistry, @Inject(APP_CONFIG) config: AppConfig) {
    super(MAINTENANCE_QUEUE, handlers, config);
  }
}
