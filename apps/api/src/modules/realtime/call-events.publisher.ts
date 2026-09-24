import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { CallEventsRegistry } from '../calls/call-events.registry';
import type { CallDelivery } from '../calls/call-events.registry';
import { RealtimeGateway } from './realtime.gateway';
import { userRoom } from './room.types';

/**
 * What puts a call frame on the socket (issue #185).
 *
 * **It fills a slot rather than being called**, the shape every publisher here
 * has: `CallsService` raises into `CallEventsRegistry` after the call's row has
 * committed, and this is its subscriber.
 *
 * **`user:{userId}`, not `order:{orderId}`.** A call frame has to reach a
 * phone that has not joined the order's room — the callee whose app is open on
 * another screen is exactly who `call:incoming` is for — and it has to reach
 * *every* device the account holds, so the callee's second phone stops ringing
 * when the first one answers. The personal room is joined by the gateway from
 * the authenticated actor at connect, is never nameable from the wire
 * (`room.types.ts`), and holds nobody but that account. The Redis adapter
 * carries the publish to whichever instance holds the socket.
 *
 * **Nothing here reads the database, and no frame carries a credential**:
 * `CallDelivery` is a call as its recipient sees it, and a token has no field
 * to travel in.
 */
@Injectable()
export class CallEventsPublisher implements OnModuleInit {
  private readonly logger = new Logger(CallEventsPublisher.name);

  constructor(
    private readonly registry: CallEventsRegistry,
    private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.registry.register((delivery) => this.deliver(delivery));
  }

  private deliver(delivery: CallDelivery): Promise<void> {
    // See `OrderEventsPublisher#to`: `server` is assigned when socket.io
    // attaches, which a queue worker running the ring timeout may precede.
    const server = this.gateway.server as typeof this.gateway.server | undefined;

    if (server === undefined) {
      this.logger.debug(
        `nothing published for ${delivery.event}: the socket server is not attached yet`,
      );
      return Promise.resolve();
    }

    server.to(userRoom(delivery.userId)).emit(delivery.event, delivery.payload);
    return Promise.resolve();
  }
}
