import { Inject } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { DeferredJobHandlerRegistry } from './deferred-job-handler.registry';
import { DeferredQueueProcessor } from './deferred-queue.processor';
import { NOTIFICATIONS_QUEUE } from './queue.constants';

/**
 * The consumer half of the notifications queue (#141).
 *
 * Its own worker, so a push provider having a slow minute cannot occupy a
 * slot a dispatch wave needs; see {@link NOTIFICATIONS_QUEUE}. Everything it
 * does is {@link DeferredQueueProcessor}'s — this class exists to name the
 * queue and to carry the decorator the `@nestjs/bullmq` explorer reads.
 */
@Processor(NOTIFICATIONS_QUEUE, { autorun: false })
export class NotificationsProcessor extends DeferredQueueProcessor {
  constructor(handlers: DeferredJobHandlerRegistry, @Inject(APP_CONFIG) config: AppConfig) {
    super(NOTIFICATIONS_QUEUE, handlers, config);
  }
}
