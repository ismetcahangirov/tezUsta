import { Injectable, Logger } from '@nestjs/common';
import type { CallRealtimeEvent, CallRealtimeEventName } from '@tezusta/types';

/**
 * One frame for one account's devices.
 *
 * **Per account rather than per call**, because the payload is: a call is
 * presented to each party as *their* call — their role, the *other* party's
 * name — so the caller and the callee receive two different frames about one
 * transition.
 */
export interface CallDelivery {
  readonly event: CallRealtimeEventName;
  /** The account whose every connected device receives it. */
  readonly userId: string;
  readonly payload: CallRealtimeEvent;
}

export type CallDeliverer = (delivery: CallDelivery) => Promise<void>;

/**
 * Where `modules/realtime` says "put call frames on the socket", without
 * `modules/calls` importing it.
 *
 * **The seam `ConversationEventsRegistry` is, for the reason it gives**: the
 * gateway has to call into `CallsService` for the inbound frames, so an import
 * the other way for the outbound ones would close a cycle (CLAUDE.md §14).
 * Separate from that registry because a call is neither a message nor an
 * order event, and neither registry's subscribers should have to learn to
 * ignore one.
 *
 * **Every delivery is after the commit, and a failure is swallowed.** The call
 * moved; a frame that did not arrive leaves a device showing a stale phase,
 * which the device recovers from by reading the call again — and turning a
 * socket hiccup into a failed hangup would have the client retry an edge the
 * call has already left.
 */
@Injectable()
export class CallEventsRegistry {
  private readonly logger = new Logger(CallEventsRegistry.name);
  private deliverer: CallDeliverer | undefined;

  /** Registering twice is a programming error, not a last-one-wins merge. */
  register(deliverer: CallDeliverer): void {
    if (this.deliverer !== undefined) {
      throw new Error('A call event deliverer is already registered');
    }
    this.deliverer = deliverer;
  }

  /** Delivers each frame, isolating each failure from the others. */
  async publish(deliveries: readonly CallDelivery[]): Promise<void> {
    if (this.deliverer === undefined) {
      return;
    }

    for (const delivery of deliveries) {
      try {
        await this.deliverer(delivery);
      } catch (error) {
        // The frame's name and the call id; never a name, never a token —
        // there is no token on this path to log.
        this.logger.warn(
          `Delivering ${delivery.event} for call ${delivery.payload.call.id} failed; the call stands: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
