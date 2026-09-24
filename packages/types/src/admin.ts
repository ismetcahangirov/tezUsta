/**
 * The admin panel's identity contracts
 * ([ADR-0043](../../../docs/decisions/ADR-0043-admin-panel-policy.md) § 1).
 *
 * Types only, like everything in this package. The server enforces the
 * role → permission bundles; the panel reads `AdminMe.permissions` to decide
 * what to show, which is a convenience and never the check.
 */

/** The four admin roles. An admin holds one or more. */
export type AdminRole = 'support' | 'moderator' | 'finance' | 'super_admin';

/** Every permission an admin handler can require. */
export type AdminPermission =
  | 'dashboard.read'
  | 'orders.read'
  | 'orders.override'
  | 'disputes.resolve'
  | 'disputes.refund'
  | 'pii.read'
  | 'calls.read'
  | 'masters.read'
  | 'masters.review'
  | 'masters.suspend'
  | 'reviews.moderate'
  | 'catalogue.manage'
  | 'audit.read'
  | 'admins.manage';

/** `GET /admin/me` — the signed-in admin, read from the database on this request. */
export interface AdminMe {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly AdminRole[];
  /** The union of the roles' bundles, in a stable order. */
  readonly permissions: readonly AdminPermission[];
}

/**
 * `POST /admin/auth/setup/start` — what the setup page needs to enrol an
 * authenticator (ADR-0043 § 3). The token goes in the body, never the path, so
 * it stays out of access logs.
 */
export interface AdminSetupStartRequest {
  readonly token: string;
}

export interface AdminSetupStart {
  readonly email: string;
  readonly displayName: string;
  /** Base32, for typing into an authenticator by hand. */
  readonly totpSecret: string;
  /** `otpauth://` URI, for the QR code. */
  readonly otpauthUri: string;
  /**
   * An opaque, sealed, short-lived proof of which secret was offered. Sent
   * back with the first code; nothing is written until that code is valid.
   */
  readonly enrolment: string;
}

/** `POST /admin/auth/setup/complete` — answers 204. */
export interface AdminSetupCompleteRequest {
  readonly token: string;
  readonly password: string;
  readonly enrolment: string;
  readonly code: string;
}
