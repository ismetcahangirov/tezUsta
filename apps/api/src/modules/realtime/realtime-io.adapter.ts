import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import type Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { REALTIME_REDIS_CLIENT } from '../../infra/redis/redis.tokens';

/**
 * The WebSocket adapter that makes two API instances one realtime system
 * (issue #166, [ADR-0032](../../../../../docs/decisions/ADR-0032-realtime-transport.md)).
 *
 * **Without it a client connected to instance A never receives an event
 * published on instance B**, and the bug does not announce itself — it
 * arrives months later as "sometimes the app doesn't update", which
 * `realtime-architecture.md` § Transport names as the worst class of bug to
 * diagnose. That is why it is wired from the first commit rather than when a
 * second instance appears, and why `realtime.multi-instance.e2e.test.ts`
 * boots two real applications to prove it.
 *
 * Installed from `main.ts` with `app.useWebSocketAdapter(new RealtimeIoAdapter(app))`,
 * which must happen before `listen()`: Nest attaches the socket.io server to
 * the HTTP server as it starts listening.
 */
export class RealtimeIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RealtimeIoAdapter.name);

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  /**
   * `createIOServer` is the seam Nest documents for this. Everything about the
   * server itself — port, path, the gateway's own options — is left to
   * `super`; this override adds the cluster adapter and nothing else.
   */
  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options);

    const client = this.app.get<Redis>(REALTIME_REDIS_CLIENT);
    const config = this.app.get<AppConfig>(APP_CONFIG);
    const prefix = config.redis.keyPrefix;

    // Every key this adapter builds carries REDIS_KEY_PREFIX, for the reason
    // issue #125 gives: Redis is shared — two checkouts, or a CI job and a
    // developer's `pnpm test`, point at one container — and an unnamespaced
    // stream would let one run read and trim another's. The adapter's own
    // defaults (`socket.io`, `sio:session:`) are exactly such constants.
    server.adapter(
      createAdapter(client, {
        streamName: `${prefix}:socket.io`,
        channelPrefix: `${prefix}:socket.io`,
        sessionKeyPrefix: `${prefix}:sio:session:`,
      }),
    );

    this.logger.log('realtime adapter attached: socket.io over Redis streams');
    return server;
  }
}
