import type { NotificationChannelId, PushData } from '@tezusta/types';

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
 * **Re-exported from `@tezusta/types` rather than declared here**, because the
 * app is the other end of it: the payload leaves this process, travels through
 * Expo's push service, and is read by `apps/mobile` to decide which screen a
 * tap opens (issue #146). Two declarations of that shape would be two
 * declarations that can disagree, and the disagreement would show up as a
 * notification that opens nothing.
 *
 * The rule the type enforces is unchanged and is the reason it is a closed set
 * with no index signature: a field named `address`, `phone` or `latitude` does
 * not compile. A lock screen is readable by whoever is holding the phone, and
 * a notification is the one surface that shows data to a person who has not
 * authenticated (CLAUDE.md §11).
 */
export type { NotificationChannelId, PushData };

/** One push, already rendered, addressed to one device. */
export interface PushEnvelope {
  readonly pushToken: string;
  readonly title: string;
  readonly body: string;
  readonly data: PushData;
  /**
   * Which Android channel to deliver on — **required, not optional** (#157).
   *
   * Optional would have been the smaller diff and the wrong type: a channel
   * left unset is not a channel unset, it is delivery into the manifest's
   * default, and that is a decision about how loudly somebody's phone rings.
   * Making every caller name one means the decision is made in
   * `notification-categories.ts`, where it is read next to the preference
   * switch it matches, rather than by whoever forgot the field.
   *
   * **Ignored on iOS**, which has no channels; the sound and interruption level
   * of an iOS notification are the message's own business. Nothing here
   * pretends otherwise, and a reader should not expect an iOS effect from
   * changing it.
   */
  readonly channelId: NotificationChannelId;
  /**
   * How long the provider may hold an undelivered push before dropping it, in
   * seconds (#189). **Absent means the provider's default** — Expo passes it
   * on to FCM and APNs, whose default is weeks — which is what every kind but
   * a ring wants: an order update that arrives late is still worth reading. A
   * ring that arrives after it stopped ringing is not, so it carries the ring
   * timeout.
   */
  readonly ttlSeconds?: number | undefined;
  /**
   * `'default'` plays the platform's notification sound **on iOS** (#189);
   * absent is silent there, as every notification before calls has been.
   * Android ignores it — the channel decides — so nothing here changes an
   * Android delivery.
   */
  readonly sound?: 'default' | undefined;
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

/**
 * What Expo eventually says became of one accepted push (issue #142).
 *
 * **Six outcomes rather than the send path's four**, and the extra two are the
 * point of this issue. A receipt is where the errors a send cannot see finally
 * arrive, and collapsing them would lose exactly the distinctions an operator
 * needs: a credentials failure is nobody's device being dead, and an oversized
 * message is nobody's credentials being wrong. `unknown` exists because
 * retiring a working device on an error code nobody has read is how an install
 * silently stops receiving anything.
 */
export type PushReceiptOutcome =
  /** It arrived. Nothing to do but stop asking. */
  | { readonly status: 'delivered' }
  /** The install is gone. Retire the device, and never retry. */
  | { readonly status: 'unreachable' }
  /** Expo or the platform had a moment. Not the device's fault; nothing to fix. */
  | { readonly status: 'transient'; readonly code: string; readonly message: string }
  /** Ours: a malformed or oversized message. A bug in the sender, not in the device. */
  | { readonly status: 'sender-error'; readonly code: string; readonly message: string }
  /** The project's push credentials are wrong. An operator has to act; retire nothing. */
  | { readonly status: 'credentials'; readonly code: string; readonly message: string }
  /** A code this release has never heard of. Log it; change nothing. */
  | { readonly status: 'unknown'; readonly code: string; readonly message: string };

export const PUSH_RECEIPT_SOURCE = Symbol('PUSH_RECEIPT_SOURCE');

/**
 * The second half of Expo's two-phase push API, as the sweep sees it.
 *
 * **A separate interface from {@link PushSender} even though one class
 * implements both.** The sweep must be able to read outcomes and must not be
 * able to send, and a port it cannot call is a stronger guarantee than a
 * convention that it does not — the same argument `AddressableDevice` makes
 * for the token it carries.
 */
export interface PushReceiptSource {
  /**
   * Asks about `receiptIds` and answers **keyed by id, not index-aligned**.
   *
   * The shape is the provider's and it is load-bearing: a receipt that is not
   * ready yet is simply **absent from the map**, which is how "still pending"
   * is expressed without inventing a status for it. A caller that assumed one
   * entry per id would read a pending receipt as a missing one and could
   * delete a worklist row before its answer existed.
   *
   * Chunking is the implementation's problem, not the caller's.
   *
   * It may throw when the whole request failed — no network, provider down —
   * which is the sweep's cue to leave every row alone and come back.
   */
  fetchReceipts(receiptIds: readonly string[]): Promise<ReadonlyMap<string, PushReceiptOutcome>>;
}
