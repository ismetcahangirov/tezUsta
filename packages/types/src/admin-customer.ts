/**
 * The admin panel's view of customer accounts (`/admin/customers`, #328,
 * [ADR-0050](../../../docs/decisions/ADR-0050-admin-customer-accounts.md)).
 *
 * A status here is the **account's** (`users.status`), not the customer
 * profile's: one account has one status, so suspending a customer who is also
 * a master stops both.
 */

/** Where an account stands. `deleted` is a soft-deleted account. */
export type AdminAccountStatus = 'active' | 'suspended' | 'deleted';

/** One row of `GET /admin/customers`. */
export interface AdminCustomerSummary {
  /** The customer profile id. */
  readonly id: string;
  readonly displayName: string;
  /** `+994 •• ••• •• 67`. The full number is a separate, audited reveal. */
  readonly phoneMasked: string;
  readonly status: AdminAccountStatus;
  readonly createdAt: string;
  /** Every order but drafts. */
  readonly orderCount: number;
  readonly lastOrderAt: string | null;
}

/**
 * A saved address, as the panel shows it: the customer's own label and
 * nothing else. These are home addresses, and no district is stored to show
 * in place of the street (ADR-0050 § 4). An order's address stays readable on
 * the order, where reading it is audited.
 */
export interface AdminCustomerAddress {
  /** `Ev`, `İş` — whatever the customer called it; `null` when unnamed. */
  readonly label: string | null;
  readonly isDefault: boolean;
}

/** How many of the customer's orders are in each group. */
export interface AdminCustomerOrderCounts {
  /** Searching, or held by a master. */
  readonly open: number;
  readonly completed: number;
  readonly cancelled: number;
  /** Disputed now, or a dispute that has been settled. */
  readonly disputed: number;
  /** No master took it (`NO_MASTER_FOUND`) — a supply signal, not a cancellation. */
  readonly unfilled: number;
  /**
   * Of `cancelled`, how many the customer cancelled late
   * ([ADR-0068](../../../docs/decisions/ADR-0068-cancellation-rules.md) § 3):
   * after a master had set off, and not because the master was late. For an
   * admin only; nothing happens automatically, and no master ever sees it.
   */
  readonly lateCancellations: number;
}

/** `GET /admin/customers/:id` — audited as `customer.read`. */
export interface AdminCustomerDetail extends AdminCustomerSummary {
  /** Why an admin last set the status from the panel, and when; `null` when none has. */
  readonly statusReason: string | null;
  readonly statusChangedAt: string | null;
  readonly ratingCount: number;
  readonly orderCounts: AdminCustomerOrderCounts;
  readonly addresses: readonly AdminCustomerAddress[];
  /**
   * The master profile on the same account, when there is one. Suspending
   * the account stops it too, and the panel says so before confirming.
   */
  readonly masterProfile: { readonly id: string; readonly displayName: string } | null;
}

/** `POST /admin/customers/:id/suspend` and `/reinstate` take a reason. */
export interface AdminCustomerReasonRequest {
  readonly reason: string;
}

/** The answer to a suspension: the account as it now stands, and what it did to the orders. */
export interface AdminCustomerSuspension {
  readonly customer: AdminCustomerSummary;
  /** Orders that were still searching, now cancelled. */
  readonly cancelledOrderIds: readonly string[];
  /** Orders a master already holds. Not touched; support follows them up. */
  readonly followUpOrderIds: readonly string[];
}
