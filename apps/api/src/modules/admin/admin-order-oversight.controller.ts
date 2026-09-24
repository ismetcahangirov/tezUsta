import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type {
  AdminOrderDetail,
  AdminOrderSummary,
  AdminOrderTranscript,
  AdminPhoneReveal,
  CursorPage,
} from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { AdminActor } from './admin.types';
import {
  adminOrderIdParamsSchema,
  adminOrderPartyParamsSchema,
  listAdminOrdersQuerySchema,
  listDisputesQuerySchema,
  revealPhoneSchema,
} from './admin-orders.schema';
import { AdminOrderOversightService } from './admin-order-oversight.service';
import { RequireAdminPermission } from './admin-permission.decorator';
import { CurrentAdmin } from './current-admin.decorator';

class ListAdminOrdersQueryDto extends createZodDto(listAdminOrdersQuerySchema) {}
class ListDisputesQueryDto extends createZodDto(listDisputesQuerySchema) {}
class AdminOrderIdParamsDto extends createZodDto(adminOrderIdParamsSchema) {}
class AdminOrderPartyParamsDto extends createZodDto(adminOrderPartyParamsSchema) {}
class RevealPhoneDto extends createZodDto(revealPhoneSchema) {}

/**
 * Order oversight and the dispute queue (EPIC 13, issue #245;
 * `admin-flow.md` § 3–4; ADR-0043 § 5–6).
 *
 * Reads only — an admin changes an order through
 * `POST /admin/orders/:orderId/transitions`, the state machine's own door.
 * Every read that shows personal data is audited: an order's detail (its
 * address), a revealed phone number (with a reason), and a transcript.
 */
@Controller('admin/orders')
export class AdminOrderOversightController {
  constructor(private readonly oversight: AdminOrderOversightService) {}

  @RequireAdminPermission('orders.read')
  @Get()
  list(@Query() query: ListAdminOrdersQueryDto): Promise<CursorPage<AdminOrderSummary>> {
    return this.oversight.list(query);
  }

  /** Every `DISPUTED` order, oldest first — the queue a resolver works through. */
  @RequireAdminPermission('orders.read')
  @Get('disputes')
  disputes(@Query() query: ListDisputesQueryDto): Promise<CursorPage<AdminOrderSummary>> {
    return this.oversight.list({ ...query, status: ['DISPUTED'], sort: 'oldest' });
  }

  @RequireAdminPermission('orders.read')
  @Get(':orderId')
  detail(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminOrderIdParamsDto,
  ): Promise<AdminOrderDetail> {
    return this.oversight.detail(admin, params.orderId);
  }

  @RequireAdminPermission('orders.read')
  @Get(':orderId/transcript')
  transcript(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminOrderIdParamsDto,
  ): Promise<AdminOrderTranscript> {
    return this.oversight.transcript(admin, params.orderId);
  }

  /** A full phone number, with a mandatory reason (ADR-0043 § 6). */
  @RequireAdminPermission('pii.read')
  @HttpCode(200)
  @Post(':orderId/parties/:party/phone')
  revealPhone(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminOrderPartyParamsDto,
    @Body() body: RevealPhoneDto,
  ): Promise<AdminPhoneReveal> {
    return this.oversight.revealPhone(admin, params.orderId, params.party, body.reason);
  }
}
