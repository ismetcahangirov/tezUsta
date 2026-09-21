import { Logger } from '@nestjs/common';
import type { Expo, ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';

import type {
  PushEnvelope,
  PushOutcome,
  PushReceiptOutcome,
  PushReceiptSource,
  PushSender,
} from './push-sender.types';

/**
 * The two methods this adapter uses, named as a type so a test can supply a
 * fake without a network and without `EXPO_BASE_URL` — which the SDK
 * documents as internal to Expo.
 */
export type ExpoPushClient = Pick<
  Expo,
  | 'chunkPushNotifications'
  | 'sendPushNotificationsAsync'
  | 'chunkPushNotificationReceiptIds'
  | 'getPushNotificationReceiptsAsync'
>;

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
export class ExpoPushSender implements PushSender, PushReceiptSource {
  private readonly logger = new Logger(ExpoPushSender.name);

  /**
   * The client is injected rather than constructed here so a test can drive
   * chunking and every outcome branch against a fake, without a network and
   * without `EXPO_BASE_URL` — which the SDK documents as internal to Expo.
   */
  constructor(private readonly client: ExpoPushClient) {}

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

  /**
   * Asks Expo what became of the pushes it accepted (issue #142).
   *
   * **The answer is a map and a missing key means "not yet"**, which is the
   * provider's own shape — `getPushNotificationReceiptsAsync` is declared
   * `Promise<{ [id: string]: ExpoPushReceipt }>` on the shipped
   * `expo-server-sdk@7.2.0`, and a receipt Expo has not produced is simply not
   * in the object. This method preserves that rather than filling the gaps,
   * because a gap is the one answer the sweep must not mistake for a verdict.
   */
  async fetchReceipts(
    receiptIds: readonly string[],
  ): Promise<ReadonlyMap<string, PushReceiptOutcome>> {
    const resolved = new Map<string, PushReceiptOutcome>();
    if (receiptIds.length === 0) {
      return resolved;
    }

    // The SDK's own chunker again, not a hand-rolled slice: the receipt limit
    // is a different number from the message limit (300 against 100 on 7.2.0)
    // and both are the vendor's to change.
    const chunks = this.client.chunkPushNotificationReceiptIds([...receiptIds]);

    for (const chunk of chunks) {
      // Sequential for the reason `send` is: the client already limits itself
      // to six concurrent requests, and firing every chunk at once queues them
      // inside the vendor's limiter where this code cannot see them.
      const receipts = await this.client.getPushNotificationReceiptsAsync(chunk);
      for (const [receiptId, receipt] of Object.entries(receipts)) {
        resolved.set(receiptId, this.toReceiptOutcome(receipt));
      }
    }

    return resolved;
  }

  /**
   * One receipt as a decision.
   *
   * **Every branch is reached by a distinct code and none of them is a
   * fallthrough**, which is what issue #142 asks for in as many words: a rate
   * error is transient, a credentials error is an operator's problem and not
   * the device's, and an oversized message is a bug on this side. Collapsing
   * them would turn three different actions into one shrug.
   */
  private toReceiptOutcome(receipt: ExpoPushReceipt): PushReceiptOutcome {
    if (receipt.status === 'ok') {
      return { status: 'delivered' };
    }

    /**
     * Read as a **string, not as the SDK's union**, and that is not laziness.
     *
     * `expo-server-sdk@7.2.0` types seven receipt errors; Expo's documentation
     * lists five, and the two lists do not nest — `MismatchSenderId` is
     * documented and is absent from the type, so a real receipt carrying it
     * would not narrow. Widening here is what lets the documented code below
     * be handled at all.
     */
    const code: string | undefined = receipt.details?.error;
    const message = receipt.message;

    switch (code) {
      /**
       * The only code that costs a device its registration, and the only one
       * Expo documents as appearing in a **ticket** as well as a receipt.
       *
       * Expo also warns that it arrives late: *"The `DeviceNotRegistered`
       * error appears in push receipts only when Google or Apple deems the
       * device to be unregistered. It takes an undefined amount of time and is
       * often impossible to test by uninstalling your app and sending a push
       * notification shortly after."*
       * (docs.expo.dev/push-notifications/sending-notifications, § Push
       * receipt errors, read 21 September 2026.)
       */
      case 'DeviceNotRegistered':
        return { status: 'unreachable' };

      /**
       * Two codes, one action: an operator has to change configuration, and
       * no amount of retrying or device-retiring will help.
       * `MismatchSenderId` is the FCM half — *"there is an issue with your FCM
       * push credentials"* — and is documented but **not** in the SDK's union,
       * which is why `code` is widened above.
       */
      case 'InvalidCredentials':
      case 'MismatchSenderId':
        return { status: 'credentials', code, message };

      /**
       * Ours, and identical on every retry: *"The total notification payload
       * was too large. On Android and iOS, the total payload must be at most
       * 4096 bytes."*
       */
      case 'MessageTooBig':
        return { status: 'sender-error', code, message };

      /**
       * **The only code Expo tells the sender to retry**: *"You are sending
       * messages too frequently to the given device. Implement exponential
       * backoff and slowly retry sending messages."* Everything else that
       * looks transient is a guess, and the branch below is where guesses go.
       */
      case 'MessageRateExceeded':
        return { status: 'transient', code, message };

      default:
        /**
         * Everything else, including three codes the shipped SDK types and
         * **no Expo documentation defines**: `DeveloperError`, `ExpoError`
         * and `ProviderError`. They were added to the union in `0fa2e0ee`
         * (2024-03-19) whose pull request body is empty, and they appear
         * nowhere in `expo/expo`'s push-notification docs. Their names invite
         * a sender-fault / Expo-fault / platform-fault reading, and that
         * reading is inference rather than evidence (CLAUDE.md §9).
         *
         * **Never `unreachable`.** Retiring a device on a word nobody has read
         * is how a working install stops receiving anything with no error
         * anywhere to explain it — and unlike the send path, where an
         * unrecognised code costs one retry, here it would cost the device
         * permanently.
         *
         * The send path's table above maps those three deliberately and this
         * one does not: there, a wrong guess is a retry; here, it is a verdict
         * on somebody's phone.
         */
        return { status: 'unknown', code: code ?? 'UnknownExpoError', message };
    }
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
