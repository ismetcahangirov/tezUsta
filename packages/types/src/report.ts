import type { OrderStatus } from './order.js';

/**
 * A party's report about the other party on one order (#330,
 * [ADR-0053](../../../docs/decisions/ADR-0053-party-reports.md)).
 *
 * A report is an allegation, not a verdict: nothing happens to the reported
 * party automatically, and the reported party never learns of it.
 */

/** Why the reporter is reporting. A closed list (ADR-0053 § 2). */
export type ReportReasonCode =
  | 'no_show'
  | 'rude_or_abusive'
  | 'unsafe_behaviour'
  | 'asked_off_platform_payment'
  | 'damage'
  | 'other';

/** `open` until an admin claims it, `in_review` while one handles it, then `closed`. */
export type ReportStatus = 'open' | 'in_review' | 'closed';

/**
 * How an admin closed it. The two suspensions record an action the admin took
 * on the reported party's page — closing a report suspends nobody.
 */
export type ReportOutcome =
  'no_action' | 'warning_recorded' | 'master_suspended' | 'customer_suspended';

/** Which side of the order the reporter is on. */
export type ReportPartyRole = 'customer' | 'master';

/** `POST /orders/:orderId/reports` and `PUT /orders/:orderId/reports/mine`. */
export interface SubmitReportRequest {
  readonly reasonCode: ReportReasonCode;
  /** At most 1000 characters. Never shown to the reported party. */
  readonly text?: string | null;
}

/**
 * The reporter's own report — `GET /orders/:orderId/reports/mine`. It carries
 * nothing about how an admin handled it beyond whether it is still editable.
 */
export interface OwnReport {
  readonly id: string;
  readonly orderId: string;
  readonly reasonCode: ReportReasonCode;
  readonly text: string | null;
  readonly status: ReportStatus;
  /** Until an admin claims it. */
  readonly editable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A party as the admin queue shows it. */
export interface AdminReportParty {
  readonly role: ReportPartyRole;
  /** The customer or master profile id, for a link to its page. */
  readonly profileId: string;
  readonly displayName: string;
}

/** One row of `GET /admin/reports`. */
export interface AdminReportSummary {
  readonly id: string;
  readonly orderId: string;
  readonly reasonCode: ReportReasonCode;
  readonly status: ReportStatus;
  readonly reporter: AdminReportParty;
  readonly reported: AdminReportParty;
  readonly createdAt: string;
}

/** `GET /admin/reports/:id` — audited as `report.read`. */
export interface AdminReportDetail extends AdminReportSummary {
  /** The reporter's words, as text. Never rendered as HTML. */
  readonly text: string | null;
  readonly order: {
    readonly id: string;
    readonly status: OrderStatus;
    readonly serviceName: string;
    readonly createdAt: string;
  };
  readonly handledBy: { readonly id: string; readonly displayName: string } | null;
  readonly claimedAt: string | null;
  readonly closedAt: string | null;
  readonly outcome: ReportOutcome | null;
  readonly outcomeReason: string | null;
  /** Reports about the same person in the last 30 days, this one included. */
  readonly reportsAboutReportedLast30Days: number;
}

/** `POST /admin/reports/:id/close`. */
export interface AdminReportCloseRequest {
  readonly outcome: ReportOutcome;
  readonly reason: string;
}

/** The dashboard's view of reports (#330). */
export interface AdminDashboardReports {
  readonly open: number;
  readonly inReview: number;
  /** People reported more than once in the last 30 days, most reported first. */
  readonly repeatReported: readonly {
    readonly role: ReportPartyRole;
    readonly profileId: string;
    readonly displayName: string;
    readonly count: number;
  }[];
}
