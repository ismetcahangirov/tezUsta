/**
 * Changing the address an account signs in with (ADR-0074 § 1, #514, #516).
 *
 * Two calls: a start that mails one code to the account's current address and
 * one to the new address, then a confirm that takes both codes together.
 */

/** `POST /me/email-change`. */
export interface EmailChangeStartRequest {
  readonly newEmail: string;
}

/**
 * The answer to a start.
 *
 * `currentEmail` is the account's own address, returned to its own session so
 * a client can label each code field by the inbox it went to. It says nothing
 * about the new address: whether another account holds that is answered only
 * at confirm, after both codes were right.
 */
export interface EmailChangeStarted {
  readonly expiresInSeconds: number;
  readonly currentEmail: string;
}

/** `POST /me/email-change/confirm`. A success is `204` and revokes every session. */
export interface EmailChangeConfirmRequest {
  readonly currentCode: string;
  readonly newCode: string;
}
