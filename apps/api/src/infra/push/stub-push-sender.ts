import { Logger } from '@nestjs/common';

import type { PushEnvelope, PushOutcome, PushSender } from './push-sender.types';

/**
 * Thrown when the stub sender is constructed in production.
 *
 * The same mechanism `StubSmsSender` uses, for the same reason. A runtime
 * `if (nodeEnv !== 'production')` around the send would leave the service
 * booting, accepting orders, reporting green on every health check — and
 * delivering nothing, so a master never sees an offer and a customer never
 * hears that their master is on the way. That is a silent, total notification
 * outage. Refusing to construct turns it into a deploy that fails immediately
 * and says which variable is wrong.
 */
export class StubPushSenderInProductionError extends Error {
  constructor() {
    super(
      'PUSH_PROVIDER=stub cannot be used in production: it delivers no notification, so a ' +
        'master would never see an offer and a customer would never learn their order was ' +
        'accepted. Set PUSH_PROVIDER=expo.',
    );
    this.name = 'StubPushSenderInProductionError';
    Object.setPrototypeOf(this, StubPushSenderInProductionError.prototype);
  }
}

/**
 * The development and test sender: records what would have gone out.
 *
 * Tests assert against {@link sent} rather than against a mocked vendor
 * client, which is what lets them exercise the real queue, the real handler
 * and the real device resolution while stopping exactly at the network.
 */
export class StubPushSender implements PushSender {
  private readonly logger = new Logger(StubPushSender.name);

  /** Every envelope handed to {@link send}, in order, across all calls. */
  readonly sent: PushEnvelope[] = [];

  /**
   * What the next send should answer, by push token.
   *
   * A test that wants to prove a dead token is retired sets `unreachable` for
   * it here. Anything not named is `accepted`, because the ordinary case must
   * not need arranging.
   */
  readonly outcomes = new Map<string, PushOutcome>();

  /**
   * Set to make the whole request fail, the way a network outage does — which
   * is the queue's cue to retry the job rather than a per-device outcome.
   */
  failWith: Error | undefined;

  /**
   * How many of the next requests {@link failWith} applies to, counting down.
   *
   * `Infinity` by default, so setting `failWith` alone fails every request —
   * the permanent-outage case. Setting it to 1 is the transient one, and it is
   * what lets a test prove the retry *recovers* without racing a timer against
   * BullMQ's backoff.
   */
  failTimes = Number.POSITIVE_INFINITY;

  private receiptCounter = 0;

  constructor(private readonly nodeEnv: 'development' | 'test' | 'production') {
    if (nodeEnv === 'production') {
      throw new StubPushSenderInProductionError();
    }
  }

  send(envelopes: readonly PushEnvelope[]): Promise<readonly PushOutcome[]> {
    if (this.failWith !== undefined && this.failTimes > 0) {
      this.failTimes -= 1;
      return Promise.reject(this.failWith);
    }

    this.sent.push(...envelopes);

    if (this.nodeEnv === 'development') {
      for (const envelope of envelopes) {
        // The token is never printed — it is an address anyone holding it can
        // push to (CLAUDE.md §11). The kind and the title are what a developer
        // actually needs to see.
        this.logger.warn(`[STUB PUSH] ${envelope.data.kind}: ${envelope.title}`);
      }
    }

    return Promise.resolve(
      envelopes.map((envelope) => {
        const arranged = this.outcomes.get(envelope.pushToken);
        if (arranged !== undefined) {
          return arranged;
        }
        this.receiptCounter += 1;
        return { status: 'accepted', receiptId: `stub-receipt-${String(this.receiptCounter)}` };
      }),
    );
  }

  /** Forget everything recorded, so one suite's arrangements do not leak into the next. */
  reset(): void {
    this.sent.length = 0;
    this.outcomes.clear();
    this.failWith = undefined;
    this.failTimes = Number.POSITIVE_INFINITY;
  }
}
