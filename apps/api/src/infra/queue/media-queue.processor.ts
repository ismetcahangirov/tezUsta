import { Inject } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { DeferredJobHandlerRegistry } from './deferred-job-handler.registry';
import { DeferredQueueProcessor } from './deferred-queue.processor';
import { MEDIA_QUEUE } from './queue.constants';

/**
 * The consumer half of the media queue (#305). Everything it does is
 * {@link DeferredQueueProcessor}'s; what differs is where its mode and
 * concurrency come from — `MEDIA_WORKER_*`, not `QUEUE_WORKER_*`. See
 * {@link MEDIA_QUEUE}.
 */
@Processor(MEDIA_QUEUE, { autorun: false })
export class MediaQueueProcessor extends DeferredQueueProcessor {
  constructor(handlers: DeferredJobHandlerRegistry, @Inject(APP_CONFIG) config: AppConfig) {
    super(MEDIA_QUEUE, handlers, config, {
      mode: config.media.workerMode,
      concurrency: config.media.workerConcurrency,
      modeVariable: 'MEDIA_WORKER_MODE',
    });
  }
}
