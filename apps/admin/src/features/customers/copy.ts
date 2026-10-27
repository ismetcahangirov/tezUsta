import type { AdminAccountStatus } from '@tezusta/types';

/** English placeholder copy for the customer account screens (#328). */
export const customersCopy = {
  title: 'Customers',
  searchLabel: 'Search',
  searchHint: 'A name, a customer id, or a whole phone number such as +994501234567.',
  search: 'Search',
  clear: 'Clear',
  filterLabel: 'Filter by account status',
  allStatuses: 'All',
  tableCaption: 'Customers',
  columns: {
    name: 'Name',
    phone: 'Phone',
    status: 'Account',
    orders: 'Orders',
    lastOrder: 'Last order',
    joined: 'Joined',
  },
  empty: 'No customers match this search.',
  loading: 'Loading…',
  loadFailed: 'The list could not be loaded.',
  retry: 'Try again',
  loadMore: 'Load more',
  loadingMore: 'Loading…',
  none: '—',

  back: 'All customers',
  detailLoadFailed: 'This customer could not be loaded.',
  notFound: 'There is no customer with this id.',
  profile: 'Profile',
  joined: 'Joined',
  phone: 'Phone',
  ratings: 'Ratings received',
  statusSince: 'Since',
  statusReason: 'Reason',
  masterProfile: 'Master profile on the same account',
  noMasterProfile: 'None',
  orderCounts: 'Orders',
  counts: {
    open: 'Open',
    completed: 'Completed',
    cancelled: 'Cancelled',
    disputed: 'Disputed',
    unfilled: 'No master found',
    lateCancellations: 'Late cancellations',
  },
  lateCancellationsNote:
    'A late cancellation is one made after the free window (ADR-0068). It is counted for admins only; nothing happens automatically.',
  addresses: 'Saved addresses',
  addressesNote: 'Labels only. An order’s address is shown on the order itself.',
  noAddresses: 'No saved addresses.',
  unnamedAddress: 'Unnamed address',
  defaultAddress: 'default',
  orders: 'Order history',
  ordersCaption: 'This customer’s orders',
  noOrders: 'This customer has no orders.',

  actions: 'Actions',
  suspend: 'Suspend account',
  reinstate: 'Reinstate account',
  revealNumber: 'Reveal number',

  confirmTitle: { suspend: 'Suspend this account?', reinstate: 'Reinstate this account?' },
  confirmBody: {
    suspend: (name: string) =>
      `${name} will be signed out on every device and cannot sign in. Orders still searching for a master are cancelled. Orders a master already holds are not touched.`,
    reinstate: (name: string) =>
      `${name} will be able to sign in again. Orders cancelled by the suspension stay cancelled.`,
  },
  alsoMasterWarning: (masterName: string) =>
    `This account also holds the master profile “${masterName}”. A suspension belongs to the account, so it stops their work as a master too.`,
  reasonLabel: 'Reason',
  reasonHint: 'Recorded in the audit log. Up to 600 characters.',
  reasonEmpty: 'Write a reason.',
  reasonTooLong: 'Keep the reason to 600 characters.',
  cancel: 'Cancel',
  confirm: { suspend: 'Suspend', reinstate: 'Reinstate' },
  submitting: 'Saving…',
  suspended: (cancelled: number) =>
    cancelled === 0
      ? 'The account is suspended. No order was searching.'
      : `The account is suspended. ${String(cancelled)} searching ${cancelled === 1 ? 'order was' : 'orders were'} cancelled.`,
  followUp: 'Orders a master already holds — follow these up:',
  reinstated: 'The account is active again.',

  revealTitle: (name: string) => `Reveal ${name}’s number`,
  revealBody: 'The number is shown once, and the reveal is recorded with your reason.',
  revealReasonHint: 'Why you need the number. Recorded in the audit log.',
  reveal: 'Reveal',
  revealing: 'Revealing…',
  revealedLabel: 'Phone number',
  close: 'Close',

  errors: {
    CONFLICT:
      'This account’s status changed since the page loaded, so the action no longer applies. The page has been refreshed.',
    NOT_FOUND: 'This customer no longer exists.',
    FORBIDDEN: 'Your role does not allow this action.',
    VALIDATION_FAILED: 'The server did not accept the request. Check the reason and try again.',
    unexpected: 'Something went wrong. Try again.',
  },

  status: {
    active: 'Active',
    suspended: 'Suspended',
    deleted: 'Deleted',
  } satisfies Record<AdminAccountStatus, string>,
} as const;

/** The panel's sentence for an API error code. */
export function customerErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'CONFLICT':
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'VALIDATION_FAILED':
      return customersCopy.errors[code];
    default:
      return customersCopy.errors.unexpected;
  }
}
