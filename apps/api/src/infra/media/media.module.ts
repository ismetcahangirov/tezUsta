import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { ImageRenditions } from './image-renditions';
import { MediaJobTargetRegistry } from './media-job-target';
import { MediaPipelineService } from './media-pipeline.service';
import { MEDIA_PROCESSOR } from './media-processor.types';

/**
 * The media pipeline (ADR-0045 § 5, #305): the `media` queue's job, the
 * `sharp` renderer behind its port, and the registry the owners of each kind
 * of upload register into.
 *
 * A feature module imports this, registers its {@link MediaJobTarget} under a
 * purpose, and calls `MediaPipelineService.enqueue(purpose, itemId)` from its
 * confirm step. Nothing else about the queue or `sharp` reaches it.
 */
@Module({
  imports: [StorageModule, QueueModule],
  providers: [
    MediaJobTargetRegistry,
    MediaPipelineService,
    {
      provide: MEDIA_PROCESSOR,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new ImageRenditions({ maxInputPixels: config.media.maxInputPixels }),
    },
  ],
  exports: [MediaJobTargetRegistry, MediaPipelineService],
})
export class MediaModule {}
