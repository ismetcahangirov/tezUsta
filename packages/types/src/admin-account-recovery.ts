/**
 * Support-mediated account recovery (ADR-0074 §§ 2–5, #515): the admin
 * surface under `/admin/account-recoveries`, and the public cancel endpoint
 * the link in the old address's notice reaches.
 */

/**
 * Where a request stands, derived from its timestamps on each read.
 *
 * - `awaiting_code`: opened; the code sent to the new address is not entered yet.
 * - `on_hold`: the code was right; the 72-hour hold is running.
 * - `ready`: the hold has ended; a second admin, a `super_admin`, may approve.
 * - `moved`: the account signs in with the new address.
 * - `cancelled`: stopped before the move (see `cancelSource`).
 */
export type AccountRecoveryStatus = 'awaiting_code' | 'on_hold' | 'ready' | 'moved' | 'cancelled';

export type AccountRecoveryCancelSource = 'admin' | 'link' | 'code_attempts' | 'stale';

/** The account a request is opened against, as the panel knows it. */
export interface AccountRecoverySubject {
  readonly kind: 'customer' | 'master';
  readonly id: string;
}

/** `POST /admin/account-recoveries`. */
export interface AdminAccountRecoveryOpenRequest {
  readonly subject: AccountRecoverySubject;
  readonly newEmail: string;
  /** What the admin matched, in their words (ADR-0074 § 2). */
  readonly evidenceNotes: string;
}

/** `POST /admin/account-recoveries/:id/verify`: the code the user read back from the new address. */
export interface AdminAccountRecoveryVerifyRequest {
  readonly code: string;
}

/** The body of cancel, approve and the address reveal: the reason the audit log keeps. */
export interface AdminAccountRecoveryReasonRequest {
  readonly reason: string;
}

/** One request. Both addresses are masked; `pii.read` reveals them with a reason. */
export interface AdminAccountRecovery {
  readonly id: string;
  readonly status: AccountRecoveryStatus;
  /** The account's customer profile, when it has one. */
  readonly customerId: string | null;
  /** The account's master profile, when it has one: the evidence is matched against its documents. */
  readonly masterId: string | null;
  readonly oldEmailMasked: string;
  readonly newEmailMasked: string;
  readonly evidenceNotes: string;
  readonly openedByAdminId: string;
  readonly openedAt: string;
  readonly codeExpiresAt: string;
  readonly codeVerifiedAt: string | null;
  /** When the move may be approved. Null until the code is verified. */
  readonly holdUntil: string | null;
  readonly cancelledAt: string | null;
  readonly cancelSource: AccountRecoveryCancelSource | null;
  readonly cancelledByAdminId: string | null;
  readonly cancelReason: string | null;
  readonly approvedByAdminId: string | null;
  readonly movedAt: string | null;
}

/** `POST /admin/account-recoveries/:id/emails`: both addresses, audited with the reason. */
export interface AdminAccountRecoveryEmails {
  readonly oldEmail: string;
  readonly newEmail: string;
}

/** `POST /account-recovery/cancel`: the token from the link's fragment. Answered 204 whatever it names. */
export interface AccountRecoveryCancelRequest {
  readonly token: string;
}
