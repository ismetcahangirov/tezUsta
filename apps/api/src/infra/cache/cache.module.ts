import { Module } from '@nestjs/common';

import { RedisModule } from '../redis/redis.module';
import { CacheService } from './cache.service';

/**
 * Redis-backed read-through caching, available to any module that needs it —
 * the service catalogue (issue #32) is the first consumer, and any future
 * public, rarely-changing read (categories, pricing bands, static content)
 * is the intended shape of the next one.
 *
 * Lives under `infra/` for the same reason `RateLimitModule` does: this is a
 * mechanism, not a feature of any one domain, and no domain module should
 * have to import another domain's module to reuse it. `CacheModule` depends
 * only on `RedisModule` — never on `AppModule` or on the module that happens
 * to consume it first — so the dependency graph stays a one-way fan-out from
 * `infra/` into `modules/`, not a cycle back the other way.
 *
 * `CacheService` is exported, not the underlying `REDIS_CLIENT` token: a
 * consumer that needs raw Redis access for something this service does not
 * cover should import `RedisModule` itself, rather than reaching through this
 * module for a client this module does not actually own.
 */
@Module({
  imports: [RedisModule],
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
