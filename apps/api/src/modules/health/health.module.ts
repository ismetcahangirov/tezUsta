import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { ReadinessCheckRegistry } from './readiness-check.registry';

/**
 * Exports `ReadinessCheckRegistry` so a later module can register a
 * readiness check (Postgres, Redis — issue #22) without this module's source
 * changing at all: the contributing module imports `HealthModule`, injects
 * the registry, and calls `register()` from its own `onModuleInit`.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService, ReadinessCheckRegistry],
  exports: [ReadinessCheckRegistry],
})
export class HealthModule {}
