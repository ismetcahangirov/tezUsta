import { Injectable } from '@nestjs/common';
import type { Order } from '@tezusta/types';

import { OrdersService } from '../orders/orders.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';
import type { AdminTransitionOrderRequest } from './admin-orders.schema';

/**
 * An admin unsticking an order (issue #137).
 *
 * **This class performs no transition of its own.** It calls
 * `OrdersService.override`, which is the same service — and below it the same
 * transactions and the same transition table — that a customer's cancellation
 * and a master's re-dispatch go through. `backend-architecture.md` § Admin
 * override requires exactly that: "an admin may perform a transition the table
 * permits", and nothing more. A second implementation of "advance an order"
 * would be a second place for the history write to be forgotten and a second
 * table of edges to drift from the first — which is precisely the failure this
 * endpoint exists to make unnecessary, since the alternative today is somebody
 * opening a SQL client.
 *
 * What this layer adds is the **admin** half: the admin's identity goes onto
 * the order's own trail row, through `OrdersService.override`, and the action
 * goes into `admin_audit_log`. The two are not redundant. The trail row
 * answers "what happened to this order and who did it"; the audit log answers
 * "what has this admin been doing", which is the investigation view
 * (`admin-flow.md`, non-negotiable 1) and is indexed for it.
 */
@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly orders: OrdersService,
    private readonly admins: AdminRepository,
  ) {}

  /**
   * Drives one edge on any order, whoever it belongs to.
   *
   * The audit row is written **after** the transition, the ordering
   * `AdminMastersService#act` explains: the only failure mode it leaves is a
   * transition that happened whose audit write then errored, which is loud and
   * recoverable — rather than a record of a transition that never committed.
   *
   * A refused override writes no audit row, and that is deliberate. Unlike a
   * document read, where the attempt itself is the disclosure
   * (`AdminOrderPhotosService`), a refused transition changes nothing and
   * reveals nothing an admin could not already read from the order: it is
   * `assertOrderTransition` saying the edge does not exist, which is a fact
   * about ADR-0015 rather than about this order.
   */
  async transition(
    admin: AdminActor,
    orderId: string,
    input: AdminTransitionOrderRequest,
  ): Promise<Order> {
    const order = await this.orders.override(admin.adminUserId, orderId, input);

    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'order.transition',
      targetType: 'order',
      targetId: orderId,
      reason: input.reason,
    });

    return order;
  }
}
