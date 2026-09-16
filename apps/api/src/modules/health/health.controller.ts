import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';
import type { ReadinessReport } from './health.types';

/**
 * Both routes are `@Public()`, and they are the only two in the application
 * that are.
 *
 * They have to be. The probes are called by a load balancer, a container
 * orchestrator and an uptime monitor — none of which holds a user account, and
 * requiring one would mean an unauthenticated probe read 401 as "unhealthy" and
 * took the service out of rotation the moment the guards started working.
 *
 * The decorator is on each method rather than on the class so a third route
 * added here later — a deeper diagnostic, say — has to opt itself out
 * deliberately instead of inheriting an exemption nobody chose for it. What
 * these two return is already scrubbed of infrastructure detail by
 * `HealthService`, which is the other half of why they are safe to expose.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Trivially cheap liveness answer. Must never check a dependency — see
   * `HealthService.getLiveness`.
   */
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return this.healthService.getLiveness();
  }

  /**
   * Aggregates the readiness check registry. 200 while every check is up (or
   * none are registered, today's state); 503 the moment any check fails.
   */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessReport> {
    const report = await this.healthService.getReadiness();
    reply.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
