import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import type { Order } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { AdminOrdersService } from './admin-orders.service';
import { adminOrderIdParamsSchema, adminTransitionOrderSchema } from './admin-orders.schema';
import type { AdminActor } from './admin.types';
import { CurrentAdmin } from './current-admin.decorator';

class AdminOrderIdParamsDto extends createZodDto(adminOrderIdParamsSchema) {}
class AdminTransitionOrderDto extends createZodDto(adminTransitionOrderSchema) {}

/**
 * Admin override of an order's status (issue #137) — a **separate,
 * separately-guarded surface** (`docs/product/admin-flow.md`,
 * non-negotiable 6), the same rule `AdminMastersController` follows.
 *
 * **The route lives here rather than on `OrdersController`, and that is the
 * decision this file exists to record.** Admin authentication is a separate
 * path with its own guard, its own token family and its own issuer and
 * audience ([ADR-0014](docs/decisions/ADR-0014-admin-authentication.md));
 * mixing it into a customer- and master-facing controller would put two
 * authentication schemes on one route, which is how one of them eventually
 * gets skipped. There is no `@Roles()` here and no `@Public()`: every route
 * under `/admin` is authenticated because of its **path**, not because of a
 * decorator somebody remembered, and `admin-verification.e2e.test.ts` walks
 * the live route table to prove it.
 *
 * Separate from `AdminOrderPhotosController` despite sharing the prefix,
 * because they are separate capabilities with separate audiences: one reads a
 * photograph of somebody's home, the other moves an order. Nest is happy with
 * two controllers on one prefix, and the alternative — one class that both
 * presigns downloads and drives a state machine — is a class with no subject.
 *
 * No `@RateLimit`, matching every other admin route. The budget those exist
 * for is a mobile client stuck in a retry loop against a public surface; this
 * one is reachable only by a named human holding a fifteen-minute session
 * whose every action is in `admin_audit_log`.
 */
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  /**
   * Drives one edge of the transition table on any order.
   *
   * `@HttpCode(200)` because Nest answers a `@Post()` with 201 by default, and
   * nothing here is created: the order already existed and still does.
   *
   * The same route shape the consumer surface uses — one route taking a
   * target, rather than a verb per edge — for the same reason, and with more
   * force: an admin may drive *every* edge the table contains, so a verb per
   * edge would be a dozen routes and a dozen chances to forget the check.
   */
  @HttpCode(200)
  @Post(':orderId/transitions')
  async transition(
    @CurrentAdmin() admin: AdminActor,
    @Param() params: AdminOrderIdParamsDto,
    @Body() body: AdminTransitionOrderDto,
  ): Promise<Order> {
    return this.orders.transition(admin, params.orderId, body);
  }
}
