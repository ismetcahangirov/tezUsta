import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type {
  AdminCustomerDetail,
  AdminCustomerSummary,
  AdminCustomerSuspension,
  AdminOrderSummary,
  AdminPhoneReveal,
  CursorPage,
} from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { AdminActor } from './admin.types';
import {
  customerIdParamsSchema,
  customerReasonSchema,
  listCustomerOrdersQuerySchema,
  listCustomersQuerySchema,
} from './admin-customers.schema';
import { AdminCustomersService } from './admin-customers.service';
import { RequireAdminPermission } from './admin-permission.decorator';
import { CurrentAdmin } from './current-admin.decorator';

class ListCustomersQueryDto extends createZodDto(listCustomersQuerySchema) {}
class ListCustomerOrdersQueryDto extends createZodDto(listCustomerOrdersQuerySchema) {}
class CustomerIdParamsDto extends createZodDto(customerIdParamsSchema) {}
class CustomerReasonDto extends createZodDto(customerReasonSchema) {}

/**
 * Customer accounts (#328,
 * [ADR-0050](docs/decisions/ADR-0050-admin-customer-accounts.md)): find a
 * customer, read their file and order history, reveal their number with a
 * reason, and suspend or reinstate the account with one.
 *
 * Authenticated by its `/admin` path like every admin route, and each handler
 * names its permission — `customers.read`, `pii.read` for the number, and
 * `customers.suspend` for the two status changes.
 */
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(private readonly customers: AdminCustomersService) {}

  @RequireAdminPermission('customers.read')
  @Get()
  list(
    @CurrentAdmin() admin: AdminActor,
    @Query() query: ListCustomersQueryDto,
  ): Promise<CursorPage<AdminCustomerSummary>> {
    return this.customers.list(admin, query);
  }

  @RequireAdminPermission('customers.read')
  @Get(':id')
  detail(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: CustomerIdParamsDto,
  ): Promise<AdminCustomerDetail> {
    return this.customers.detail(admin, params.id);
  }

  @RequireAdminPermission('customers.read')
  @Get(':id/orders')
  orders(
    @Param() params: CustomerIdParamsDto,
    @Query() query: ListCustomerOrdersQueryDto,
  ): Promise<CursorPage<AdminOrderSummary>> {
    return this.customers.orderHistory(params.id, query);
  }

  /** The full number, with a mandatory reason (ADR-0043 § 6). */
  @RequireAdminPermission('pii.read')
  @HttpCode(200)
  @Post(':id/phone')
  revealPhone(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: CustomerIdParamsDto,
    @Body() body: CustomerReasonDto,
  ): Promise<AdminPhoneReveal> {
    return this.customers.revealPhone(admin, params.id, body.reason);
  }

  @RequireAdminPermission('customers.suspend')
  @HttpCode(200)
  @Post(':id/suspend')
  suspend(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: CustomerIdParamsDto,
    @Body() body: CustomerReasonDto,
  ): Promise<AdminCustomerSuspension> {
    return this.customers.suspend(admin, params.id, body.reason);
  }

  @RequireAdminPermission('customers.suspend')
  @HttpCode(200)
  @Post(':id/reinstate')
  reinstate(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: CustomerIdParamsDto,
    @Body() body: CustomerReasonDto,
  ): Promise<AdminCustomerSummary> {
    return this.customers.reinstate(admin, params.id, body.reason);
  }
}
