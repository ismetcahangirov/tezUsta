import { Injectable, Logger } from '@nestjs/common';

import { describeDatabaseFailure } from '../../infra/database/database-error';

/**
 * One dispatch wave that reached its broadcast step, **after** its offers
 * committed (issue #397). Raised for a wave that reached nobody too, so the
 * radar's ring still grows (ADR-0055 § 5).
 */
export interface OrderSearchWave {
  readonly orderId: string;
  /** The round the clock implies, as the wave broadcast at. */
  readonly round: number;
  readonly radiusM: number;
  /** Masters this search has offered the order to so far, all waves included. */
  readonly offeredCount: number;
}

export type OrderSearchWaveListener = (wave: OrderSearchWave) => Promise<void>;

/**
 * Where `modules/realtime` says "tell me when a wave has run", without
 * `modules/dispatch` importing it.
 *
 * **The arrow points this way for the reason `order-notifications.registry.ts`
 * gives**: realtime reads orders, masters and customers to authorize a room,
 * and dispatch imports orders, so a direct call from dispatch to the gateway
 * would need an import that closes a loop. One listener, like
 * `MasterLocationRegistry`: the frame is a hint for one app's radar, not a
 * fact several consumers deliver.
 *
 * **A wave may never fail because its frame did.** A failed publish is logged
 * at `warn` and swallowed here; a thrown wave job would retry and re-run the
 * broadcast for the sake of a hint.
 */
@Injectable()
export class OrderSearchWavesRegistry {
  private readonly logger = new Logger(OrderSearchWavesRegistry.name);
  private listener: OrderSearchWaveListener | undefined;

  /** Registering twice is a programming error, not a last-one-wins merge. */
  register(listener: OrderSearchWaveListener): void {
    if (this.listener !== undefined) {
      throw new Error('An order search wave listener is already registered');
    }
    this.listener = listener;
  }

  /** Whether anybody is listening, so a caller can skip work only a listener needs. */
  get listening(): boolean {
    return this.listener !== undefined;
  }

  /** Announce a wave whose offers have committed. Call it after the write, never inside it. */
  async waved(wave: OrderSearchWave): Promise<void> {
    if (this.listener === undefined) {
      return;
    }

    try {
      await this.listener(wave);
    } catch (error) {
      // The radar's reads are bound to the address's point, and a failed
      // query's message carries its parameters (#424).
      this.logger.warn(
        `Announcing wave ${String(wave.round)} of order ${wave.orderId} failed; the wave stands: ${
          describeDatabaseFailure(error) ?? (error instanceof Error ? error.message : String(error))
        }`,
      );
    }
  }
}
