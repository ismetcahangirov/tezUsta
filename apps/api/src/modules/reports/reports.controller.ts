import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import type { OwnReport, ReportableParty } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { reportOrderIdParamsSchema, submitReportSchema } from './reports.schema';
import { ReportsService } from './reports.service';

class ReportOrderIdParamsDto extends createZodDto(reportOrderIdParamsSchema) {}
class SubmitReportDto extends createZodDto(submitReportSchema) {}

/**
 * A party reports the other party on one order (#330, ADR-0053). The mobile
 * screens wait for the owner's design (CLAUDE.md §17); the contract is here
 * for them.
 */
@Roles('customer', 'master')
@Controller('orders/:orderId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RateLimit({ policy: 'report-submit', identifier: rateLimitByUser })
  @Post()
  submit(
    @CurrentActor() actor: Actor,
    @Param() params: ReportOrderIdParamsDto,
    @Body() body: SubmitReportDto,
  ): Promise<OwnReport> {
    return this.reports.submit(actor, params.orderId, body);
  }

  /** Who the caller may report on this order, each with its window and their own report. */
  @Get('parties')
  parties(
    @CurrentActor() actor: Actor,
    @Param() params: ReportOrderIdParamsDto,
  ): Promise<ReportableParty[]> {
    return this.reports.parties(actor, params.orderId);
  }

  @Get('mine')
  mine(@CurrentActor() actor: Actor, @Param() params: ReportOrderIdParamsDto): Promise<OwnReport> {
    return this.reports.getOwn(actor, params.orderId);
  }

  @RateLimit({ policy: 'report-submit', identifier: rateLimitByUser })
  @Put('mine')
  edit(
    @CurrentActor() actor: Actor,
    @Param() params: ReportOrderIdParamsDto,
    @Body() body: SubmitReportDto,
  ): Promise<OwnReport> {
    return this.reports.editOwn(actor, params.orderId, body);
  }
}
