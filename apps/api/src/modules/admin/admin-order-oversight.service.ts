import { Injectable } from '@nestjs/common';
import type {
  AdminOrderDetail,
  AdminOrderSummary,
  AdminOrderTranscript,
  AdminPhoneReveal,
  CursorPage,
} from '@tezusta/types';

import type { AdminOrderListQuery } from '../orders/orders-admin-read.service';
import { OrdersAdminReadService } from '../orders/orders-admin-read.service';
import { AdminRepository } from './admin.repository';
import type { AdminActor } from './admin.types';

/**
 * The admin side of order oversight (issue #245): the orders module answers,
 * this class writes the audit row for every read that shows personal data.
 *
 * The audit row is written **after** the read succeeds and before the answer
 * leaves: a read that failed disclosed nothing, and one that succeeded is on
 * the record before anyone sees it.
 */
@Injectable()
export class AdminOrderOversightService {
  constructor(
    private readonly orders: OrdersAdminReadService,
    private readonly admins: AdminRepository,
  ) {}

  list(query: AdminOrderListQuery): Promise<CursorPage<AdminOrderSummary>> {
    // A list shows names and statuses, not addresses or numbers; it is not
    // audited, or every page turn would be a row.
    return this.orders.list(query);
  }

  async detail(admin: AdminActor, orderId: string): Promise<AdminOrderDetail> {
    const detail = await this.orders.detail(orderId);
    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'order.read',
      targetType: 'order',
      targetId: orderId,
    });
    return detail;
  }

  async transcript(admin: AdminActor, orderId: string): Promise<AdminOrderTranscript> {
    const transcript = await this.orders.transcript(orderId);
    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: 'order.transcript.read',
      targetType: 'order',
      targetId: orderId,
    });
    return transcript;
  }

  async revealPhone(
    admin: AdminActor,
    orderId: string,
    party: 'customer' | 'master',
    reason: string,
  ): Promise<AdminPhoneReveal> {
    const phoneE164 = await this.orders.partyPhone(orderId, party);
    await this.admins.appendAudit({
      adminUserId: admin.adminUserId,
      action: `order.${party}.phone.read`,
      targetType: 'order',
      targetId: orderId,
      reason,
    });
    return { phoneE164 };
  }
}
