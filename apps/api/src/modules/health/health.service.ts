import { Injectable, Logger } from '@nestjs/common';

import type { ReadinessCheck, ReadinessReport } from './health.types';
import { ReadinessCheckRegistry } from './readiness-check.registry';

/**
 * A readiness check that never settles is worse than one that fails: the probe
 * hangs, the load balancer keeps the instance in rotation, and it serves
 * errors. A TCP connect to a black-holed host does exactly that. Bound every
 * check so `/health/ready` always answers.
 */
const CHECK_TIMEOUT_MS = 2000;

async function runWithTimeout(check: ReadinessCheck): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${String(CHECK_TIMEOUT_MS)}ms`));
        }, CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly registry: ReadinessCheckRegistry) {}

  /**
   * Liveness deliberately checks nothing: a probe that fails on a dependency
   * blip restarts an otherwise-healthy process.
   */
  getLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Runs every registered readiness check in parallel. A failing check is
   * reported as `{ status: 'down' }` only — the driver/infra error text is
   * logged server-side, never returned to the client.
   */
  async getReadiness(): Promise<ReadinessReport> {
    const checks = this.registry.list();

    const entries = await Promise.all(
      checks.map(async (check): Promise<readonly [string, { status: 'up' | 'down' }]> => {
        try {
          await runWithTimeout(check);
          return [check.name, { status: 'up' }] as const;
        } catch (error) {
          this.logger.warn(
            `Readiness check "${check.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [check.name, { status: 'down' }] as const;
        }
      }),
    );

    const checkMap = Object.fromEntries(entries);
    const allUp = entries.every(([, result]) => result.status === 'up');

    return { status: allUp ? 'ok' : 'degraded', checks: checkMap };
  }
}
