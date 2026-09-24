import type { OrderActorKind, OrderStatus } from './order.js';

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

/**
 * `POST /admin/auth/sign-in` (ADR-0043 § 4) — all three factors in one
 * request. Answers `AdminMe` and sets the two session cookies; any failure is
 * one `401`.
 */
export interface AdminSignInRequest {
  readonly email: string;
  readonly password: string;
  readonly code: string;
}

/** Who performed an audited action — resolved for display. */
export interface AdminAuditActor {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

/**
 * One row of `GET /admin/audit-log` (ADR-0043 § 6), newest first.
 * `before` / `after` hold only the fields the action changed; both are null
 * for a read.
 */
export interface AdminAuditEntry {
  readonly id: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string | null;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly actor: AdminAuditActor;
}

/** One row of `GET /admin/admins` (ADR-0043 § 1, § 3). */
export interface AdminAccount {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: 'active' | 'disabled';
  readonly roles: readonly AdminRole[];
  /** Whether setup finished — a password and a proven authenticator. */
  readonly enrolled: boolean;
  /** A live, unused setup link exists. */
  readonly invitationPending: boolean;
  readonly createdAt: string;
}

/**
 * The answer to an invitation or a second-factor reset. `setupLink` is shown
 * **once** — only its digest is stored — and is handed over out of band.
 */
export interface AdminInvitationIssued {
  readonly admin: AdminAccount;
  readonly setupLink: string;
  readonly setupLinkExpiresAt: string;
}

/** A category as the admin catalogue editor sees it — inactive ones included. */
export interface AdminCatalogueCategory {
  readonly id: string;
  readonly slug: string;
  /** Every language, not the one the app would pick: the editor edits them all. */
  readonly name: Readonly<Record<string, string>>;
  readonly displayOrder: number;
  readonly isActive: boolean;
  readonly services: readonly AdminCatalogueService[];
}

export interface AdminCatalogueService {
  readonly id: string;
  readonly categoryId: string;
  readonly slug: string;
  readonly name: Readonly<Record<string, string>>;
  readonly pricingKind: 'fixed' | 'inspection';
  /** Minor units; null for an inspection-priced service. */
  readonly basePriceMinor: number | null;
  readonly displayOrder: number;
  readonly isActive: boolean;
}

/** `GET /admin/catalogue` (issue #244). */
export interface AdminCatalogue {
  readonly categories: readonly AdminCatalogueCategory[];
}

/** One row of `GET /admin/orders` and of the dispute queue (issue #245). */
export interface AdminOrderSummary {
  readonly id: string;
  readonly status: OrderStatus;
  /** In Azerbaijani, the catalogue's fallback language. */
  readonly serviceName: string;
  readonly customerName: string;
  readonly masterName: string | null;
  readonly priceMinor: number | null;
  readonly redispatchCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A party to an order as the panel shows it — the number masked. */
export interface AdminOrderParty {
  /** The customer or master profile id. */
  readonly id: string;
  readonly displayName: string;
  /** `+994 •• ••• •• 67`. The full number is a separate, audited reveal. */
  readonly phoneMasked: string;
}

export interface AdminOrderHistoryEntry {
  readonly fromStatus: OrderStatus;
  readonly toStatus: OrderStatus;
  readonly actorKind: OrderActorKind;
  /** Set when an admin made the change. */
  readonly actorAdminName: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

/** An edge an admin may drive from the current status. */
export interface AdminOrderTransitionOption {
  readonly to: OrderStatus;
  /** `false` for `REFUNDED` until EPIC 12 (ADR-0043 § 5). */
  readonly available: boolean;
}

/** `GET /admin/orders/:orderId` — audited as `order.read`. */
export interface AdminOrderDetail extends AdminOrderSummary {
  readonly description: string;
  readonly acceptedAt: string | null;
  readonly address: {
    readonly formattedAddress: string;
    readonly building: string | null;
    readonly entrance: string | null;
    readonly floor: string | null;
    readonly apartment: string | null;
    readonly landmarkNote: string | null;
  };
  readonly customer: AdminOrderParty;
  readonly master: AdminOrderParty | null;
  /** Oldest first. */
  readonly history: readonly AdminOrderHistoryEntry[];
  readonly photos: readonly {
    readonly id: string;
    readonly status: string;
    readonly createdAt: string;
  }[];
  readonly transitions: readonly AdminOrderTransitionOption[];
  /** Whether `GET …/transcript` will answer — disputed orders only. */
  readonly transcriptAvailable: boolean;
}

/** `POST /admin/orders/:orderId/parties/:party/phone` — audited with its reason. */
export interface AdminPhoneReveal {
  readonly phoneE164: string;
}

/** `GET /admin/orders/:orderId/transcript` — one conversation per assigned master. */
export interface AdminOrderTranscript {
  readonly conversations: readonly {
    readonly id: string;
    readonly masterId: string;
    readonly openedAt: string;
    readonly closedAt: string | null;
    /** Oldest first; at most the latest 500 per conversation. */
    readonly messages: readonly {
      readonly id: string;
      readonly senderKind: 'customer' | 'master';
      readonly body: string;
      readonly createdAt: string;
    }[];
  }[];
}
