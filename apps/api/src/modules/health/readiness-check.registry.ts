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
 * Today nothing registers, so `list()` is empty and `/health/ready` reports
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
