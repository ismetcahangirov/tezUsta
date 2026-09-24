import { Controller, Get, Param, Query } from '@nestjs/common';
import type { CallRecord, CursorPage } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { CallRecordsService } from './call-records.service';
import { callHistoryParamsSchema, listCallHistoryQuerySchema } from './calls.schema';

class CallHistoryParamsDto extends createZodDto(callHistoryParamsSchema) {}
class ListCallHistoryQueryDto extends createZodDto(listCallHistoryQuerySchema) {}

/**
 * `GET /orders/:orderId/calls` — a party's own calls on one order, newest
 * first (issue #186).
 *
 * Under `orders/:orderId` beside the conversation, because a call is a
 * property of the order the way the conversation is (ADR-0034 § 6), and the
 * order is the only identifier a client needs. `@Roles` is the cheap first
 * gate; who is a party to the order is re-read per request
 * (`CallRecordsService.forParty`), with 404 for everybody else.
 *
 * Not rate-limited, for the reason the conversation's reads are not: bounded
 * by the page ceiling, and answering only what the caller was party to.
 */
@Roles('customer', 'master')
@Controller('orders/:orderId/calls')
export class CallHistoryController {
  constructor(private readonly records: CallRecordsService) {}

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Param() params: CallHistoryParamsDto,
    @Query() query: ListCallHistoryQueryDto,
  ): Promise<CursorPage<CallRecord>> {
    return this.records.forParty(actor, params.orderId, query);
  }
}
