import { Injectable, Logger } from '@nestjs/common';
import type { CallPartyKind } from '@tezusta/types';

/**
 * A call that has **already committed** as `RINGING` (issue #189).
 *
 * Ids and one side, never names and never anything a credential could be made
 * from: a subscriber that needs more re-reads it, which is what lets the push
 * worker decide on the call as it is when the job runs rather than as it was
 * when the invite landed.
 */
export interface CallRingingEvent {
  readonly callId: string;
  readonly orderId: string;
  /** The account being rung — the callee, never the caller. */
  readonly calleeUserId: string;
  /** Which side of the order is calling, so the callee can be told who. */
  readonly callerKind: CallPartyKind;
}

export type CallRingSubscriber = (event: CallRingingEvent) => Promise<void>;

/**
 * Where `modules/notifications` says "tell me when a call starts ringing",
 * without `modules/calls` importing it (#189, ADR-0039 § 4).
 *
 * **The seam `ConversationEventsRegistry` is, and for the same reason.** The
 * push worker has to re-read the call when its job runs — a push for a call
 * that was answered, declined or cancelled in the meantime must not ring — so
 * `modules/notifications` imports `modules/calls` for that read. A raise wired
 * the other way, calls → notifications, would close a cycle (CLAUDE.md §14).
 * So the arrow points notifications → calls, and the ring leaves through this
 * slot.
 *
 * Separate from {@link CallEventsRegistry} because that one is a single slot
 * the socket fills with per-account frames for every transition; a push is
 * raised for exactly one of them and wants neither the frame nor the others.
 *
 * **Every raise is after the commit, and every failure is swallowed.** The
 * call rings over the socket whatever happens here; a queue hiccup must not
 * turn a committed invite into a refusal the caller would retry.
 */
@Injectable()
export class CallRingRegistry {
  private readonly logger = new Logger(CallRingRegistry.name);
  private readonly subscribers = new Map<string, CallRingSubscriber>();

  /**
   * @param name What this consumer is called in a failure log. Unique;
   *   registering it twice is a programming error, not a last-one-wins merge.
   */
  register(name: string, subscriber: CallRingSubscriber): void {
    if (this.subscribers.has(name)) {
      throw new Error(`A call ring subscriber named ${name} is already registered`);
    }
    this.subscribers.set(name, subscriber);
  }

  /** Announce a committed ringing call. Call after the write, never inside it. */
  async ringing(event: CallRingingEvent): Promise<void> {
    for (const [name, subscriber] of this.subscribers) {
      try {
        await subscriber(event);
      } catch (error) {
        // The call id and nothing else: no name, no token — there is none on
        // this path to log.
        this.logger.warn(
          `Raising ${name} for ringing call ${event.callId} failed; the call still rings: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
