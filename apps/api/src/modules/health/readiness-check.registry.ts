import { Injectable } from '@nestjs/common';

import type { ReadinessCheck } from './health.types';

/**
 * Registry of readiness checks aggregated by `GET /health/ready`.
 *
 * A feature module registers a check by injecting this registry (exported by
 * `HealthModule`) and calling `register` from its own `onModuleInit` — no
 * edit to `HealthModule` or `HealthService` is needed. Issue #22 registers
 * Postgres and Redis checks exactly this way.
 *
 * `DatabaseModule` and `RedisModule` each register one this way, so
 * `/health/ready` reports a `postgres` and a `redis` entry. A module that
 * registers nothing costs nothing: an empty registry reports
 * `{ status: 'ok', checks: {} }`.
 */
@Injectable()
export class ReadinessCheckRegistry {
  private readonly checks: ReadinessCheck[] = [];

  register(check: ReadinessCheck): void {
    this.checks.push(check);
  }

  list(): readonly ReadinessCheck[] {
    return this.checks;
  }
}
