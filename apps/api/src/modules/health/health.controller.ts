import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { HealthService } from './health.service';
import type { ReadinessReport } from './health.types';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Trivially cheap liveness answer. Must never check a dependency — see
   * `HealthService.getLiveness`.
   */
  @Get('live')
  live(): { status: 'ok' } {
    return this.healthService.getLiveness();
  }

  /**
   * Aggregates the readiness check registry. 200 while every check is up (or
   * none are registered, today's state); 503 the moment any check fails.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessReport> {
    const report = await this.healthService.getReadiness();
    reply.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
