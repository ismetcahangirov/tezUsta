import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';

import { realtimeRedisClientProvider } from '../../infra/redis/realtime-connection.provider';
import { REALTIME_REDIS_CLIENT } from '../../infra/redis/redis.tokens';
import { AuthModule } from '../auth/auth.module';
import { ConnectionRegistry } from './connection.registry';
import { RealtimeGateway } from './realtime.gateway';
import { SocketAuthenticator } from './socket.authenticator';

/**
 * The WebSocket gateway and the pieces that decide who may hold a connection
 * (issue #166).
 *
 * `AuthModule` is imported for `TokenService` and `ActorService` — the socket
 * authenticates through the same pair the HTTP guard uses rather than a copy
 * of it, so a revoked session or a withdrawn role behaves identically on both
 * surfaces.
 *
 * `RealtimeIoAdapter` is *not* a provider here. An `IoAdapter` is installed on
 * the application, not injected into it (`main.ts`), and it reads what it
 * needs out of the container by token.
 */
@Module({
  imports: [AuthModule],
  providers: [
    realtimeRedisClientProvider,
    SocketAuthenticator,
    ConnectionRegistry,
    RealtimeGateway,
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
