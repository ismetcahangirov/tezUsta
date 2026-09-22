import { Inject, Injectable } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { AuthenticatedSocket } from './realtime.types';

/**
 * How many inbound messages one connection may send, and how fast
 * (issue #167, `realtime-architecture.md` § Security: "Rate-limit inbound
 * messages per connection").
 *
 * **This is not `infra/rate-limit`, and the divergence is deliberate.** The
 * issue asked for that limiter to be reused; `rate-limit.config.ts` had
 * already written down why it does not fit, in a comment that predates this
 * work: "WebSocket message flooding is a limit too, and it is NOT here: it is
 * a per-connection budget measured in messages per second against a live
 * socket, not a per-identifier budget on an HTTP request." Both cannot be
 * satisfied, so this follows the one that reasons about the mechanism.
 *
 * The mechanical difference is that `RateLimiterService` is Redis-backed,
 * because an HTTP limit has to hold across instances — a client that can move
 * between them would otherwise get one budget per instance. An inbound socket
 * frame cannot move: it arrives on the one connection, held by the one
 * instance, and consumes that instance's event loop. Sending it to Redis first
 * would add a network round trip to every message in order to bound a resource
 * that is not shared, on the hot path that flooding attacks.
 *
 * It is the same argument `connection.registry.ts` makes for counting sockets
 * per instance, including why CLAUDE.md §12 is not violated: §12 forbids
 * in-process state that two instances would **disagree** about, and there is
 * nothing to disagree on when each instance bounds exactly what it pays for.
 *
 * **A token bucket rather than a fixed window**, so a client that idles then
 * sends three messages at once is served, while a client sending continuously
 * is held to the sustained rate. A fixed window does the opposite at its
 * boundary: it permits a double-rate burst across the seam and refuses an
 * honest burst inside it.
 */
@Injectable()
export class InboundBudget {
  /**
   * Per socket id, and removed on disconnect.
   *
   * Keyed by socket rather than by account on purpose: the cap on how many
   * sockets an account holds is `ConnectionRegistry`'s job, and folding the
   * two together would mean a user's second device silently halving the first
   * device's budget.
   */
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Spends one token for this socket, or reports that there was none.
   *
   * Synchronous, and that matters: an `await` here would let every frame
   * already in the kernel buffer past the check before the first one finished
   * accounting for itself, which is precisely the flood the budget exists to
   * stop.
   */
  consume(client: AuthenticatedSocket, nowMs: number = Date.now()): boolean {
    const { inboundMessagesPerSecond, inboundBurst } = this.config.realtime;

    const bucket = this.buckets.get(client.id) ?? { tokens: inboundBurst, lastRefillMs: nowMs };

    const elapsedSeconds = Math.max(0, nowMs - bucket.lastRefillMs) / 1000;
    const refilled = Math.min(
      inboundBurst,
      bucket.tokens + elapsedSeconds * inboundMessagesPerSecond,
    );

    if (refilled < 1) {
      // The bucket is still stored, so the refill clock keeps running and a
      // throttled client recovers on its own rather than needing a reconnect.
      this.buckets.set(client.id, { tokens: refilled, lastRefillMs: nowMs });
      return false;
    }

    this.buckets.set(client.id, { tokens: refilled - 1, lastRefillMs: nowMs });
    return true;
  }

  /**
   * Forgets a socket's bucket.
   *
   * Called from the gateway's disconnect hook. Without it the map is a leak
   * whose size is every socket the process has ever seen — and unlike the
   * connection registry there is no account to bound it by.
   */
  release(client: AuthenticatedSocket): void {
    this.buckets.delete(client.id);
  }
}
