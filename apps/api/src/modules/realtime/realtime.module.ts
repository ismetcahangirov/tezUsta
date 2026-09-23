import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';

import { realtimeRedisClientProvider } from '../../infra/redis/realtime-connection.provider';
import { RedisModule } from '../../infra/redis/redis.module';
import { REALTIME_REDIS_CLIENT } from '../../infra/redis/redis.tokens';
import { AuthModule } from '../auth/auth.module';
import { CustomersModule } from '../customers/customers.module';
import { MastersModule } from '../masters/masters.module';
import { OrdersModule } from '../orders/orders.module';
import { ConnectionRegistry } from './connection.registry';
import { ConversationEventsPublisher } from './conversation-events.publisher';
import { InboundBudget } from './inbound-budget';
import { MasterPositionPublisher } from './master-position.publisher';
import { OrderEventsPublisher } from './order-events.publisher';
import { RoomAuthorizer } from './room-authorizer';
import { RoomsService } from './rooms.service';
import { RealtimeGateway } from './realtime.gateway';
import { SocketAuthenticator } from './socket.authenticator';
import { TypingRelay } from './typing-relay';

/**
 * The WebSocket gateway and the pieces that decide who may hold a connection
 * (issue #166).
 *
 * `AuthModule` is imported for `TokenService` and `ActorService` — the socket
 * authenticates through the same pair the HTTP guard uses rather than a copy
 * of it, so a revoked session or a withdrawn role behaves identically on both
 * surfaces.
 *
 * `OrdersModule`, `CustomersModule` and `MastersModule` arrived with #167:
 * authorizing a room join means re-reading the order and the caller's profiles
 * from the database on every join, through the same services the HTTP surface
 * uses. The arrow points this way only — `modules/orders` raises transitions
 * through `OrderRoomsRegistry`, which it owns, so nothing there imports this
 * module (`order-rooms.registry.ts`).
 *
 * `OrderEventsPublisher` arrived with #168. It subscribes to
 * `OrderNotificationsRegistry` — the same seam the notification module uses —
 * so the arrow keeps pointing one way: nothing in `modules/orders` knows this
 * module exists.
 *
 * `MasterPositionPublisher` arrived with #169, and `RedisModule` with it: the
 * fan-out throttle is one key per order in the shared Redis, because two API
 * instances holding their own timers would each publish once per window
 * (CLAUDE.md §12). It fills `MasterLocationRegistry`'s slot, so the arrow
 * still points one way — `modules/masters` never learns a socket exists.
 *
 * `ConversationEventsPublisher` and `TypingRelay` arrived with #179. The
 * first fills `ConversationEventsRegistry`'s slot, so messages reach the socket
 * the way order events do and `modules/orders` still imports nothing from
 * here; the second debounces the one inbound frame that is not a room request.
 *
 * `RealtimeIoAdapter` is *not* a provider here. An `IoAdapter` is installed on
 * the application, not injected into it (`main.ts`), and it reads what it
 * needs out of the container by token.
 */
@Module({
  imports: [AuthModule, OrdersModule, CustomersModule, MastersModule, RedisModule],
  providers: [
    realtimeRedisClientProvider,
    SocketAuthenticator,
    ConnectionRegistry,
    InboundBudget,
    RoomAuthorizer,
    RoomsService,
    RealtimeGateway,
    OrderEventsPublisher,
    MasterPositionPublisher,
    ConversationEventsPublisher,
    TypingRelay,
  ],
  exports: [RealtimeGateway],
})
export class RealtimeModule implements OnApplicationShutdown {
  constructor(@Inject(REALTIME_REDIS_CLIENT) private readonly client: Redis) {}

  /**
   * **`onApplicationShutdown`, not `onModuleDestroy`, and the difference is
   * an ordering bug rather than a preference.** Nest runs
   * `callDestroyHook()` → `callBeforeShutdownHook()` → `dispose()` →
   * `callShutdownHook()`, and `dispose()` is what closes the socket.io
   * server — which is the only thing that fires the streams adapter's
   * `controller.abort()` and stops it using this client. Disconnecting from
   * `onModuleDestroy` therefore kills the publisher while the server is still
   * live: harmless today because nothing publishes, and an unhandled `XADD`
   * rejection the moment #168 does.
   *
   * `disconnect()`, not `quit()`, for the reason `redis.module.ts` gives:
   * `quit()` waits for a reply and hangs shutdown when Redis is already
   * unreachable.
   *
   * The adapter's own duplicates are not closed here — it aborts them itself
   * when its last namespace closes (`dist/adapter.js#createAdapter`). Note
   * that the reader duplicate only notices on the next loop iteration, after
   * its in-flight `XREAD … BLOCK 5000` returns, so up to five seconds of
   * socket can outlive `close()`. It is unref'd work, not a leak, but it is
   * why "it aborts them itself" is less immediate than it sounds.
   */
  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}
