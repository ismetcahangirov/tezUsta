import type {
  ReportOutcome,
  ReportPartyRole,
  ReportReasonCode,
  ReportStatus,
} from '@tezusta/types';

/** English placeholder copy for the report queue (#330). */
export const reportsCopy = {
  title: 'Reports',
  statusFilter: 'Status',
  reasonFilter: 'Reason',
  anyStatus: 'Any status',
  anyReason: 'Any reason',
  tableCaption: 'Reports, oldest first',
  columns: {
    filed: 'Filed',
    reason: 'Reason',
    reporter: 'Reported by',
    reported: 'About',
    status: 'Status',
    open: 'Report',
  },
  view: 'Open',
  empty: 'No reports match this filter.',
  loading: 'Loading…',
  loadFailed: 'The reports could not be loaded.',
  retry: 'Try again',
  loadMore: 'Load more',
  loadingMore: 'Loading…',
  none: '—',

  back: 'All reports',
  notFound: 'There is no report with this id.',
  detailLoadFailed: 'This report could not be loaded.',
  whatTheySaid: 'What they wrote',
  noText: 'They chose a reason and wrote nothing.',
  textNote: 'Shown as written. The reported person never sees it, nor who wrote it.',
  order: 'Order',
  service: 'Service',
  ordered: 'Ordered',
  openOrder: 'Open the order',
  parties: 'Parties',
  repeat: (count: number) =>
    count <= 1
      ? 'No other report about them in the last 30 days.'
      : `${String(count)} reports about them in the last 30 days, this one included.`,
  handledBy: 'Handled by',
  claimedAt: 'Claimed',
  closedAt: 'Closed',
  outcome: 'Outcome',
  outcomeReason: 'Why',

  claim: 'Claim',
  claiming: 'Claiming…',
  close: 'Close with an outcome',
  closeTitle: 'Close this report',
  closeBody:
    'Closing records what was done. It changes nobody’s account: suspend the reported person from their own page first, then record it here.',
  outcomeLabel: 'Outcome',
  reasonLabel: 'Reason',
  reasonHint: 'Recorded in the audit log. Up to 600 characters.',
  reasonEmpty: 'Write a reason.',
  reasonTooLong: 'Keep the reason to 600 characters.',
  cancel: 'Cancel',
  submit: 'Close report',
  submitting: 'Closing…',

  errors: {
    CONFLICT: 'This report moved on since the page loaded. The page has been refreshed.',
    REPORT_OUTCOME_NOT_TAKEN:
      'That suspension is not on the reported person’s account. Suspend them from their page first.',
    FORBIDDEN: 'Your role does not allow this action.',
    NOT_FOUND: 'This report no longer exists.',
    unexpected: 'Something went wrong. Try again.',
  },

  reason: {
    no_show: 'Did not show up',
    rude_or_abusive: 'Rude or abusive',
    unsafe_behaviour: 'Unsafe behaviour',
    asked_off_platform_payment: 'Asked to pay outside the app',
    damage: 'Damage',
    other: 'Other',
  } satisfies Record<ReportReasonCode, string>,

  status: {
    open: 'Open',
    in_review: 'In review',
    closed: 'Closed',
  } satisfies Record<ReportStatus, string>,

  outcomes: {
    no_action: 'No action',
    warning_recorded: 'Warning recorded',
    master_suspended: 'Master suspended',
    customer_suspended: 'Customer suspended',
  } satisfies Record<ReportOutcome, string>,

  role: {
    customer: 'Customer',
    master: 'Master',
  } satisfies Record<ReportPartyRole, string>,
} as const;

/** The panel's sentence for an API error code. */
export function reportErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'CONFLICT':
    case 'REPORT_OUTCOME_NOT_TAKEN':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
      return reportsCopy.errors[code];
    default:
      return reportsCopy.errors.unexpected;
  }
}
