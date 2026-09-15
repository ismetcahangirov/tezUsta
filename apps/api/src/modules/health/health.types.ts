/**
 * A single readiness dependency check. Implementations live in the module
 * that owns the dependency (e.g. a future `infra/database` registers a
 * Postgres check) and register themselves with {@link ReadinessCheckRegistry}
 * — this module never imports Postgres, Redis, or any other infra client.
 */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<void>;
}

export interface ReadinessCheckResult {
  readonly status: 'up' | 'down';
}

export interface ReadinessReport {
  readonly status: 'ok' | 'degraded';
  readonly checks: Record<string, ReadinessCheckResult>;
}
