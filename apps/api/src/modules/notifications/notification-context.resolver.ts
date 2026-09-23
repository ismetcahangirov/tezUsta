import { Injectable, Logger } from '@nestjs/common';

import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import { OrdersRepository } from '../orders/orders.repository';
import { ServicesService } from '../services/services.service';
import type { NotificationContext } from './notification-copy';
import type { NotifyJobPayload } from './notifications.schema';

/**
 * The locale a push is rendered in — the required one every catalogue read
 * resolves to (ADR-0019). Which languages ship is an open owner decision.
 */
const PUSH_LANGUAGES: readonly string[] = ['az'];

/**
 * What the copy for one notification needs to look up, looked up in the
 * worker immediately before rendering (issue #180).
 *
 * **Only `message-received` needs anything**, and every other kind returns
 * without a read, so the order notifications' send path costs what it did.
 *
 * Looked up here rather than carried in the job, for ADR-0025's reason: the
 * job names, it does not hold. A master who renames themselves between a
 * message and its push is named correctly, and nothing but ids sits in Redis.
 *
 * **Every failure degrades to the generic wording** rather than failing the
 * job. A push that says "new message" is worth sending; a retry loop over a
 * service that was deactivated is not.
 */
@Injectable()
export class NotificationContextResolver {
  private readonly logger = new Logger(NotificationContextResolver.name);

  constructor(
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
    private readonly services: ServicesService,
  ) {}

  async resolve(payload: NotifyJobPayload): Promise<NotificationContext> {
    if (payload.kind !== 'message-received' || payload.orderId === undefined) {
      return {};
    }

    try {
      const order = await this.orders.findById(payload.orderId);
      if (order === undefined) {
        return {};
      }

      /**
       * The master named is the one on the order **now**. A re-dispatch
       * between the message and this job leaves a different master, or none;
       * `masterId === null` falls through to the generic title rather than
       * naming the wrong person — and a message from a master who has since
       * left is rare enough that a generic title is the honest answer.
       */
      const [senderName, service] = await Promise.all([
        payload.senderKind === 'customer'
          ? this.customers.findDisplayName(order.customerId)
          : payload.senderKind === 'master' && order.masterId !== null
            ? this.masters.findDisplayName(order.masterId)
            : Promise.resolve(undefined),
        this.services.getServiceById(order.serviceId, PUSH_LANGUAGES).catch(() => undefined),
      ]);

      return { senderName, serviceName: service?.name };
    } catch (error) {
      this.logger.warn(
        `Could not resolve the names for a message push; sending the generic wording: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {};
    }
  }
}
