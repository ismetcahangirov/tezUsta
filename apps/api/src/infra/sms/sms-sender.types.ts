/**
 * The SMS provider boundary (ADR-0008 § Do not: "do not hardcode a provider —
 * the sender sits behind an interface, like the maps provider in ADR-0004").
 *
 * **Which provider TezUsta uses is still an open decision** and is the single
 * highest-priority launch blocker (CLAUDE.md §1). This interface is what lets
 * the rest of authentication be built and tested without it: everything above
 * this line is finished, and choosing a provider becomes one new file
 * implementing {@link SmsSender} plus one enum value in `env.schema.ts`.
 *
 * ADR-0008 originally placed this interface in `packages/config`; ADR-0016
 * superseded that clause, so it lives here until a second consumer exists.
 * Nothing in this file names a vendor, carries a vendor type, or knows that
 * HTTP exists — which is what keeps that later move a file move.
 */

/**
 * One message to one recipient.
 *
 * `to` is E.164 and has already been through
 * `infra/phone/azerbaijani-phone.ts`. A sender never normalises — by the time
 * a number reaches a provider it is far too late to discover it was typed with
 * a leading zero.
 */
export interface OutboundSms {
  readonly to: string;
  /**
   * The rendered message body.
   *
   * **This string contains the OTP code.** It must never be logged, traced, or
   * attached to an error — ADR-0008 § Security requirements, with the single
   * documented exception of the development stub, which cannot run in
   * production by construction (see `stub-sms-sender.ts`). An implementation
   * that logs its own request payload for debugging breaks that guarantee
   * quietly and completely.
   */
  readonly body: string;
}

/**
 * Sends one message, or throws.
 *
 * Deliberately returns `void` rather than a provider message id: nothing in
 * TezUsta polls delivery status today, and returning an id would invite a
 * caller to store it, which would tie a database column to whichever provider
 * happens to be configured. Add it when something actually reconciles
 * delivery — a real provider webhook, not a hypothetical one.
 *
 * Throwing is the contract for failure. A sender that swallows an error and
 * returns normally produces the worst possible outcome: a user waiting for a
 * code that was never sent, and a server that believes it succeeded.
 */
export interface SmsSender {
  send(message: OutboundSms): Promise<void>;
}

/**
 * DI token for {@link SmsSender}. An interface cannot be injected by its own
 * type (mirrors `infra/config/config.tokens.ts` and
 * `infra/redis/redis.tokens.ts`).
 */
export const SMS_SENDER = Symbol('SMS_SENDER');
