import { Module } from '@nestjs/common';

import { CdnModule } from '../../infra/cdn/cdn.module';
import { DatabaseModule } from '../../infra/database/database.module';
import { MediaModule } from '../../infra/media/media.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { MastersModule } from '../masters/masters.module';
import { PortfolioMediaTarget } from './portfolio-media.target';
import { PortfolioController } from './portfolio.controller';
import { PortfolioRepository } from './portfolio.repository';
import { PortfolioService } from './portfolio.service';

/**
 * The master's own portfolio (EPIC 19, #308, ADR-0045).
 *
 * `MediaModule` runs the photos through the `media` queue, and this module
 * registers {@link PortfolioMediaTarget} with it, so the queue reports back to
 * the portfolio's own tables without `infra/media` importing anything here.
 * `CdnModule` is for a draft photo's renditions, purged when it is removed.
 *
 * The public profile and feed are #310's, the deletion sweeps #311's, and
 * moderation #312's; each will take what it needs from this module's service
 * or add its own, rather than this module growing their endpoints.
 */
@Module({
  imports: [DatabaseModule, StorageModule, CdnModule, MediaModule, MastersModule],
  controllers: [PortfolioController],
  providers: [PortfolioRepository, PortfolioService, PortfolioMediaTarget],
  exports: [PortfolioService],
})
export class PortfolioModule {}
