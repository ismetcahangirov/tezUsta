import type {
  AdminVerificationActorKind,
  MasterDocumentStatus,
  MasterDocumentType,
  MasterVerificationStatus,
} from '@tezusta/types';

import type { MasterAction } from './api';

/** English placeholder copy for the master verification screens (#248). */
export const mastersCopy = {
  title: 'Masters',
  filterLabel: 'Filter by verification status',
  allStatuses: 'All',
  tableCaption: 'Masters',
  columns: {
    name: 'Name',
    status: 'Status',
    available: 'Available',
    ratings: 'Ratings',
    joined: 'Joined',
  },
  yes: 'Yes',
  no: 'No',
  empty: 'No masters match this filter.',
  loading: 'Loading…',
  loadFailed: 'The list could not be loaded.',
  retry: 'Try again',
  loadMore: 'Load more',
  loadingMore: 'Loading…',

  back: 'All masters',
  detailLoadFailed: 'This master could not be loaded.',
  notFound: 'There is no master with this id.',
  profile: 'Profile',
  bio: 'About',
  noBio: 'No description written.',
  joined: 'Joined',
  suspendedAt: 'Suspended',
  available: 'Available for work',
  ratings: 'Ratings received',
  services: 'Services',
  servicesCaption: 'Services this master offers',
  serviceColumns: { name: 'Service', price: 'Price', state: 'Offering' },
  noServices: 'This master has not set up any services.',
  priceAfterInspection: 'After inspection',
  serviceOffered: 'Offered',
  servicePaused: 'Paused',
  documents: 'Documents',
  documentsCaption: 'Verification documents',
  documentColumns: {
    type: 'Document',
    status: 'Status',
    size: 'Size',
    contentType: 'Detected type',
    submitted: 'Submitted',
    reviewed: 'Reviewed',
    open: 'File',
  },
  noDocuments: 'No documents submitted.',
  open: 'Open',
  opening: 'Opening…',
  openFailed: 'The document could not be opened. Try again.',
  notUploaded: 'Not uploaded',
  history: 'Verification trail',
  noHistory: 'No status changes recorded.',
  historyEntry: (from: string, to: string) => `${from} → ${to}`,
  by: (actor: string) => `by ${actor}`,
  none: '—',

  actions: 'Actions',
  actionLabel: {
    verify: 'Verify',
    reject: 'Reject',
    'request-more': 'Request more information',
    suspend: 'Suspend',
    reinstate: 'Reinstate',
  } satisfies Record<MasterAction, string>,
  confirmTitle: {
    verify: 'Verify this master?',
    reject: 'Reject this master?',
    'request-more': 'Ask this master for more?',
    suspend: 'Suspend this master?',
    reinstate: 'Reinstate this master?',
  } satisfies Record<MasterAction, string>,
  confirmBody: {
    verify: (name: string) =>
      `${name} will be able to receive and accept orders. Their pending documents are marked accepted.`,
    reject: (name: string) =>
      `${name} will not be able to take work, and cannot resubmit. Their pending documents are marked rejected.`,
    'request-more': (name: string) =>
      `${name} will be asked to change or add documents before review continues.`,
    suspend: (name: string) =>
      `${name} is signed out everywhere and cannot accept work until reinstated.`,
    reinstate: (name: string) => `${name} will be able to receive and accept orders again.`,
  } satisfies Record<MasterAction, (name: string) => string>,
  submitting: 'Saving…',
  cancel: 'Cancel',
  done: {
    verify: 'The master is verified.',
    reject: 'The master is rejected.',
    'request-more': 'The master has been asked for more.',
    suspend: 'The master is suspended.',
    reinstate: 'The master is reinstated.',
  } satisfies Record<MasterAction, string>,
  reasonLabel: 'Reason',
  reasonHint: 'The master reads this reason. Do not write internal notes here.',
  reasonEmpty: 'Write a reason.',
  reasonTooLong: 'The reason must be 600 characters or fewer.',

  errors: {
    CONFLICT:
      'This master’s status changed since the page loaded, so the action no longer applies. The page has been refreshed.',
    NOT_FOUND: 'This master no longer exists.',
    FORBIDDEN: 'Your role does not allow this action.',
    VALIDATION_FAILED: 'The server did not accept the request. Check the reason and try again.',
    unexpected: 'Something went wrong. Try again.',
  },

  status: {
    pending_verification: 'Pending verification',
    changes_requested: 'Changes requested',
    rejected: 'Rejected',
    active: 'Active',
    suspended: 'Suspended',
  } satisfies Record<MasterVerificationStatus, string>,
  documentType: {
    id_card_front: 'ID card, front',
    id_card_back: 'ID card, back',
    selfie_with_id: 'Selfie with ID',
  } satisfies Record<MasterDocumentType, string>,
  documentStatus: {
    awaiting_upload: 'Awaiting upload',
    pending_review: 'Pending review',
    accepted: 'Accepted',
    rejected: 'Rejected',
  } satisfies Record<MasterDocumentStatus, string>,
  actor: {
    master: 'the master',
    admin: 'an admin',
    system: 'the system',
  } satisfies Record<AdminVerificationActorKind, string>,
} as const;
