/**
 * The email delivery boundary (ADR-0072 § 6: the sender sits behind an
 * interface, like the maps provider in ADR-0004).
 *
 * **Which provider TezUsta uses is still an open decision** and blocks real
 * sign-in (CLAUDE.md §1). This interface is what lets the rest of
 * authentication be built and tested without it: choosing a provider becomes
 * one new file implementing {@link EmailSender} plus one enum value in
 * `env.schema.ts`.
 *
 * It lives here rather than in a shared package until a second consumer
 * exists (ADR-0016). Nothing in this file names a vendor, carries a vendor
 * type, or knows that HTTP exists — which is what keeps that later move a file
 * move.
 */

/**
 * One message to one recipient.
 *
 * `to` has already been through `infra/email/email-address.ts`. A sender
 * never normalises — by the time an address reaches a provider it is far too
 * late to discover it was typed with a trailing space.
 */
export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  /**
   * The rendered plain-text body.
   *
   * **This string contains the OTP code.** It must never be logged, traced, or
   * attached to an error — ADR-0072 § Security requirements, with the single
   * documented exception of the development stub, which cannot run in
   * production by construction (see `stub-email-sender.ts`). An
   * implementation that logs its own request payload for debugging breaks
   * that guarantee quietly and completely.
   */
  readonly text: string;
}

/**
 * Sends one message, or throws.
 *
 * Deliberately returns `void` rather than a provider message id: nothing in
 * TezUsta polls delivery status, and returning an id would invite a caller to
 * store it, which would tie a database column to whichever provider happens
 * to be configured.
 *
 * Throwing is the contract for failure. A sender that swallows an error and
 * returns normally produces the worst possible outcome: a user waiting for a
 * code that was never sent, and a server that believes it succeeded.
 */
export interface EmailSender {
  send(message: OutboundEmail): Promise<void>;
}

/**
 * DI token for {@link EmailSender}. An interface cannot be injected by its own
 * type (mirrors `infra/config/config.tokens.ts` and
 * `infra/redis/redis.tokens.ts`).
 */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
