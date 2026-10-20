import { Injectable, Logger } from '@nestjs/common';
import type { ArrivalPromiseSource } from '@tezusta/types';

/** One arrival promise that has **already been written** (#396). */
export interface ArrivalPromiseWritten {
  readonly orderId: string;
  readonly promisedArrivalAt: Date;
  readonly source: ArrivalPromiseSource;
}

export type ArrivalPromiseListener = (promise: ArrivalPromiseWritten) => Promise<void>;

/**
 * Where `modules/realtime` says "tell me when a promise is fixed", without the
 * module that computes it importing the gateway — the arrow
 * `order-search-waves.registry.ts` keeps, for the same reason. One listener.
 *
 * **A promise may never be lost because its frame was.** It is in the
 * database; both apps read it over HTTP on their next refetch. A failed
 * publish is logged and swallowed, so the job does not retry and call Google
 * again for the sake of a hint.
 */
@Injectable()
export class ArrivalPromisesRegistry {
  private readonly logger = new Logger(ArrivalPromisesRegistry.name);
  private listener: ArrivalPromiseListener | undefined;

  /** Registering twice is a programming error, not a last-one-wins merge. */
  register(listener: ArrivalPromiseListener): void {
    if (this.listener !== undefined) {
      throw new Error('An arrival promise listener is already registered');
    }
    this.listener = listener;
  }

  async promised(promise: ArrivalPromiseWritten): Promise<void> {
    if (this.listener === undefined) {
      return;
    }

    try {
      await this.listener(promise);
    } catch (error) {
      this.logger.warn(
        `Announcing the arrival promise of order ${promise.orderId} failed; the promise stands: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
