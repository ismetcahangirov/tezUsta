/**
 * The push transport, as everything above it sees it.
 *
 * Written as if `infra/push/` were already a package (ADR-0016, CLAUDE.md §2):
 * **no vendor type appears below**, and nothing outside this folder imports
 * `expo-server-sdk`. Swapping Expo's push service for a direct FCM/APNs
 * integration is then a new file implementing {@link PushSender} plus one enum
 * member, exactly as ADR-0008 arranges for SMS.
 */

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/**
 * What a notification payload may carry, and therefore what it may not.
 *
 * **This type is the enforcement, not a convention.** It is a closed set of
 * optional members with no index signature, so a field named `address`,
 * `phone` or `latitude` does not compile — which is what CLAUDE.md §11's
 * "never log precise coordinates, full phone numbers or full addresses" needs
 * in order to survive a future edit by somebody who has not read it. A lock
 * screen is readable by whoever is holding the phone, and a notification is
 * the one surface that shows data to a person who has not authenticated.
 *
 * Ids only. The client turns an id into a screen by asking the API, which is
 * the same trip it would make anyway and the only one that is
 * ownership-checked.
 */
export interface PushData {
  readonly kind: string;
  readonly orderId?: string | undefined;
  readonly orderStatus?: string | undefined;
}

/** One push, already rendered, addressed to one device. */
export interface PushEnvelope {
  readonly pushToken: string;
  readonly title: string;
  readonly body: string;
  readonly data: PushData;
}

/**
 * What became of one envelope — the **transport's** answer, deliberately
 * narrower than the provider's.
 *
 * Four outcomes rather than Expo's seven error codes, because four is what a
 * caller can act on: record it, retire the device, give up, or try again.
 * Mapping happens inside the adapter, which is the only place that should know
 * that `DeviceNotRegistered` and `MessageTooBig` are different words for
 * different decisions.
 */
export type PushOutcome =
  /**
   * Accepted for delivery — **not delivered**. Expo answers a send with a
   * ticket, and the real outcome only appears at the receipts endpoint minutes
   * later (issue #142). Treating this as success is the most common way this
   * integration is built wrong; the `receiptId` is what makes it checkable.
   */
  | { readonly status: 'accepted'; readonly receiptId: string }
  /** The device is gone — uninstalled, or its credentials rotated. Retire it, never retry. */
  | { readonly status: 'unreachable' }
  /** Our fault or a permanent refusal: a malformed message, bad credentials. Retrying repeats it. */
  | { readonly status: 'rejected'; readonly code: string; readonly message: string }
  /** The provider asked us to come back — rate limited, or a transient provider fault. */
  | { readonly status: 'retryable'; readonly code: string; readonly message: string };

export interface PushSender {
  /**
   * Sends every envelope and answers **index-aligned** with
   * {@link PushOutcome}: the nth outcome belongs to the nth envelope.
   *
   * Chunking is the implementation's problem, not the caller's — Expo caps a
   * request at 100 messages and a broadcast can exceed that. A caller that had
   * to chunk would be a caller that knows the provider's limits.
   *
   * It **does not throw for a per-message failure**; a failure that applies to
   * one device is an outcome, not an exception, or one dead phone would take
   * the other ninety-nine deliveries with it. It may still throw when the
   * whole request failed — no network, provider down — which is the queue's
   * cue to retry the job.
   */
  send(envelopes: readonly PushEnvelope[]): Promise<readonly PushOutcome[]>;
}
