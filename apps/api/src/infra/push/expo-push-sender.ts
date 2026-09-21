import { Logger } from '@nestjs/common';
import type { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';

import type { PushEnvelope, PushOutcome, PushSender } from './push-sender.types';

/**
 * The two methods this adapter uses, named as a type so a test can supply a
 * fake without a network and without `EXPO_BASE_URL` — which the SDK
 * documents as internal to Expo.
 */
export type ExpoPushClient = Pick<Expo, 'chunkPushNotifications' | 'sendPushNotificationsAsync'>;

type FailureStatus = Exclude<PushOutcome['status'], 'accepted'>;

/**
 * How Expo's error codes become the four decisions a caller can act on.
 *
 * Taken from `expo-server-sdk@7.2.0`'s `ExpoPushErrorReceipt['details']['error']`
 * — read from the shipped `build/ExpoClient.d.ts`, which is also where the
 * surprising part is: `ExpoPushErrorTicket = ExpoPushErrorReceipt`. The ticket
 * and the receipt carry **the same** error union, so every code below can
 * arrive at send time as well as at receipt time, and `DeviceNotRegistered`
 * genuinely does.
 *
 * An unlisted code maps to `retryable` deliberately. The alternative — treat
 * the unknown as fatal — retires a working device on a word nobody has read,
 * and a device that stops receiving everything is a worse failure than a job
 * that runs twice.
 */
const OUTCOME_BY_EXPO_ERROR: Readonly<Record<string, FailureStatus>> = Object.freeze({
  // The install is gone. Retiring is the only correct response, and Apple and
  // Google both penalise senders who keep pushing to it.
  DeviceNotRegistered: 'unreachable',
  // Ours to fix, and identical on every retry.
  MessageTooBig: 'rejected',
  DeveloperError: 'rejected',
  // Not the device's fault and not fixable by retrying this message — an
  // operator has to look at the project's push credentials.
  InvalidCredentials: 'rejected',
  // Expo asking us to slow down, and a provider fault on the far side.
  MessageRateExceeded: 'retryable',
  ProviderError: 'retryable',
  ExpoError: 'retryable',
});

/**
 * The Expo push service, behind {@link PushSender}.
 *
 * **`infra/push/` is the only folder that names `expo-server-sdk` at all**,
 * and this file names it only as a *type*: the client is injected, so the
 * adapter has no runtime dependency on the vendor and `push.module.ts` is the
 * single place that constructs one. Everything above sees four outcomes and
 * knows nothing about tickets, chunk limits or error strings.
 *
 * Two behaviours of the vendor client are worth knowing before changing
 * anything here, both read from the shipped package rather than from the
 * documentation:
 *
 * - **It retries internally.** `requestAsync` wraps each HTTP call in
 *   `promise-retry` with `retries: 2` and a minimum timeout of 1000 ms. Those
 *   attempts **multiply** with BullMQ's `QUEUE_JOB_ATTEMPTS` rather than
 *   replacing them, so a job configured for 3 attempts can reach the service
 *   nine times. That is acceptable for a transport whose failure mode is a
 *   lost notification, and it is the reason this class does not add a third
 *   retry layer of its own.
 * - **It limits itself to six concurrent requests** (`defaultConcurrentRequestLimit`),
 *   so a large broadcast is already paced without the worker doing anything.
 *   `QUEUE_WORKER_CONCURRENCY` stays the only throttle this repository
 *   configures (ADR-0025).
 */
export class ExpoPushSender implements PushSender {
  private readonly logger = new Logger(ExpoPushSender.name);

  /**
   * The client is injected rather than constructed here so a test can drive
   * chunking and every outcome branch against a fake, without a network and
   * without `EXPO_BASE_URL` — which the SDK documents as internal to Expo.
   */
  constructor(
    private readonly client: Pick<Expo, 'chunkPushNotifications' | 'sendPushNotificationsAsync'>,
  ) {}

  async send(envelopes: readonly PushEnvelope[]): Promise<readonly PushOutcome[]> {
    if (envelopes.length === 0) {
      return [];
    }

    const messages = envelopes.map(toExpoMessage);
    // The SDK's own chunker, not a hand-rolled `slice(0, 100)`: the limit is
    // the vendor's to change, and `_getActualMessageCount` counts a message
    // addressed to several tokens as several. Verified on 7.2.0 — 250
    // messages chunk as [100, 100, 50].
    const chunks = this.client.chunkPushNotifications(messages);

    const outcomes: PushOutcome[] = [];
    for (const chunk of chunks) {
      // Sequential rather than `Promise.all`: the client already limits itself
      // to six concurrent requests, and issuing every chunk at once would
      // queue them inside the vendor's limiter where this code can no longer
      // see or stop them.
      const tickets = await this.client.sendPushNotificationsAsync(chunk);
      // Expo answers index-aligned with the chunk it was given, and
      // `PushSender` promises the same alignment to its caller — which holds
      // only because the chunker preserves order and every message here
      // carries exactly one token.
      outcomes.push(...tickets.map((ticket) => this.toOutcome(ticket)));
    }

    return outcomes;
  }

  private toOutcome(ticket: ExpoPushTicket): PushOutcome {
    if (ticket.status === 'ok') {
      return { status: 'accepted', receiptId: ticket.id };
    }

    const code = ticket.details?.error ?? 'UnknownExpoError';
    const status = OUTCOME_BY_EXPO_ERROR[code] ?? 'retryable';

    if (status === 'unreachable') {
      return { status };
    }
    if (OUTCOME_BY_EXPO_ERROR[code] === undefined) {
      // Worth a line: an error code the vendor added and this map has not
      // caught up with is treated as transient, so it will be retried forever
      // unless somebody notices. The token is not logged — the ticket carries
      // `details.expoPushToken`, and it is an address (CLAUDE.md §11).
      this.logger.warn(`Unrecognised Expo push error "${code}" — treating it as retryable`);
    }
    return { status, code, message: ticket.message };
  }
}

/**
 * One envelope as Expo's wire format.
 *
 * `priority: 'high'` because every notification this product sends is about
 * something the person is waiting on — an offer expiring in seconds, a master
 * at the door. There is no digest or marketing traffic here to deprioritise.
 */
function toExpoMessage(envelope: PushEnvelope): ExpoPushMessage {
  return {
    to: envelope.pushToken,
    title: envelope.title,
    body: envelope.body,
    data: { ...envelope.data },
    priority: 'high',
  };
}
