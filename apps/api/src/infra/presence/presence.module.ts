import { Module } from '@nestjs/common';

import { RedisModule } from '../redis/redis.module';
import { MasterPresenceService } from './master-presence.service';

/**
 * Master liveness, held in Redis with a TTL (issue #40).
 *
 * `infra/` rather than inside `modules/masters/` because presence is not the
 * master profile's state: it is a fact about a connection that EPIC 7's
 * dispatch will read far more often than any master-facing endpoint does, and
 * it is stored somewhere the domain tables are not.
 */
@Module({
  imports: [RedisModule],
  providers: [MasterPresenceService],
  exports: [MasterPresenceService],
})
export class PresenceModule {}
